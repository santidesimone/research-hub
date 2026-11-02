// Publishing: the owner's settings for what visitors see (core/publishing.js), and the full public view of one item.
//   GET  /api/settings/publishing          owner: the current settings
//   PUT  /api/settings/publishing          owner: change default_visibility and/or public_detail
//   POST /api/settings/publishing/apply    owner: give every item the same visibility ({visibility})
//   GET  /api/public/items/<key>           anyone, only while public_detail is 'full': a public item with all its fields
// With PUBLIC_ACCESS off (the default) nothing is public: the public item needs the token and the settings cannot be changed.
// Keys contain ':' and, for DOIs, '/': send them URL-encoded (encodeURIComponent).
const express = require('express');
const { requireOwner } = require('../../core/auth');
const config = require('../../core/config');
const { HttpError } = require('../../core/errors');
const publishing = require('../../core/publishing');
const publicExport = require('../../core/public-export');
const items = require('../../core/items');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const json = express.json({ limit: '16kb' });
const PUBLIC_ITEM = /^\/api\/public\/items\/(.+)$/;
const publicOnly = (req, res, next) => (config.get().publicAccess ? next() : requireOwner(req, res, next));
const changeable = (_req, _res, next) => next(config.get().publicAccess ? undefined
  : new HttpError(409, 'Public access is off on this server (PUBLIC_ACCESS): everything is behind the token, so publishing settings cannot be changed.'));

// A field value as visitors may see it: links to items that are not public, and links into the owner's Drive, are left out.
function scrub(v, publicKeys) {
  if (Array.isArray(v)) return v.map((x) => scrub(x, publicKeys)).filter((x) => x !== undefined);
  if (publishing.isDriveLink(v)) return undefined;
  if (v && typeof v === 'object') {
    if ('key' in v && 'name' in v && v.key != null && !publicKeys.has(v.key)) return undefined; // a ref to something private
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, publicKeys)]).filter(([, x]) => x !== undefined));
  }
  return v;
}

// The owner's item (core/items.js toItem) cut down for visitors. Relations come from the public export's edges instead.
function publicItem(item, publicKeys) {
  const fields = Object.fromEntries(Object.entries(item.fields).map(([f, v]) => [f, scrub(v, publicKeys) ?? null]));
  const file = item.meta.file_url && !publishing.isDriveLink(item.meta.file_url) ? { file_url: item.meta.file_url } : {};
  return {
    key: item.key, collection: item.collection, record_status: item.record_status, created_at: item.created_at, updated_at: item.updated_at,
    fields, provenance: item.provenance, meta: file, extra: scrub(publishing.fullProps(item.extra), publicKeys), links: { out: [], in: [] },
  };
}

module.exports = {
  name: 'publishing',
  publicItem,
  mount(app) {
    app.get('/api/settings/publishing', requireOwner, wrap(async (_req, res) => res.json({ ...(await publishing.get()), public_access: config.get().publicAccess })));

    app.put('/api/settings/publishing', requireOwner, changeable, json, wrap(async (req, res) => {
      const out = await publishing.set(req.body || {});
      publicExport.invalidate();
      res.json(out);
    }));

    app.post('/api/settings/publishing/apply', requireOwner, changeable, json, wrap(async (req, res) => {
      const out = await publishing.applyToAll((req.body || {}).visibility);
      publicExport.invalidate();
      res.json(out);
    }));

    app.get(PUBLIC_ITEM, publicOnly, wrap(async (req, res) => {
      const key = req.params[0];
      const exp = await publicExport.read();
      const { detail, nodes } = JSON.parse(exp.text);
      const publicKeys = new Set(nodes.map((n) => n.key));
      if (detail !== 'full' || !publicKeys.has(key)) throw new HttpError(404, 'No such public item');
      res.set('Cache-Control', 'no-cache');
      res.json(publicItem(await items.get(key), publicKeys));
    }));
  },
};
