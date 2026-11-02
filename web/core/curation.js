// Curation (Task 10): reviewable change plans. Claude (or the owner) proposes a plan, a list of operations (merge,
// unlink, delete, rename; the rules are in core/curation-ops.js); the owner applies or rejects it; an applied plan can
// be reverted. A plan records a fingerprint of everything it touches: applying refuses a plan whose data changed since
// it was made, and reverting refuses when the data changed after it was applied. Apply writes the difference between
// the snapshot before and after the operations, in one transaction; revert writes it back.
// Plans are (:CurationPlan) nodes: the curation log. They are not part of backups or the public export.
const crypto = require('crypto');
const neo4j = require('neo4j-driver');
const db = require('./db');
const cops = require('./curation-ops');
const { safeLabel, safeRel, entityLabels, typeLabels } = require('./schema');
const { HttpError } = require('./errors');
const hooks = require('./hooks');
const hypotheses = require('./hypotheses');
const drive = require('./drive');
const log = require('./log');

const STATUSES = ['proposed', 'applied', 'rejected', 'reverted'];
const MAX_REASON = 2000;

/* ---------------------------------------------------------------- values that keep their Neo4j types through JSON */
const DT = /^(-?\d{4,})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)/;
function enc(v) {
  if (neo4j.isInt(v)) return { $int: v.toString() };
  if (neo4j.isDateTime(v)) return { $datetime: v.toString() };
  if (neo4j.isDate(v)) return { $date: v.toString() };
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
  return v;
}
function dec(v) {
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === 'object') {
    if ('$int' in v) return neo4j.int(v.$int);
    if ('$date' in v) { const [y, m, d] = v.$date.split('-').map(Number); return new neo4j.types.Date(y, m, d); }
    if ('$datetime' in v) {
      const m = DT.exec(v.$datetime);
      if (!m) throw new Error(`unreadable datetime ${v.$datetime}`);
      const off = m[8] === 'Z' ? 0 : (m[8][0] === '-' ? -1 : 1) * (Number(m[8].slice(1, 3)) * 3600 + Number(m[8].slice(4, 6)) * 60);
      return new neo4j.types.DateTime(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number((m[7] || '0').padEnd(9, '0')), off);
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
  }
  return v;
}
const nowValue = () => { // in UTC, like datetime() in Cypher
  const d = new Date();
  return enc(new neo4j.types.DateTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds() * 1e6, 0));
};

/* ---------------------------------------------------------------- reading and writing snapshots */
// The label used to match a key (indexed): Artifact for items, the entity label for vocabulary, Personal for status.
const hint = (labels) => (labels.includes('Artifact') ? 'Artifact' : labels.find((l) => entityLabels.includes(l)) || (labels.includes('Personal') ? 'Personal' : null));

const LOAD = `UNWIND $keys AS k
  MATCH (n) WHERE n.key = k
  CALL { WITH n OPTIONAL MATCH (n)-[r]->(o) RETURN collect(CASE WHEN r IS NULL THEN null ELSE {type: type(r), key: o.key, labels: labels(o), props: properties(r)} END) AS out }
  CALL { WITH n OPTIONAL MATCH (i)-[q]->(n) RETURN collect(CASE WHEN q IS NULL THEN null ELSE {type: type(q), key: i.key, labels: labels(i), props: properties(q)} END) AS inc }
  RETURN n.key AS key, labels(n) AS labels, properties(n) AS props, out, inc`;

