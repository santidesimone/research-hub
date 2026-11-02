// Curation, the pure part (Task 10): each operation turns one snapshot of part of the graph into the next.
// A snapshot is { nodes: {key: {labels, props}}, rels: [{type, from, to, props}], ends: {key: label} }: a set of nodes,
// every relationship touching them, and a label for every key it mentions (so the writer can match by label). Values
// are encoded so they survive JSON with their Neo4j types ({$int}, {$datetime}, {$date}; see core/curation.js).
// core/curation.js loads snapshots, stores plans and writes the difference between two snapshots: apply writes
// before -> after, revert writes after -> before. No I/O here, so every rule is testable offline.
const crypto = require('crypto');
const { HttpError } = require('./errors');
const vocab = require('./vocab');
const { entityLabels, orphanLabels, relationTypes } = require('./schema');

const MAX_OPS = 50;
const OPS = ['merge', 'unlink', 'delete', 'rename'];
const clone = (x) => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const relId = (r) => `${r.type}|${r.from}|${r.to}`;
const personalKey = (k) => 'personal:' + k;
const isArtifact = (n) => n.labels.includes('Artifact');
const entityOf = (n) => n.labels.find((l) => entityLabels.includes(l));
const parseJson = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };

// Properties that are the node's identity or the hub's bookkeeping: a merge keeps the surviving node's own.
const ARTIFACT_OWN = new Set(['key', 'created_at', 'updated_at', 'source', 'managed', 'schema_version', 'collection', 'record_status',
  'provenance', 'merged_from', 'file_url', 'drive_file_id', 'legacy_pdf_uri', 'source_path', 'imported_from', 'path']);
const VOCAB_OWN = new Set(['key', 'name', 'aliases', 'norm', 'letters', 'letters_plain', 'aliases_norm', 'aliases_letters', 'aliases_text',
  'created_at', 'updated_at', 'by', 'at', 'model']);
// Drive files the hub uploaded, by property: they go to the Drive trash when their node goes, unless the link moves.
const FILE_IDS = ['drive_file_id', 'snapshot__drive_file_id'];
// A field and its stored parts (x, x_json, x__part) are one unit.
const fieldOf = (prop) => prop.replace(/__.+$/, '').replace(/_json$/, '');

function canon(state) {
  const sorted = (o) => (Array.isArray(o) ? o.map(sorted) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sorted(o[k])])) : o);
  const rels = state.rels.map(sorted).map((r) => JSON.stringify(r)).sort();
  return JSON.stringify({ nodes: sorted(state.nodes), rels });
}
// What a plan was made against; apply and revert compare it with what is in the database at that moment.
const fingerprint = (state) => crypto.createHash('sha256').update(canon(state)).digest('hex');

const fail = (status, message) => { throw new HttpError(status, message); };
const need = (v, what) => (typeof v === 'string' && v.trim() ? v.trim() : fail(400, `${what} is required`));
const show = (props) => { const v = Object.values(props)[0]; const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 120 ? s.slice(0, 117) + '...' : s; };

// The keys an op touches, and what the loader must read for it (their personal layer too).
function keysOf(op) {
  switch (op && op.op) {
    case 'merge': return [op.keep, op.drop];
    case 'unlink': return [op.from, op.to];
    case 'delete': case 'rename': return [op.key];
    default: return [];
  }
}
const loadKeys = (ops) => [...new Set(ops.flatMap(keysOf).filter((k) => typeof k === 'string' && k).flatMap((k) => [k, personalKey(k)]))];

// Vocabulary helpers: the matcher's derived fields after a name or alias change.
function withAliases(label, props, name, aliases) {
  const d = vocab.derived(label, name, aliases);
  return { ...props, name, aliases, norm: d.norm, letters: d.letters, letters_plain: d.letters_plain,
    aliases_norm: d.aliases_norm, aliases_letters: d.aliases_letters, aliases_text: d.aliases_text };
}
const normOf = (label, s) => vocab.derived(label, String(s)).norm;

function removePersonal(st, key) {
  const pk = personalKey(key);
  if (!st.nodes[pk]) return null;
  const node = st.nodes[pk];
  delete st.nodes[pk];
  const rels = st.rels.filter((r) => r.from === pk || r.to === pk);
  st.rels = st.rels.filter((r) => r.from !== pk && r.to !== pk);
  return { node, rels };
}

