// /api/items: the collections (paper, method, use_case, case_study), driven by schema/schema.json. Owner only.
// Keys contain ':' and, for DOIs, '/': send them URL-encoded (encodeURIComponent).
const express = require('express');
const { requireOwner } = require('../../core/auth');
const items = require('../../core/items');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const json = express.json({ limit: '2mb' });
const LINKS = /^\/api\/items\/(.+)\/links$/;
const ITEM = /^\/api\/items\/(.+)$/;

module.exports = {
  name: 'items',
  mount(app) {
    app.get('/api/items', requireOwner, wrap(async (req, res) => res.json(await items.list(req.query))));
    app.post('/api/items', requireOwner, json, wrap(async (req, res) => res.status(201).json(await items.create(req.body || {}))));

    app.put(LINKS, requireOwner, json, wrap(async (req, res) => res.json(await items.link(req.params[0], req.body || {}))));
    app.delete(LINKS, requireOwner, wrap(async (req, res) => res.json(await items.unlink(req.params[0], req.query))));

    app.get(ITEM, requireOwner, wrap(async (req, res) => res.json(await items.get(req.params[0]))));
    app.patch(ITEM, requireOwner, json, wrap(async (req, res) => res.json(await items.update(req.params[0], (req.body || {}).fields))));
    app.delete(ITEM, requireOwner, wrap(async (req, res) => res.json(await items.remove(req.params[0]))));
  },
};
