// Backup and restore of everything the hub owns in Neo4j: artifacts, people, concepts and your personal layer.
// With files kept as links, Neo4j is the only copy of your library, so this is the safety net (alongside disk snapshots).
//   export()   -> { format, version, exported_at, nodes: [{labels, props}], rels: [{from, to, type, props}] }
//   restore()  -> merges a backup into the graph by key. It never deletes anything, so it is safe to run twice.
const { run, writeTx } = require('./db');
const { schema, safeLabel } = require('./schema');
const { HttpError } = require('./errors');

const FORMAT = 'research-hub-backup';
const VERSION = 1;
const BATCH = 500;
const BASE_LABELS = ['Artifact', 'Person', 'Concept', 'Personal'];
const ALLOWED_LABELS = new Set([...BASE_LABELS, ...Object.values(schema.types).map((t) => t.label)]);
const ALLOWED_RELS = new Set([...Object.values(schema.relations), 'AUTHORED_BY', 'CITES', 'FOR']);
const SAFE = /^[A-Za-z][A-Za-z0-9_]*$/;

const ANY = BASE_LABELS.join('|');

async function exportAll() {
  const nodes = await run(`MATCH (n:${ANY}) RETURN labels(n) AS labels, properties(n) AS props ORDER BY n.key`);
  const rels = await run(
    `MATCH (a:${ANY})-[r]->(b:${ANY}) RETURN a.key AS \`from\`, b.key AS \`to\`, type(r) AS type, properties(r) AS props ORDER BY a.key, b.key, type(r)`);
  return { format: FORMAT, version: VERSION, exported_at: new Date().toISOString(), nodes, rels };
}

function chunks(list, n) { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }

// Dates were exported as text; put the two timestamps the hub itself uses back as datetimes.
const TIMES = `n.created_at = CASE WHEN r.props.created_at IS NULL THEN null ELSE datetime(r.props.created_at) END,
                 n.updated_at = CASE WHEN r.props.updated_at IS NULL THEN null ELSE datetime(r.props.updated_at) END`;

function check(doc) {
  if (!doc || doc.format !== FORMAT) throw new HttpError(400, `Not a research-hub backup (format must be "${FORMAT}").`);
  if (doc.version !== VERSION) throw new HttpError(400, `Unsupported backup version ${doc.version}.`);
  if (doc.nodes != null && !Array.isArray(doc.nodes)) throw new HttpError(400, 'nodes must be an array');
  if (doc.rels != null && !Array.isArray(doc.rels)) throw new HttpError(400, 'rels must be an array');
}

// Both arrays are optional so a large backup can be sent in several requests (nodes first, then rels).
async function restore(doc) {
  check(doc);
  const nodes = doc.nodes || [];
  const rels = doc.rels || [];
  const groups = new Map(); // "Artifact:Paper" -> { merge, extra, rows }
  for (const n of nodes) {
    const labels = Array.isArray(n.labels) ? n.labels : [];
    if (!n.props || typeof n.props.key !== 'string' || !n.props.key) throw new HttpError(400, 'every node needs props.key');
    for (const l of labels) if (!SAFE.test(l) || !ALLOWED_LABELS.has(l)) throw new HttpError(400, `label not allowed in a backup: ${l}`);
    const merge = BASE_LABELS.find((l) => labels.includes(l));
    if (!merge) throw new HttpError(400, `node ${n.props.key} has none of ${BASE_LABELS.join(', ')}`);
    const extra = labels.filter((l) => l !== merge).sort();
    const id = [merge, ...extra].join(':');
    if (!groups.has(id)) groups.set(id, { merge, extra, rows: [] });
    groups.get(id).rows.push({ key: n.props.key, props: n.props });
  }
  for (const r of rels) {
    if (!ALLOWED_RELS.has(r.type) || !SAFE.test(r.type)) throw new HttpError(400, `relationship type not allowed in a backup: ${r.type}`);
    if (typeof r.from !== 'string' || typeof r.to !== 'string') throw new HttpError(400, 'every relationship needs from and to keys');
  }

  let nodeCount = 0;
  for (const { merge, extra, rows } of groups.values()) {
    for (const part of chunks(rows, BATCH)) {
      await writeTx((tx) => tx.run(
        `UNWIND $rows AS r
         MERGE (n:${safeLabelOrBase(merge)} {key:r.key})
         ${extra.length ? `SET n:${extra.map(safeLabelOrBase).join(':')}` : ''}
         SET n += r.props, ${TIMES}`, { rows: part.map((x) => ({ key: x.key, props: x.props })) }));
      nodeCount += part.length;
    }
  }
  const byType = new Map();
  for (const r of rels) { if (!byType.has(r.type)) byType.set(r.type, []); byType.get(r.type).push({ from: r.from, to: r.to, props: r.props || {} }); }
  let relCount = 0;
  for (const [type, rows] of byType) {
    for (const part of chunks(rows, BATCH)) {
      const res = await writeTx((tx) => tx.run(
        `UNWIND $rows AS r
         MATCH (a:${ANY} {key:r.from}) MATCH (b:${ANY} {key:r.to})
         MERGE (a)-[x:${type}]->(b) SET x += r.props
         RETURN count(x) AS c`, { rows: part }));
      relCount += res.records[0].get('c').toNumber();
    }
  }
  return { nodes: nodeCount, rels_requested: rels.length, rels_restored: relCount, rels_skipped: rels.length - relCount };
}

// Base labels are not all in the type schema, so check them against the fixed list instead of safeLabel().
function safeLabelOrBase(l) {
  if (BASE_LABELS.includes(l)) return l;
  return safeLabel(l);
}

module.exports = { exportAll, restore, FORMAT, VERSION };