function merge(st, op, ctx) {
  const keep = need(op.keep, 'keep'), drop = need(op.drop, 'drop');
  if (keep === drop) fail(400, 'keep and drop are the same item');
  const K = st.nodes[keep], D = st.nodes[drop];
  if (!K) fail(404, `No such item: ${keep}`);
  if (!D) fail(404, `No such item: ${drop}`);
  if (!same([...K.labels].sort(), [...D.labels].sort())) fail(400, `${drop} (${D.labels.join(', ')}) and ${keep} (${K.labels.join(', ')}) are different kinds; only the same kind can be merged`);
  const label = entityOf(K);
  if (!isArtifact(K) && !label) fail(400, 'Only library items and vocabulary (authors, concepts, topics...) can be merged');
  const take = Array.isArray(op.take) ? op.take.map(String) : [];
  const change = { op: 'merge', keep, drop, moved_links: {}, dropped_links: 0, copied: [], taken: [], conflicts: [], aliases_added: [], personal: null, file: null };

  // relationships: drop's become keep's; one that would join keep to itself, or that keep already has, is dropped
  const have = new Set(st.rels.filter((r) => r.from !== drop && r.to !== drop).map(relId));
  const rels = [];
  for (const r of st.rels) {
    if (r.from !== drop && r.to !== drop) { rels.push(r); continue; }
    if (r.type === 'FOR' && r.to === drop && r.from === personalKey(drop)) { rels.push(r); continue; } // the personal layer: below
    const m = { ...r, from: r.from === drop ? keep : r.from, to: r.to === drop ? keep : r.to };
    if ((m.from === keep && m.to === keep) || have.has(relId(m))) { change.dropped_links++; continue; }
    have.add(relId(m));
    rels.push(m);
    change.moved_links[m.type] = (change.moved_links[m.type] || 0) + 1;
  }
  st.rels = rels;

  // fields: copy what keep lacks; a conflict keeps keep's value unless the field is in take
  const own = isArtifact(K) ? ARTIFACT_OWN : VOCAB_OWN;
  const fields = (props) => {
    const out = {};
    for (const [p, v] of Object.entries(props)) { const f = fieldOf(p); if (!own.has(f) && !own.has(p)) (out[f] = out[f] || {})[p] = v; }
    return out;
  };
  const fk = fields(K.props), fd = fields(D.props);
  for (const f of take) if (!fd[f]) fail(400, `take: ${f} is not set on ${drop}`);
  const provK = parseJson(K.props.provenance_json), provD = parseJson(D.props.provenance_json);
  let provChanged = false;
  for (const [f, dp] of Object.entries(fd)) {
    const kp = fk[f];
    if (kp && same(kp, dp)) continue;
    if (kp && !take.includes(f)) { change.conflicts.push({ field: f, keep: show(kp), drop: show(dp) }); continue; }
    if (kp) { for (const p of Object.keys(kp)) delete K.props[p]; change.taken.push(f); } else change.copied.push(f);
    Object.assign(K.props, dp);
    if (provD[f]) provK[f] = provD[f]; else delete provK[f];
    provChanged = true;
  }
  if (isArtifact(K)) {
    if (provChanged && (K.props.provenance_json != null || Object.keys(provK).length)) K.props.provenance_json = JSON.stringify(provK);
    if (provChanged && K.props.record_status != null && Object.values(provK).some((p) => p && p.by === 'claude' && p.status === 'auto')) K.props.record_status = 'auto';
    K.props.merged_from = [...new Set([...(K.props.merged_from || []), drop, ...(D.props.merged_from || [])])];
    // the file link: moves when keep has none; otherwise drop's hub-uploaded copy goes to the Drive trash
    if (D.props.file_url != null && K.props.file_url == null) {
      for (const p of ['file_url', 'drive_file_id']) if (D.props[p] != null) K.props[p] = D.props[p];
      change.file = 'moved to ' + keep;
    } else if (D.props.drive_file_id != null) {
      ctx.trash.push(D.props.drive_file_id);
      change.file = `${drop}'s copy in your Drive goes to the Drive trash (${keep} keeps its own file)`;
    }
    if (D.props.snapshot__drive_file_id != null && K.props.snapshot__drive_file_id !== D.props.snapshot__drive_file_id) ctx.trash.push(D.props.snapshot__drive_file_id);
  } else {
    // vocabulary: drop's name and aliases become keep's aliases, so the matcher maps them to keep from now on
    const seen = new Set([K.props.name, ...(K.props.aliases || [])].map((x) => normOf(label, x)));
    const add = [];
    for (const x of [D.props.name, ...(D.props.aliases || [])]) {
      const n = x ? normOf(label, x) : '';
      if (n && !seen.has(n)) { seen.add(n); add.push(x); }
    }
    if (add.length) { K.props = withAliases(label, K.props, K.props.name, [...(K.props.aliases || []), ...add]); change.aliases_added = add; }
  }
  if (K.props.updated_at != null) K.props.updated_at = ctx.now;

  // the personal layer: drop's moves to keep when keep has none
  const pd = removePersonal(st, drop);
  if (pd) {
    if (st.nodes[personalKey(keep)]) change.personal = `your status on ${keep} stays; the one on ${drop} is removed`;
    else {
      st.nodes[personalKey(keep)] = { labels: pd.node.labels, props: { ...pd.node.props, key: personalKey(keep) } };
      st.ends[personalKey(keep)] = 'Personal';
      const r = pd.rels.find((x) => x.type === 'FOR') || { type: 'FOR', props: {} };
      st.rels.push({ type: 'FOR', from: personalKey(keep), to: keep, props: r.props });
      change.personal = `your status moves to ${keep}`;
    }
  }
  delete st.nodes[drop];
  ctx.gone.add(drop);
  return change;
}

