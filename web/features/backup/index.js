// GET /api/backup downloads everything as one JSON file; POST /api/restore merges a backup back in (never deletes).
const express = require('express');
const { requireOwner } = require('../../core/auth');
const backup = require('../../core/backup');
const publicExport = require('../../core/public-export');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  name: 'backup',
  mount(app) {
    app.get('/api/backup', requireOwner, wrap(async (_req, res) => {
      const stamp = new Date().toISOString().slice(0, 10);
      res.set('Content-Disposition', `attachment; filename="research-hub-backup-${stamp}.json"`).json(await backup.exportAll());
    }));

    app.post('/api/restore', requireOwner, express.json({ limit: '30mb' }), wrap(async (req, res) => {
      const out = await backup.restore(req.body);
      publicExport.invalidate(); // the restored data may change the public preview
      res.json(out);
    }));
  },
};
