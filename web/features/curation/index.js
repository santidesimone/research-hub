// Curation (Task 10, core/curation.js): reviewable change plans, owner only. Claude proposes through MCP; the owner
// reviews, applies, rejects or reverts here (the Library's Curation section uses these routes).
//   POST /api/curation/plans                {ops, reason}: propose (nothing changes yet)
//   GET  /api/curation/plans[?status=]      the curation log
//   GET  /api/curation/plans/<id>
//   POST /api/curation/plans/<id>/apply | /reject | /revert
const express = require('express');
const { requireOwner } = require('../../core/auth');
const curation = require('../../core/curation');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const json = express.json({ limit: '256kb' });

module.exports = {
  name: 'curation',
  mount(app) {
    app.post('/api/curation/plans', requireOwner, json, wrap(async (req, res) => {
      const { ops, reason } = req.body || {};
      res.status(201).json(await curation.propose(ops, { reason, by: 'owner' }));
    }));
    app.get('/api/curation/plans', requireOwner, wrap(async (req, res) => res.json(await curation.list(req.query))));
    app.get('/api/curation/plans/:id', requireOwner, wrap(async (req, res) => res.json(await curation.get(req.params.id))));
    app.post('/api/curation/plans/:id/apply', requireOwner, wrap(async (req, res) => res.json(await curation.apply(req.params.id))));
    app.post('/api/curation/plans/:id/reject', requireOwner, wrap(async (req, res) => res.json(await curation.reject(req.params.id))));
    app.post('/api/curation/plans/:id/revert', requireOwner, wrap(async (req, res) => res.json(await curation.revert(req.params.id))));
  },
};
