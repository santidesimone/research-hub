// Object fields (actors, outcomes, sources, key_findings ...) are stored as JSON text in `<field>_json` (Task 3). The
// first schema-v3 writer kept them in the field itself (a JSON string, or a list of JSON strings). Copy each such value
// to `<field>_json` first, then remove the old property. Idempotent: only nodes without `<field>_json` are touched.
const { schema, fieldsOf, safeLabel } = require('../core/schema');

const parse = (s) => { try { return JSON.parse(s); } catch { return s; } }; // not JSON: keep the text as it was

function toJson(value, list) {
  if (Array.isArray(value)) return JSON.stringify(value.map((x) => (typeof x === 'string' ? parse(x) : x)));
  const v = typeof value === 'string' ? parse(value) : value;
  return JSON.stringify(list && !Array.isArray(v) ? [v] : v);
}

module.exports = {
  id: '007_items_json_fields',
  description: 'object fields move to <field>_json (copy, then remove the old property)',
  toJson,
  async up(db) {
    for (const [name, t] of Object.entries(schema.types)) {
      if (!t.collection) continue;
      const L = safeLabel(t.label);
      for (const [f, spec] of Object.entries(fieldsOf(name))) {
        if (spec.type !== 'object' || (spec.by.length === 1 && spec.by[0] === 'Sys')) continue;
        const rows = await db.run(`MATCH (n:${L}) WHERE n.\`${f}\` IS NOT NULL AND n.\`${f}_json\` IS NULL RETURN n.key AS key, n.\`${f}\` AS value`);
        if (!rows.length) continue;
        const out = rows.map((r) => ({ key: r.key, json: toJson(r.value, spec.list) }));
        await db.run(`UNWIND $rows AS r MATCH (n:${L} {key: r.key}) SET n.\`${f}_json\` = r.json REMOVE n.\`${f}\``, { rows: out });
      }
    }
  },
};
