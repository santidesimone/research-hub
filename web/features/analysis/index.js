// Claude's analysis (one call, saved directly) and the audit that lets the owner review it later. Owner only.
const express = require('express');
const { requireOwner } = require('../../core/auth');
const analysis = require('../../core/analysis');
const audit = require('../../core/audit');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const json = express.json({ limit: '2mb' });

module.exports = {
  name: 'analysis',
  mount(app) {
    app.post('/api/analysis', requireOwner, json, wrap(async (req, res) => {
      const out = await analysis.save(req.body || {});
      res.status(out.created ? 201 : 200).json(out);
    }));
    app.get('/api/audit', requireOwner, wrap(async (req, res) => res.json(await audit.report({ limit: req.query.limit }))));
    app.post('/api/audit/accept', requireOwner, json, wrap(async (req, res) => res.json(await audit.accept(req.body || {}))));
  },
};
