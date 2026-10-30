// The personal layer: your own workflow state about artifacts (today: a status such as to-read / reading / read).
//
// It is deliberately NOT part of the core model:
//   * it lives on separate (:Personal) nodes linked (:Personal)-[:FOR]->(:Artifact), never on the artifact itself;
//   * the public export and the graph view only read Artifact/Person/Concept, so this data cannot reach them;
//   * the core does not import this folder. Delete features/personal/ and the hub works exactly as before
//     (the :Personal nodes simply stay unused in the database).
//
// To track more things (rating, private comment), add the field name to FIELDS.
const express = require('express');
const { run, writeTx } = require('../../core/db');
const { HttpError } = require('../../core/errors');
const { requireOwner } = require('../../core/auth');
const hooks = require('../../core/hooks');

const FIELDS = ['status'];
const DEFAULT_STATUS = 'to-read'; // policy of this layer: new papers start in your reading inbox
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function clean(field, value) {
  if (value === null || value === '') return null; // null removes the field
  const s = String(value).trim();
  if (s.length > 40) throw new HttpError(400, `${field} is too long (max 40 characters)`);
  return s;
}

// Merge fields into an artifact's personal state. A null value removes that field.
async function setState(key, fields) {
  const props = {};
  for (const f of FIELDS) if (f in fields) props[f] = clean(f, fields[f]);
  const out = await writeTx(async (tx) => {
    const found = await tx.run('MATCH (a:Artifact {key:$key}) RETURN a.key', { key });
    if (!found.records.length) throw new HttpError(404, 'No such artifact');
    await tx.run(
      `MATCH (a:Artifact {key:$key})
       MERGE (s:Personal {key:'personal:' + $key})
       SET s += $props, s.updated_at = datetime()
       MERGE (s)-[:FOR]->(a)`,
      { key, props }
    );
    return true;
  });
  return out;
}

// Status given alongside a write: {status: 'x'} or a 'status:x' tag (the format the paper API and CSL files already use).
function statusFromInput(input) {
  if (input && typeof input.status === 'string' && input.status.trim()) return input.status.trim();
  for (const t of (input && input.tags) || []) {
    const s = typeof t === 'string' ? t : t && t.tag;
    if (s && /^status:/i.test(s.trim())) return s.trim().slice(7).trim();
  }
  return null;
}

module.exports = {
  name: 'personal',
  setState,
  mount(app) {
    // New or re-posted artifacts: record the status if one was sent; give brand-new papers the default.
    hooks.on('afterWrite', async ({ key, type, input, created }) => {
      const given = statusFromInput(input);
      if (given) await setState(key, { status: given });
      else if (created && type === 'paper') await setState(key, { status: DEFAULT_STATUS });
    });
    hooks.on('afterRemove', async ({ key }) => {
      await writeTx((tx) => tx.run('MATCH (s:Personal {key:$k}) DETACH DELETE s', { k: 'personal:' + key }));
    });

    app.get('/api/personal', requireOwner, wrap(async (_req, res) => {
      const rows = await run(`MATCH (s:Personal)-[:FOR]->(a:Artifact) RETURN a.key AS key, properties(s) AS props`);
      const items = {};
      for (const r of rows) { delete r.props.key; items[r.key] = r.props; }
      res.json({ fields: FIELDS, items });
    }));

    app.put('/api/personal', requireOwner, express.json({ limit: '10kb' }), wrap(async (req, res) => {
      const key = String(req.query.key || '');
      if (!key) throw new HttpError(400, 'Pass the artifact key as ?key=');
      await setState(key, req.body || {});
      res.json({ key, ok: true });
    }));

    app.delete('/api/personal', requireOwner, wrap(async (req, res) => {
      const key = String(req.query.key || '');
      await writeTx((tx) => tx.run('MATCH (s:Personal {key:$k}) DETACH DELETE s', { k: 'personal:' + key }));
      res.json({ key, cleared: true });
    }));
  },
};