function unlink(st, op) {
  const from = need(op.from, 'from'), to = need(op.to, 'to'), rel = need(op.rel, 'rel').toUpperCase();
  if (!relationTypes.has(rel)) fail(400, `Unknown relation: ${rel}`);
  if (!st.nodes[from]) fail(404, `No such item: ${from}`);
  const before = st.rels.length;
  st.rels = st.rels.filter((r) => !(r.type === rel && r.from === from && r.to === to));
  if (st.rels.length === before) fail(404, `No ${rel} link from ${from} to ${to}`);
  return { op: 'unlink', from, rel, to, removed: before - st.rels.length };
}

function remove(st, op, ctx) {
  const key = need(op.key, 'key');
  const N = st.nodes[key];
  if (!N) fail(404, `No such item: ${key}`);
  if (!isArtifact(N) && !entityOf(N)) fail(400, 'Only library items and vocabulary can be deleted');
  const change = { op: 'delete', key, title: N.props.title || N.props.name || key, links: {}, orphans: [], personal: false, file: null };
  const neighbours = new Set();
  st.rels = st.rels.filter((r) => {
    if (r.from !== key && r.to !== key) return true;
    if (r.from === personalKey(key)) return true; // removed with the personal layer below
    change.links[r.type] = (change.links[r.type] || 0) + 1;
    neighbours.add(r.from === key ? r.to : r.from);
    return false;
  });
  change.personal = Boolean(removePersonal(st, key));
  delete st.nodes[key];
  ctx.gone.add(key);
  for (const p of FILE_IDS) if (N.props[p] != null) { ctx.trash.push(N.props[p]); change.file = 'its copy in your Drive goes to the Drive trash'; }
  // vocabulary left without any relationship goes too (the labels the schema prunes)
  for (const k of neighbours) {
    const n = st.nodes[k];
    if (!n || !n.labels.some((l) => orphanLabels.includes(l)) || st.rels.some((r) => r.from === k || r.to === k)) continue;
    delete st.nodes[k];
    ctx.gone.add(k);
    change.orphans.push(k);
  }
  return change;
}

function rename(st, op) {
  const key = need(op.key, 'key'), name = need(op.name, 'name');
  const N = st.nodes[key];
  if (!N) fail(404, `No such node: ${key}`);
  const label = entityOf(N);
  if (!label) fail(400, 'Only vocabulary (authors, concepts, topics, venues...) can be renamed; change an item\'s title by editing it');
  const old = N.props.name;
  if (normOf(label, name) === normOf(label, old) && name === old) fail(400, `${key} is already called ${name}`);
  const fresh = normOf(label, name);
  const aliases = [];
  const seen = new Set([fresh]);
  for (const x of [...(N.props.aliases || []), old]) { const n = x ? normOf(label, x) : ''; if (n && !seen.has(n)) { seen.add(n); aliases.push(x); } }
  N.props = withAliases(label, N.props, name, aliases);
  return { op: 'rename', key, from: old, to: name };
}

// Run every op on a copy of the snapshot. -> { after, changes, trash: [Drive file ids] }. Throws HttpError (4xx).
function applyOps(state, ops, { now } = {}) {
  if (!Array.isArray(ops) || !ops.length) fail(400, 'ops must be a non-empty list');
  if (ops.length > MAX_OPS) fail(400, `At most ${MAX_OPS} operations per plan`);
  const st = clone(state);
  const ctx = { now: now || null, trash: [], gone: new Set() };
  const changes = [];
  ops.forEach((op, i) => {
    try {
      if (!op || !OPS.includes(op.op)) fail(400, `op must be one of ${OPS.join(', ')}`);
      for (const k of keysOf(op)) if (ctx.gone.has(k)) fail(400, `${k} is removed by an earlier step`);
      changes.push(op.op === 'merge' ? merge(st, op, ctx) : op.op === 'unlink' ? unlink(st, op) : op.op === 'delete' ? remove(st, op, ctx) : rename(st, op));
    } catch (e) {
      if (e instanceof HttpError) { e.message = `step ${i + 1} (${(op && op.op) || '?'}): ${e.message}`; }
      throw e;
    }
  });
  return { after: st, changes, trash: [...new Set(ctx.trash)] };
}

module.exports = { applyOps, fingerprint, canon, loadKeys, keysOf, relId, personalKey, entityOf, isArtifact, normOf, FILE_IDS, MAX_OPS, OPS };