async function loadState(tx, keys) {
  const st = { nodes: {}, rels: [], ends: {} };
  const seen = new Set();
  const addRel = (r) => {
    if (r.from == null || r.to == null) throw new HttpError(409, `${r.from || r.to} has a ${r.type} relationship with a node that has no key; it cannot be curated`);
    const id = cops.relId(r) + JSON.stringify(r.props);
    if (!seen.has(id)) { seen.add(id); st.rels.push(r); }
  };
  for (const rec of (await tx.run(LOAD, { keys })).records) {
    const key = rec.get('key');
    const labels = [...rec.get('labels')].sort();
    st.nodes[key] = { labels, props: enc(rec.get('props')) };
    st.ends[key] = hint(labels);
    for (const o of rec.get('out')) { st.ends[o.key] = st.ends[o.key] || hint(o.labels); addRel({ type: o.type, from: key, to: o.key, props: enc(o.props) }); }
    for (const i of rec.get('inc')) { st.ends[i.key] = st.ends[i.key] || hint(i.labels); addRel({ type: i.type, from: i.key, to: key, props: enc(i.props) }); }
  }
  return st;
}

// Everything a plan touches: the ops' keys and their personal layer, plus, for deletes, the vocabulary next to the
// deleted node (it may be left without any relationship).
async function loadFor(tx, ops) {
  let keys = cops.loadKeys(ops);
  let st = await loadState(tx, keys);
  const deleted = new Set(ops.filter((o) => o && o.op === 'delete').map((o) => o.key));
  const extra = [...new Set(st.rels.filter((r) => deleted.has(r.from) || deleted.has(r.to)).map((r) => (deleted.has(r.from) ? r.to : r.from)))]
    .filter((k) => !keys.includes(k) && entityLabels.includes(st.ends[k]));
  if (extra.length) { keys = [...keys, ...extra]; st = await loadState(tx, keys); }
  return { keys, st };
}

const WRITABLE = new Set([...typeLabels, ...entityLabels, 'Artifact', 'Personal']);
const label = (l) => {
  if (!WRITABLE.has(l)) throw new HttpError(409, `Curation cannot write nodes labelled ${l}`);
  return l === 'Artifact' || l === 'Personal' ? l : safeLabel(l);
};
const relType = (t) => { try { return t === 'FOR' ? t : safeRel(t); } catch { throw new HttpError(409, `Curation cannot write ${t} relationships (not in the schema)`); } };
const node = (v, key, ends) => (ends[key] ? `(${v}:${label(ends[key])} {key:$${v}})` : `(${v} {key:$${v}})`);

// Make the database go from snapshot a to snapshot b (same set of keys).
async function writeDiff(tx, a, b) {
  const ends = { ...a.ends, ...b.ends };
  const relsOf = (s) => new Map(s.rels.map((r) => [cops.relId(r), r]));
  const ra = relsOf(a), rb = relsOf(b);
  for (const [id, r] of ra) {
    if (rb.has(id)) continue;
    await tx.run(`MATCH ${node('a', r.from, ends)}-[r:${relType(r.type)}]->${node('b', r.to, ends)} DELETE r`, { a: r.from, b: r.to });
  }
  for (const key of Object.keys(a.nodes)) if (!b.nodes[key]) await tx.run(`MATCH ${node('n', key, a.ends)} DETACH DELETE n`, { n: key });
  for (const [key, n] of Object.entries(b.nodes)) {
    if (!a.nodes[key]) await tx.run(`CREATE (n${n.labels.map((l) => ':' + label(l)).join('')}) SET n = $props`, { props: dec(n.props) });
    else if (JSON.stringify(a.nodes[key].props) !== JSON.stringify(n.props)) await tx.run(`MATCH ${node('n', key, a.ends)} SET n = $props`, { n: key, props: dec(n.props) });
  }
  for (const [id, r] of rb) {
    const old = ra.get(id);
    if (old && JSON.stringify(old.props) === JSON.stringify(r.props)) continue;
    const q = old ? `MATCH ${node('a', r.from, ends)}-[r:${relType(r.type)}]->${node('b', r.to, ends)} SET r = $props`
      : `MATCH ${node('a', r.from, ends)}, ${node('b', r.to, ends)} CREATE (a)-[r:${relType(r.type)}]->(b) SET r = $props`;
    await tx.run(q, { a: r.from, b: r.to, props: dec(r.props) });
  }
}

