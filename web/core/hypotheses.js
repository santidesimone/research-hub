// A hypothesis's status is derived from the papers that tested it: the `result` on each (:Paper)-[:TESTS]->(:Hypothesis).
// One paper supporting it and another refuting it gives "mixed" (docs/ADDENDUM_frameworks_questions_ontologies.md).
// The owner may set the status by hand; that override stands until the owner clears it, and recomputing never touches it.
// recompute() runs whenever a TESTS link is made, changed or removed, and when a paper that tested something is deleted.
const db = require('./db');
const hooks = require('./hooks');

const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

// results of all TESTS links -> status
function deriveStatus(results) {
  const all = (results || []).filter(Boolean);
  if (!all.length) return 'untested';
  const decisive = new Set(all.filter((r) => r !== 'inconclusive'));
  if (!decisive.size) return 'inconclusive';
  if (decisive.has('mixed') || (decisive.has('supported') && decisive.has('refuted'))) return 'mixed';
  return decisive.has('supported') ? 'supported' : 'refuted';
}

// An owner's status stands while it holds a value; clearing it hands the field back to the derivation.
const overridden = (prov, status) => Boolean(prov.status && prov.status.by === 'owner' && status != null && status !== '');

// -> [{ key, status, changed }]
async function recompute(keys) {
  const out = [];
  for (const key of [...new Set(keys || [])]) {
    const [row] = await db.run(
      `MATCH (h:Hypothesis {key:$key}) OPTIONAL MATCH (:Paper)-[t:TESTS]->(h)
       RETURN h.status AS status, h.provenance_json AS p, collect(t.result) AS results`, { key });
    if (!row) continue;
    const prov = parse(row.p);
    if (overridden(prov, row.status)) { out.push({ key, status: row.status, changed: false, overridden: true }); continue; }
    const status = deriveStatus(row.results);
    const changed = status !== row.status || !prov.status || prov.status.by !== 'derived';
    if (changed) {
      prov.status = { by: 'derived', at: new Date().toISOString(), status: 'auto' };
      await db.writeTx((tx) => tx.run('MATCH (h:Hypothesis {key:$key}) SET h.status = $status, h.provenance_json = $prov, h.updated_at = datetime()',
        { key, status, prov: JSON.stringify(prov) }));
      await hooks.emit('afterWrite', { key, type: 'hypothesis', input: {}, created: false });
    }
    out.push({ key, status, changed });
  }
  return out;
}

// The hypotheses a paper tested (read before the paper is deleted, recomputed after).
async function testedBy(paperKey) {
  return (await db.run('MATCH (:Artifact {key:$key})-[:TESTS]->(h:Hypothesis) RETURN h.key AS key', { key: paperKey })).map((r) => r.key);
}

// Deleting a paper removes its TESTS links: remember what it tested, recompute once it is gone. Registered once.
const pending = new Map();
if (!global.__hubHypothesisHooks) {
  global.__hubHypothesisHooks = true;
  hooks.on('beforeRemove', async ({ key }) => { const hs = await testedBy(key); if (hs.length) pending.set(key, hs); });
  hooks.on('afterRemove', async ({ key }) => { const hs = pending.get(key); pending.delete(key); if (hs) await recompute(hs); });
}

module.exports = { deriveStatus, recompute, testedBy, overridden };
