// Single-object fields (evidence, period, threats_to_validity ...) also keep each declared part as a plain property
// `<field>__<part>`, so Cypher can query them without parsing JSON (design competency question 1: p.evidence__n > 100).
// Backfills those properties from `<field>_json` for items written before. Idempotent: it recomputes them.
const { schema, fieldsOf, safeLabel } = require('../core/schema');
const { partValues, kindOf } = require('../core/items');

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

module.exports = {
  id: '009_object_parts',
  description: 'single-object fields: queryable <field>__<part> properties from <field>_json',
  async up(db) {
    for (const [name, t] of Object.entries(schema.types)) {
      if (!t.collection) continue;
      const L = safeLabel(t.label);
      for (const [f, spec] of Object.entries(fieldsOf(name))) {
        if (kindOf(spec) !== 'json' || spec.list || (spec.by.length === 1 && spec.by[0] === 'Sys')) continue;
        const rows = await db.run(`MATCH (n:${L}) WHERE n.\`${f}_json\` IS NOT NULL RETURN n.key AS key, n.\`${f}_json\` AS json`);
        if (!rows.length) continue;
        const out = rows.map((r) => ({ key: r.key, props: partValues(f, spec, parse(r.json)) }));
        await db.run(`UNWIND $rows AS r MATCH (n:${L} {key: r.key}) SET n += r.props`, { rows: out });
      }
    }
  },
};
