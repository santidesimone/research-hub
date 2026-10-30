// Markdown notes, methods and projects -> graph. The files live on your computer (ideally in git); `hub sync-notes`
// sends each file's front matter and text here. This module is the single place that turns them into nodes and edges:
//   * the folder (notes/, projects/) or a `kind:` field picks the type; only types with managed: "markdown" in
//     schema/schema.json sync. Methods, use cases and case studies live in the database: their files are skipped and
//     they are never pruned;
//   * front-matter fields named in schema.relations become edges to other artifacts; `concepts:` become Concept nodes;
//   * the file's text is stored on the node as `body`; a file removed from your folder is removed from the graph (prune).
const { schema, safeLabel, safeRel, orphanLabels, keyPrefix } = require('./schema');
const { HttpError } = require('./errors');
const { writeTx, run } = require('./db');
const hooks = require('./hooks');

const KINDS = Object.fromEntries(Object.entries(schema.types).filter(([, d]) => d.managed === 'markdown' && d.folder));
const FOLDER_KIND = Object.fromEntries(Object.entries(KINDS).map(([n, d]) => [d.folder, n]));
// Types that used to come from Markdown (or could be named with kind:) but are database-managed now.
const DB_FOLDER = Object.fromEntries(Object.entries(schema.types).filter(([, d]) => d.managed !== 'markdown' && d.folder).map(([n, d]) => [d.folder, n]));
const MARKDOWN_LABELS = Object.values(KINDS).map((d) => d.label);

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const normRef = (r) => { r = String(r).trim(); return r.toLowerCase().startsWith('doi:') ? 'doi:' + r.slice(4).trim().toLowerCase() : r; };

// Neo4j properties hold strings, numbers, booleans and lists of those: anything else is stored as text.
function scalar(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : x));
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

// entry: { path: 'notes/foo.md', meta: {front matter}, body: 'markdown text' } -> { item, warnings } | { skip }
function toItem({ path: p, meta, body }) {
  meta = meta && typeof meta === 'object' ? meta : {};
  const parts = String(p || '').split('/').filter(Boolean);
  const file = parts[parts.length - 1] || '';
  if (!/\.md$/i.test(file)) return { skip: `${p || '(no path)'}: not a Markdown file` };
  const stem = file.replace(/\.md$/i, '').trim();
  if (!stem || stem.length > 200 || /[\u0000-\u001f]/.test(stem)) return { skip: `${p}: unusable file name` };
  const kind = meta.kind || FOLDER_KIND[parts[parts.length - 2]];
  const dbKind = schema.types[kind] ? kind : !meta.kind && DB_FOLDER[parts[parts.length - 2]];
  if (dbKind && !KINDS[dbKind]) return { skip: `${p}: ${schema.types[dbKind].label} items are managed in the hub database now (edit them in the Library or the API); file skipped` };
  if (!KINDS[kind]) return { skip: `${p}: put it in a ${Object.values(KINDS).map((d) => d.folder + '/').join(', ')} folder or set kind: ${Object.keys(KINDS).join(' | ')}` };
  const def = KINDS[kind];
  const warnings = [];
  let visibility = meta.visibility == null ? 'private' : String(meta.visibility);
  if (!['public', 'private'].includes(visibility)) { warnings.push(`${p}: visibility "${visibility}" is not public or private; using private`); visibility = 'private'; }
  const props = {
    title: meta.title ? String(meta.title) : stem,
    visibility,
    summary: scalar(meta.summary),
    body: String(body || '').trim() ? String(body) : null,
    source_path: String(p),
    managed: 'markdown',
    schema_version: def.schema_version,
    path: null, // older versions kept a path into a baked-in folder; the text is stored on the node now
  };
  for (const k of def.props) props[k] = scalar(meta[k]);
  const relations = [];
  for (const [field, rel] of Object.entries(schema.relations)) {
    for (const t of asList(meta[field])) relations.push({ rel, target: normRef(t) });
  }
  const concepts = asList(meta.concepts).map((c) => ({ key: 'concept:' + slugify(c), name: String(c).replace(/-/g, ' ') })).filter((c) => c.key !== 'concept:');
  return { item: { key: keyPrefix(kind) + stem, kind, label: def.label, props, relations, concepts }, warnings };
}

// Only Markdown-managed types can be pruned, whatever their `source` says.
const PRUNABLE = 'WHERE NOT n.key IN $keys AND any(l IN labels(n) WHERE l IN $labels)';

async function plan(keys, prune) {
  const existing = new Set((await run('MATCH (n:Artifact) WHERE n.key IN $keys RETURN n.key AS key', { keys })).map((r) => r.key));
  const removed = prune ? (await run(`MATCH (n:Artifact {source:'markdown'}) ${PRUNABLE} RETURN n.key AS key`, { keys, labels: MARKDOWN_LABELS })).map((r) => r.key) : [];
  return { existing, removed };
}