/* ---------------------------------------------------------------- plans */
const FIELDS = `p.id AS id, p.status AS status, p.ops_json AS ops, p.reason AS reason, p.by AS by, p.model AS model, toString(p.at) AS at,
  p.summary_json AS summary, p.keys AS keys, p.fingerprint AS fingerprint, p.after_fingerprint AS after_fingerprint,
  toString(p.applied_at) AS applied_at, toString(p.reverted_at) AS reverted_at, toString(p.rejected_at) AS rejected_at, p.trashed AS trashed`;
const view = (row) => {
  const s = JSON.parse(row.summary || '{}');
  return { id: row.id, status: row.status, reason: row.reason || '', by: row.by, model: row.model || null, at: row.at,
    applied_at: row.applied_at || null, reverted_at: row.reverted_at || null, rejected_at: row.rejected_at || null,
    ops: JSON.parse(row.ops || '[]'), changes: s.changes || [], drive_trash: s.trash || [] };
};
const plain = (rec) => db.plain(rec.toObject());

async function rename409(tx, ops) {
  for (const op of ops.filter((o) => o && o.op === 'rename' && typeof o.name === 'string')) {
    const [row] = (await tx.run('MATCH (n) WHERE n.key = $key RETURN labels(n) AS labels', { key: op.key })).records.map(plain);
    const l = row && row.labels.find((x) => entityLabels.includes(x));
    if (!l) continue; // the op itself reports what is wrong
    const norm = cops.normOf(l, op.name);
    const [other] = (await tx.run(`MATCH (n:${safeLabel(l)}) WHERE n.key <> $key AND (n.norm = $norm OR $norm IN coalesce(n.aliases_norm, [])) RETURN n.key AS key LIMIT 1`,
      { key: op.key, norm })).records.map(plain);
    if (other) throw new HttpError(409, `"${op.name}" is already ${other.key}: merge the two instead (keep one, drop the other)`);
  }
}

// -> the plan. Nothing in the library changes.
async function propose(ops, { reason = '', by = 'owner', model = null } = {}) {
  if (!Array.isArray(ops) || !ops.length) throw new HttpError(400, 'ops must be a non-empty list');
  if (ops.length > cops.MAX_OPS) throw new HttpError(400, `At most ${cops.MAX_OPS} operations per plan`);
  if (String(reason).length > MAX_REASON) throw new HttpError(400, `reason is limited to ${MAX_REASON} characters`);
  const id = 'plan:' + crypto.randomBytes(6).toString('hex');
  const row = await db.writeTx(async (tx) => {
    await rename409(tx, ops);
    const { keys, st } = await loadFor(tx, ops);
    const { changes, trash } = cops.applyOps(st, ops, { now: nowValue() });
    const res = await tx.run(
      `CREATE (p:CurationPlan {id:$id, status:'proposed', ops_json:$ops, reason:$reason, by:$by, model:$model, at:datetime(), summary_json:$summary, keys:$keys, fingerprint:$fp})
       RETURN ${FIELDS}`,
      { id, ops: JSON.stringify(ops), reason: String(reason || ''), by, model, summary: JSON.stringify({ changes, trash }), keys, fp: cops.fingerprint(st) });
    return plain(res.records[0]);
  });
  return view(row);
}

async function get(id) {
  const [row] = await db.run(`MATCH (p:CurationPlan {id:$id}) RETURN ${FIELDS}`, { id: String(id) });
  if (!row) throw new HttpError(404, 'No such plan');
  return view(row);
}

