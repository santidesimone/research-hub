// Read-only Cypher over HTTP (owner only), plus a description of the graph for people and models.
const express = require('express');
const { requireOwner } = require('../../core/auth');
const query = require('../../core/query');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  name: 'query',
  mount(app) {
    app.post('/api/query', requireOwner, express.json({ limit: '50kb' }), wrap(async (req, res) => {
      res.json(await query.readOnly(req.body && req.body.cypher, (req.body && req.body.params) || {}));
    }));
    app.get('/api/query/schema', requireOwner, wrap(async (_req, res) => res.json(await query.overview())));
  },
};
