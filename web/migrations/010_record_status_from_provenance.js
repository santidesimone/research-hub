// record_status says whether an item still holds values Claude wrote that nobody has accepted. Migration 005 set 'auto'
// on every existing item, which marked the owner's own data as unreviewed. Recompute it from provenance_json:
// 'auto' while a Claude value is still auto, otherwise 'reviewed' (owner and source values need no review). Idempotent.
const { schema, safeLabel } = require('../core/schema');
const { needsReview } = require('../core/items');

const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

module.exports = {
  id: '010_record_status_from_provenance',
  description: 'record_status from provenance: auto only while Claude values are unreviewed',
  async up(db) {
    for (const t of Object.values(schema.types)) {
      if (!t.collection) continue;
      const L = safeLabel(t.label);
      const rows = await db.run(`MATCH (n:${L}) RETURN n.key AS key, n.provenance_json AS p, n.record_status AS rs`);
      const out = rows.map((r) => ({ key: r.key, rs: needsReview(parse(r.p)) ? 'auto' : 'reviewed' })).filter((r, i) => r.rs !== rows[i].rs);
      if (out.length) await db.run(`UNWIND $rows AS r MATCH (n:${L} {key: r.key}) SET n.record_status = r.rs`, { rows: out });
    }
  },
};