async function sync(entries, { prune = true, allowEmpty = false, dryRun = false } = {}) {
  if (!Array.isArray(entries)) throw new HttpError(400, 'items must be an array');
  const items = [];
  const skipped = [];
  const warnings = [];
  const seen = new Set();
  for (const e of entries) {
    const r = toItem(e || {});
    if (r.skip) { skipped.push(r.skip); continue; }
    if (seen.has(r.item.key)) { skipped.push(`${e.path}: duplicate of ${r.item.key}`); continue; }
    seen.add(r.item.key);
    items.push(r.item);
    warnings.push(...r.warnings);
  }
  if (!items.length && prune && !allowEmpty) {
    throw new HttpError(400, 'Refusing to prune: no usable Markdown files were sent, which would delete every note that came from Markdown. Pass allow_empty=true if that is what you want.');
  }
  const keys = items.map((i) => i.key);

  if (dryRun) {
    const { existing, removed } = await plan(keys, prune);
    return { dry_run: true, would_create: keys.filter((k) => !existing.has(k)).length, would_update: keys.filter((k) => existing.has(k)).length, would_remove: removed, skipped, warnings };
  }

  const byLabel = new Map();
  for (const it of items) { if (!byLabel.has(it.label)) byLabel.set(it.label, []); byLabel.get(it.label).push({ key: it.key, props: it.props }); }
  const relRows = new Map(); // rel -> [{a, b}]
  for (const it of items) for (const r of it.relations) { if (!relRows.has(r.rel)) relRows.set(r.rel, []); relRows.get(r.rel).push({ a: it.key, b: r.target }); }
  const conceptRows = items.flatMap((it) => it.concepts.map((c) => ({ a: it.key, ck: c.key, name: c.name })));
  const targets = [...new Set([...relRows.values()].flat().map((r) => r.b))];

  const out = await writeTx(async (tx) => {
    const existing = new Set((await tx.run('MATCH (n:Artifact) WHERE n.key IN $keys RETURN n.key AS key', { keys })).records.map((r) => r.get('key')));
    // upserts: one statement per label, however many files
    for (const [label, rows] of byLabel) {
      await tx.run(
        `UNWIND $rows AS r
         MERGE (n:Artifact {key:r.key}) ON CREATE SET n.created_at = datetime()
         SET n:${safeLabel(label)}, n += r.props, n.source = 'markdown', n.updated_at = datetime()`, { rows });
    }
    let removed = [];
    if (prune) {
      removed = (await tx.run(`MATCH (n:Artifact {source:'markdown'}) ${PRUNABLE} WITH n, n.key AS key DETACH DELETE n RETURN key`, { keys, labels: MARKDOWN_LABELS })).records.map((r) => r.get('key'));
    }
    // edges: drop this run's old Markdown edges, add the current ones (hub- and OpenAlex-made edges are never touched)
    await tx.run("MATCH (n:Artifact)-[r]->() WHERE n.key IN $keys AND r.source = 'markdown' DELETE r", { keys });
    const present = targets.length ? new Set((await tx.run('MATCH (n:Artifact) WHERE n.key IN $targets RETURN n.key AS key', { targets })).records.map((r) => r.get('key'))) : new Set();
    let edges = 0;
    const missing = [];
    for (const [rel, rows] of relRows) {
      const good = rows.filter((r) => present.has(r.b));
      for (const r of rows) if (!present.has(r.b)) missing.push(`${r.a} ${rel} -> ${r.b}: target not found`);
      if (good.length) {
        await tx.run(`UNWIND $rows AS r MATCH (a:Artifact {key:r.a}), (b:Artifact {key:r.b}) MERGE (a)-[x:${safeRel(rel)}]->(b) SET x.source = 'markdown'`, { rows: good });
        edges += good.length;
      }
    }
    if (conceptRows.length) {
      await tx.run(
        `UNWIND $rows AS r MATCH (a:Artifact {key:r.a}) MERGE (c:Concept {key:r.ck}) SET c.name = r.name
         MERGE (a)-[x:ABOUT]->(c) SET x.source = 'markdown'`, { rows: conceptRows });
      edges += conceptRows.length;
    }
    for (const l of orphanLabels) await tx.run(`MATCH (x:${safeLabel(l)}) WHERE NOT (x)--() DELETE x`);
    return { existing, removed, edges, missing };
  });

  for (const it of items) await hooks.emit('afterWrite', { key: it.key, type: it.kind, input: {}, created: !out.existing.has(it.key) });
  for (const key of out.removed) await hooks.emit('afterRemove', { key });
  return {
    upserted: items.length,
    created: keys.filter((k) => !out.existing.has(k)).length,
    updated: keys.filter((k) => out.existing.has(k)).length,
    removed: out.removed, edges: out.edges, skipped, warnings: [...warnings, ...out.missing],
  };
}

module.exports = { toItem, sync, scalar };
