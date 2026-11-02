// Everything specific to papers: list, add, delete, the file link (set, remove, upload to Drive), CSL export/import.
const express = require('express');
const { run } = require('../../core/db');
const { HttpError } = require('../../core/errors');
const { requireOwner } = require('../../core/auth');
const artifacts = require('../../core/artifacts');
const hooks = require('../../core/hooks');
const { toCsl, fromCsl } = require('./csl');
const files = require('./files');

const ROWS = `MATCH (p:Paper)
  RETURN p.key AS key, properties(p) AS props, p.file_url IS NOT NULL AS has_file,
         [(p)-[:ABOUT]->(c:Topic|Concept) | c.name] AS topics // Topic; Concept from older imports
  ORDER BY coalesce(p.year, 0) DESC, p.title`;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const keyOf = (req) => { const k = String(req.query.key || ''); if (!k) throw new HttpError(400, 'Pass the paper key as ?key='); return k; };

module.exports = {
  name: 'papers',
  mount(app) {
    // Deleting a paper also trashes the Drive file the hub uploaded for it (never one it did not upload).
    const pending = new Map();
    hooks.on('beforeRemove', async ({ key }) => {
      const [row] = await run('MATCH (p:Paper {key:$key}) RETURN p.drive_file_id AS id', { key });
      if (row && row.id) pending.set(key, row.id);
    });
    hooks.on('afterRemove', async ({ key }) => {
      const id = pending.get(key);
      pending.delete(key);
      if (id) { const warning = await files.trashQuietly(id); if (warning) throw new Error(warning); }
    });

    app.get('/api/papers', requireOwner, wrap(async (_req, res) => {
      const rows = await run(ROWS);
      for (const r of rows) delete r.props.abstract; // the list does not need it; the detail view loads it
      res.json({ papers: rows });
    }));

    app.post('/api/papers', requireOwner, express.json({ limit: '1mb' }), wrap(async (req, res) => {
      let result;
      try { result = await artifacts.add('paper', req.body, { overwrite: req.query.overwrite === 'true' }); }
      catch (e) { if (e.status === 409 && e.extra) e.extra.paper_key = e.extra.key; throw e; }
      const { key, created, ...rest } = result;
      res.status(201).json({ paper_key: key, created, ...rest });
    }));

    app.delete('/api/papers', requireOwner, wrap(async (req, res) => {
      const key = keyOf(req);
      await files.paperRow(key);
      res.json(await artifacts.remove(key));
    }));

    // The file: a link, or a PDF the hub uploads to Drive.
    app.put('/api/papers/file', requireOwner, express.json({ limit: '10kb' }), wrap(async (req, res) => {
      const key = keyOf(req);
      res.json({ paper_key: key, ...(await files.setLink(key, req.body && (req.body.file_url || req.body.url))) });
    }));

    app.delete('/api/papers/file', requireOwner, wrap(async (req, res) => {
      const key = keyOf(req);
      res.json({ paper_key: key, ...(await files.removeLink(key)) });
    }));

    app.post('/api/papers/file', requireOwner,
      express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: files.maxBytes() }),
      express.json({ limit: '10kb' }),
      wrap(async (req, res) => {
        const key = keyOf(req);
        const buf = Buffer.isBuffer(req.body) && req.body.length ? req.body
          : req.body && req.body.pdf_url ? await files.fetchPdf(req.body.pdf_url) : null;
        if (!buf) throw new HttpError(400, 'Send the PDF as the request body (Content-Type: application/pdf) or JSON {"pdf_url": "https://..."}');
        res.status(201).json({ paper_key: key, ...(await files.uploadPdf(key, buf)) });
      }));

    app.get('/api/export', requireOwner, wrap(async (_req, res) => {
      const rows = await run(ROWS);
      res.set('Content-Disposition', 'attachment; filename="research-hub-library.json"').json(rows.map(toCsl));
    }));

    app.post('/api/import', requireOwner, express.json({ limit: '20mb' }), wrap(async (req, res) => {
      const list = Array.isArray(req.body) ? req.body : req.body && req.body.items;
      if (!Array.isArray(list)) throw new HttpError(400, 'Send a CSL JSON array (or {"items": [...]}).');
      const result = { created: 0, skipped: 0, failed: [] };
      for (const entry of list) {
        try { await artifacts.add('paper', fromCsl(entry)); result.created++; }
        catch (e) { if (e.status === 409) result.skipped++; else result.failed.push({ title: entry.title, error: e.message }); }
      }
      res.status(201).json(result);
    }));
  },
};
