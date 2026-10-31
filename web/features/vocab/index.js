// Vocabulary look-up for type-ahead pickers in the Library: GET /api/vocab?kind=Topic&q=zero. Owner only, read only.
// Names are compared in the matcher's normalised form, so "Zero-Knowledge" finds "zero knowledge proof".
const { requireOwner } = require('../../core/auth');
const { run } = require('../../core/db');
const { schema, safeLabel } = require('../../core/schema');
const vocab = require('../../core/vocab');
const { HttpError } = require('../../core/errors');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  name: 'vocab',
  mount(app) {
    app.get('/api/vocab', requireOwner, wrap(async (req, res) => {
      const label = vocab.labelOf(req.query.kind);
      if (String(req.query.q || '').length > 200) throw new HttpError(400, 'q is limited to 200 characters');
      const q = vocab.analyse(schema.entities[label].match, String(req.query.q || '')).norm;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 50);
      const rows = await run(
        `MATCH (n:${safeLabel(label)})
         WHERE $q = '' OR n.norm STARTS WITH $q OR n.norm CONTAINS $q OR any(a IN coalesce(n.aliases_norm, []) WHERE a STARTS WITH $q)
         RETURN n.key AS key, n.name AS name, coalesce(n.aliases, []) AS aliases, size([(n)--() | 1]) AS uses
         ORDER BY CASE WHEN n.norm STARTS WITH $q THEN 0 ELSE 1 END, uses DESC, n.name LIMIT ${limit}`, { q });
      res.json({ kind: label, items: rows });
    }));
  },
};