async function list({ status, limit } = {}) {
  if (status && !STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = await db.run(`MATCH (p:CurationPlan) WHERE $status IS NULL OR p.status = $status RETURN ${FIELDS} ORDER BY p.at DESC LIMIT toInteger($n)`, { status: status || null, n });
  return { plans: rows.map(view) };
}

const loadPlan = async (tx, id) => {
  const [row] = (await tx.run(`MATCH (p:CurationPlan {id:$id}) RETURN ${FIELDS}, p.before_json AS before`, { id: String(id) })).records.map(plain);
  if (!row) throw new HttpError(404, 'No such plan');
  return row;
};

// After a commit: tell the other features (public preview, personal layer), recompute hypotheses whose tests changed,
// and move hub-uploaded Drive files to or out of the trash. Failures are logged, never fatal.
async function afterChange(a, b, { trash = [], untrash = [] } = {}) {
  for (const key of new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])) {
    const n = b.nodes[key] || a.nodes[key];
    if (!cops.isArtifact(n)) continue;
    await hooks.emit(b.nodes[key] ? 'afterWrite' : 'afterRemove', b.nodes[key] ? { key, type: null, input: {}, created: false } : { key });
  }
  const tested = [...new Set([...a.rels, ...b.rels].filter((r) => r.type === 'TESTS').map((r) => r.to))]; // hypotheses
  if (tested.length) { try { await hypotheses.recompute(tested); } catch (e) { log.warn(`curation: hypothesis status not recomputed: ${e.message}`); } }
  if (!drive.configured()) { if (trash.length || untrash.length) log.warn('curation: Google Drive is not set up; files were not moved to or from the trash'); return; }
  for (const id of trash) { try { await drive.trash(id); } catch (e) { log.warn(`curation: could not trash Drive file ${id}: ${e.message}`); } }
  for (const id of untrash) { try { await drive.untrash(id); } catch (e) { log.warn(`curation: could not restore Drive file ${id}: ${e.message}`); } }
}

async function apply(id) {
  let a, b, trash;
  const row = await db.writeTx(async (tx) => {
    const p = await loadPlan(tx, id);
    if (p.status !== 'proposed') throw new HttpError(409, `This plan is ${p.status}; only a proposed plan can be applied`);
    a = await loadState(tx, p.keys);
    if (cops.fingerprint(a) !== p.fingerprint) throw new HttpError(409, 'The data changed since this plan was made. Propose it again to see the changes against the current data.');
    const out = cops.applyOps(a, JSON.parse(p.ops), { now: nowValue() });
    trash = out.trash;
    await writeDiff(tx, a, out.after);
    b = await loadState(tx, p.keys);
    const res = await tx.run(`MATCH (p:CurationPlan {id:$id}) SET p.status = 'applied', p.applied_at = datetime(), p.before_json = $before,
      p.after_fingerprint = $fp, p.trashed = $trash RETURN ${FIELDS}`, { id: p.id, before: JSON.stringify(a), fp: cops.fingerprint(b), trash });
    return plain(res.records[0]);
  });
  await afterChange(a, b, { trash });
  return view(row);
}

async function revert(id) {
  let a, b, untrash;
  const row = await db.writeTx(async (tx) => {
    const p = await loadPlan(tx, id);
    if (p.status !== 'applied') throw new HttpError(409, `This plan is ${p.status}; only an applied plan can be reverted`);
    a = await loadState(tx, p.keys);
    if (cops.fingerprint(a) !== p.after_fingerprint) {
      throw new HttpError(409, 'What this plan changed has been changed again since (by you, Claude or a later plan). Revert the later plans first, or fix it with a new plan.');
    }
    b = JSON.parse(p.before);
    untrash = p.trashed || [];
    await writeDiff(tx, a, b);
    const res = await tx.run(`MATCH (p:CurationPlan {id:$id}) SET p.status = 'reverted', p.reverted_at = datetime() RETURN ${FIELDS}`, { id: p.id });
    return plain(res.records[0]);
  });
  await afterChange(a, b, { untrash });
  return view(row);
}

async function reject(id) {
  const row = await db.writeTx(async (tx) => {
    const p = await loadPlan(tx, id);
    if (p.status !== 'proposed') throw new HttpError(409, `This plan is ${p.status}; only a proposed plan can be rejected`);
    const res = await tx.run(`MATCH (p:CurationPlan {id:$id}) SET p.status = 'rejected', p.rejected_at = datetime() RETURN ${FIELDS}`, { id: p.id });
    return plain(res.records[0]);
  });
  return view(row);
}

module.exports = { propose, apply, revert, reject, get, list, enc, dec, loadState, writeDiff, STATUSES };
