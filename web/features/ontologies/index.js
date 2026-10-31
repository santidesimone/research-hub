// Ontology snapshots (D11, D13): an optional frozen copy of an ontology or standard in the owner's Drive, made only on
// request. The record keeps file_url, drive_file_id, retrieved_at, version, sha256, size_bytes and mime in its
// `snapshot` field; a new snapshot trashes the previous one, and deleting the ontology trashes its snapshot.
// The file is shared by link like every hub upload, so check the resource's license first (the UI asks).
//   POST   /api/ontologies/snapshot?key=ontology:x&name=file.ttl   the file as the body, or JSON {"url": "https://..."}
//   DELETE /api/ontologies/snapshot?key=ontology:x
const crypto = require('crypto');
const express = require('express');
const { requireOwner } = require('../../core/auth');
const { HttpError } = require('../../core/errors');
const drive = require('../../core/drive');
const items = require('../../core/items');
const hooks = require('../../core/hooks');
const config = require('../../core/config');
const files = require('../papers/files');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const extOf = (name) => (String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];

async function ontology(key) {
  const it = await items.get(String(key || ''));
  if (it.collection !== 'ontology') throw new HttpError(400, `${it.key} is a ${it.collection}, not an ontology`);
  return it;
}

// buf: the file; name: its file name (the extension picks the type).
async function snapshot(key, buf, name) {
  drive.requireConfigured();
  const it = await ontology(key);
  const ext = extOf(name);
  if (!ext || !drive.FILE_TYPES[ext]) throw new HttpError(400, `Name the file with one of these extensions: ${Object.keys(drive.FILE_TYPES).join(', ')}`);
  if (ext === 'pdf' && (!Buffer.isBuffer(buf) || buf.subarray(0, 5).toString() !== '%PDF-')) throw new HttpError(400, 'File is not a PDF');
  const sha256 = crypto.createHash('sha256').update(buf || '').digest('hex');
  const version = it.fields.version || null;
  const up = await drive.upload(`${it.fields.title}${version ? ' ' + version : ''}`, buf, { ext });
  const snap = { file_url: up.url, drive_file_id: up.id, retrieved_at: new Date().toISOString(), ...(version ? { version } : {}), sha256, size_bytes: buf.length, mime: up.mime };
  try { await items.write(it.key, { snapshot: snap }, { by: 'owner' }); }
  catch (e) { await files.trashQuietly(up.id); throw e; } // never leave a public file the graph does not know about
  const out = { key: it.key, snapshot: snap };
  const prev = it.fields.snapshot && it.fields.snapshot.drive_file_id;
  if (prev && prev !== up.id) {
    const warning = await files.trashQuietly(prev);
    if (warning) out.drive_warning = warning; else out.replaced_drive_file = prev;
  }
  return out;
}

async function removeSnapshot(key) {
  const it = await ontology(key);
  const prev = it.fields.snapshot && it.fields.snapshot.drive_file_id;
  if (!it.fields.snapshot) throw new HttpError(404, 'This ontology has no snapshot');
  await items.write(it.key, { snapshot: null }, { by: 'owner' });
  const out = { key: it.key, removed: true };
  if (prev) { const warning = await files.trashQuietly(prev); if (warning) out.drive_warning = warning; else out.trashed_drive_file = prev; }
  return out;
}

module.exports = {
  name: 'ontologies',
  snapshot,
  removeSnapshot,
  mount(app) {
    // deleting an ontology trashes the snapshot the hub uploaded for it
    const pending = new Map();
    hooks.on('beforeRemove', async ({ key }) => {
      if (!String(key).startsWith('ontology:')) return;
      const it = await items.get(key).catch(() => null);
      const id = it && it.fields.snapshot && it.fields.snapshot.drive_file_id;
      if (id) pending.set(key, id);
    });
    hooks.on('afterRemove', async ({ key }) => {
      const id = pending.get(key); pending.delete(key);
      if (id) { const warning = await files.trashQuietly(id); if (warning) throw new Error(warning); }
    });

    app.post('/api/ontologies/snapshot', requireOwner,
      express.raw({ type: (req) => !/json/i.test(req.headers['content-type'] || ''), limit: files.maxBytes() }),
      express.json({ limit: '10kb' }),
      wrap(async (req, res) => {
        let buf = Buffer.isBuffer(req.body) && req.body.length ? req.body : null;
        let name = req.query.name;
        if (!buf && req.body && req.body.url) {
          const hosts = [...config.get().pdfFetchAllowedHosts, ...config.get().snapshotFetchAllowedHosts];
          buf = await files.fetchAllowed(String(req.body.url), { hosts, what: 'file', field: 'url', setting: 'SNAPSHOT_FETCH_ALLOWED_HOSTS' });
          name = name || new URL(String(req.body.url)).pathname.split('/').pop();
        }
        if (!buf) throw new HttpError(400, 'Send the file as the request body (with ?name=file.ttl) or JSON {"url": "https://..."}');
        res.status(201).json(await snapshot(req.query.key, buf, name));
      }));
    app.delete('/api/ontologies/snapshot', requireOwner, wrap(async (req, res) => res.json(await removeSnapshot(req.query.key))));
  },
};
