// PUT /api/notes/sync: the target of `hub sync-notes`. All the logic is in core/notes.js.
const express = require('express');
const { HttpError } = require('../../core/errors');
const { requireOwner } = require('../../core/auth');
const notes = require('../../core/notes');

module.exports = {
  name: 'notes',
  mount(app) {
    app.put('/api/notes/sync', requireOwner, express.json({ limit: '25mb' }), (req, res, next) => {
      const items = req.body && req.body.items;
      if (!Array.isArray(items)) return next(new HttpError(400, 'Send {"items": [{"path": "notes/x.md", "meta": {...}, "body": "..."}]}'));
      notes.sync(items, { prune: req.query.prune !== 'false', allowEmpty: req.query.allow_empty === 'true', dryRun: req.query.dry_run === 'true' })
        .then((r) => res.json(r)).catch(next);
    });
  },
};
