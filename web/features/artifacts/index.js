// Generic, schema-driven API: works for every type in schema/schema.json (method, note, project, ...).
const express = require('express');
const { HttpError } = require('../../core/errors');
const { requireOwner } = require('../../core/auth');
const artifacts = require('../../core/artifacts');
const types = require('../../core/types');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  name: 'artifacts',
  mount(app) {
    app.get('/api/artifacts', requireOwner, wrap(async (req, res) => {
      const type = String(req.query.type || '');
      types.get(type);
      const rows = await artifacts.list(type);
      res.json({ type, items: rows });
    }));

    app.post('/api/artifacts/:type', requireOwner, express.json({ limit: '2mb' }), wrap(async (req, res) => {
      types.get(req.params.type);
      res.status(201).json(await artifacts.add(req.params.type, req.body, { overwrite: req.query.overwrite === 'true' }));
    }));

    app.delete('/api/artifacts', requireOwner, wrap(async (req, res) => {
      const key = String(req.query.key || '');
      if (!key) throw new HttpError(400, 'Pass ?key=');
      res.json(await artifacts.remove(key));
    }));
  },
};
