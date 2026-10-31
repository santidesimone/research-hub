// Collection items (paper, method, use_case, case_study): schema-driven storage, reads, owner edits and merge rules.
// web/features/items exposes this as /api/items; Claude's analysis (Task 4) writes through write() as well.
//
// Storage, per field type in schema/schema.json:
//   scalars and lists of scalars  node properties (`year`, `procedure`)
//   object / list of objects      JSON text in `<field>_json`, parsed on read; a single object also keeps each declared
//                                 part as a plain property `<field>__<part>` so Cypher can query it (p.evidence__n > 100)
//   ref                           edges (field's rel) to vocabulary nodes, resolved from names by vocab.resolve, or to
//                                 items by key; each edge records `field`, `position` and `source: 'items'`
//   provenance                    `provenance_json`: field -> {by, at, model, confidence, status}
// Merge rules: the owner's writes always apply and mark the field {by: owner, status: reviewed}. Any other writer
// (claude, source) only fills empty fields it is allowed to fill (the field's `by`), never touches a field the owner wrote
// or reviewed (a value with no provenance counts as the owner's), and `force` replaces only values that same writer wrote.
const neo4j = require('neo4j-driver');
const { schema, fieldsOf, keyPrefix, validate, safeLabel, safeRel, entityLabels, relationTypes, relTargets } = require('./schema');
const hypotheses = require('./hypotheses');
const { HttpError } = require('./errors');
const db = require('./db');
const types = require('./types');
const vocab = require('./vocab');
const hooks = require('./hooks');
const artifacts = require('./artifacts');
const { scalar } = require('./notes');
const { luceneQuery } = require('./query');

const COLLECTIONS = Object.keys(schema.types).filter((t) => schema.types[t].collection);
const BY_CODE = { owner: 'Y', claude: 'C', source: 'S' };
const CONFIDENCE = ['low', 'medium', 'high'];
// Properties that are the hub's own bookkeeping, never fields and never writable as "unknown" fields.
const SYSTEM = new Set(['key', 'source', 'created_at', 'updated_at', 'collection', 'managed', 'schema_version', 'provenance', 'provenance_json',
  'record_status', 'source_path', 'imported_from', 'path', 'file_url', 'drive_file_id', 'legacy_pdf_uri', 'author_lasts', 'slug']);
const UNKNOWN_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_UNKNOWN = 50;
const MAX_LIMIT = 100;
const MAX_REFS = 100; // values per link field: each name is a vocabulary lookup
const MAX_QUERY = 500; // characters of a list search

const isSys = (f) => f.by.length === 1 && f.by[0] === 'Sys';
const kindOf = (f) => (f.type === 'ref' ? 'edge' : f.type === 'object' ? 'json' : 'prop');
const empty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
// An item needs review while it holds values Claude wrote that nobody has accepted; the owner's and the sources' do not.
const needsReview = (prov) => Object.values(prov || {}).some((p) => p && p.by === 'claude' && p.status === 'auto');
// The queryable copies of a single object's parts: `<field>__<part>` for each part the schema declares.
const partNames = (f, spec) => (kindOf(spec) === 'json' && !spec.list ? Object.keys(spec.props || {}).map((k) => `${f}__${k}`) : []);
function partValues(f, spec, v) {
  const obj = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  return Object.fromEntries(Object.keys(spec.props || {}).map((k) => {
    const x = obj[k];
    return [`${f}__${k}`, x == null || typeof x === 'object' ? null : x];
  }));
}
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');

// Questions and hypotheses are known by their text: their title is derived from it when none is given.
function deriveTitle(c, fields) {
  const from = typeDef(c).title_from;
  if (!from || (typeof fields.title === 'string' && fields.title.trim()) || typeof fields[from] !== 'string' || !fields[from].trim()) return fields;
  const t = fields[from].replace(/\s+/g, ' ').trim();
  return { ...fields, title: t.length <= 120 ? t : t.slice(0, 119).replace(/\s+\S*$/, '') + '…' };
}
// An IRI as written in many ways -> one form: no angle brackets or spaces; http(s) IRIs get URL's lower-case scheme and host.
function normalizeIri(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim().replace(/^<|>$/g, '').trim();
  if (!/^https?:\/\//i.test(t)) return t; // urn:, tag: ... are kept exactly as written
  try { const u = new URL(t); return `${u.protocol}//${u.host}${u.pathname}${u.search}${u.hash}`; } catch { return t; }
}
const normalizeFields = (c, input) => {
  const out = { ...input };
  for (const [f, spec] of Object.entries(fieldsOf(c))) if (spec.normalize === 'iri' && out[f] != null) out[f] = normalizeIri(out[f]);
  return out;
};
// Another item named by its title (or acronym, or an alias): exactly one match, or none. Items are never created here.
async function findByTitle(label, name) {
  return (await db.run(
    `MATCH (n:${safeLabel(label)}) WHERE toLower(trim(n.title)) = toLower(trim($name)) OR toLower(trim(coalesce(n.acronym, ''))) = toLower(trim($name))
       OR any(a IN coalesce(n.aliases, []) WHERE toLower(trim(a)) = toLower(trim($name)))
     RETURN n.key AS key LIMIT 2`, { name: String(name) })).map((r) => r.key);
}
const typeDef = (c) => schema.types[c];
const codec = (c, f) => (types.get(c).codec || {})[f];

function collectionCheck(c) {
  if (!COLLECTIONS.includes(c)) throw new HttpError(400, `collection must be one of ${COLLECTIONS.join(', ')}`);
  return c;
}
// Writable fields of a collection: everything except what the hub sets itself (record_status is the owner's to set).
function specs(c) { return Object.fromEntries(Object.entries(fieldsOf(c)).filter(([, f]) => !isSys(f))); }
// Names that may not be stored as "unknown" fields on this collection.
function reserved(c) {
  const out = new Set(SYSTEM);
  for (const [f, spec] of Object.entries(fieldsOf(c))) if (kindOf(spec) === 'json') { out.add(`${f}_json`); partNames(f, spec).forEach((n) => out.add(n)); }
  if (!fieldsOf(c).status) out.add('status'); // your reading status lives in the personal layer (/api/personal)
  return out;
}

/* ------------------------------------------------------------------ reading */

const READ = `MATCH (n:Artifact {key:$key})
  RETURN labels(n) AS labels, properties(n) AS props,
    [(n)-[r]->(t) | {rel: type(r), r: properties(r), key: t.key, name: coalesce(t.name, t.title), labels: labels(t)}] AS out,
    [(s:Artifact)-[r]->(n) | {rel: type(r), r: properties(r), key: s.key, name: s.title, labels: labels(s)}] AS inc`;

function collectionOfLabels(labels) {
  return COLLECTIONS.find((c) => labels.includes(typeDef(c).label)) || null;
}
const parseJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

// Edges of a ref field: same relationship and target label, written for this field (or by an older writer, no field).
function refTargets(row, f, spec) {
  const hits = row.out.filter((e) => e.rel === spec.rel && e.labels.includes(spec.ref) && (e.r.field == null || e.r.field === f));
  const order = Array.isArray(row.props[f]) ? row.props[f] : []; // papers keep authors in order as a list property
  const pos = (e) => (e.r.position != null ? e.r.position : order.indexOf(e.name) >= 0 ? order.indexOf(e.name) : 1e6);
  return hits.sort((a, b) => pos(a) - pos(b) || String(a.name).localeCompare(String(b.name))).map((e) => ({ key: e.key, name: e.name }));
}

function fieldValue(row, c, f, spec) {
  const p = row.props;
  if (kindOf(spec) === 'json') {
    if (p[`${f}_json`] != null) return parseJson(p[`${f}_json`]) ?? null;
    return null;
  }
  if (kindOf(spec) === 'edge') {
    let v = refTargets(row, f, spec);
    if (!v.length && !empty(p[f])) v = (Array.isArray(p[f]) ? p[f] : [p[f]]).map((name) => ({ key: null, name: String(name) })); // text from older writers
    return spec.list ? v : v[0] || null;
  }
  const cd = codec(c, f);
  return p[f] == null ? null : cd ? cd.read(p[f]) : p[f];
}

function toItem(row) {
  const c = collectionOfLabels(row.labels);
  if (!c) return null;
  const all = fieldsOf(c);
  const fields = {};
  for (const [f, spec] of Object.entries(all)) if (!isSys(spec) && f !== 'record_status') fields[f] = fieldValue(row, c, f, spec); // record_status is top-level
  const known = new Set([...Object.keys(all), ...Object.keys(all).map((f) => `${f}_json`), ...Object.entries(all).flatMap(([f, spec]) => partNames(f, spec)), ...(typeDef(c).props || [])]);
  const p = row.props;
  const extra = Object.fromEntries(Object.entries(p).filter(([k]) => !known.has(k) && !SYSTEM.has(k)));
  const link = (e) => ({ rel: e.rel, key: e.key, name: e.name, labels: e.labels.filter((l) => l !== 'Artifact'), ...pick(e.r, ['field', 'evidence', 'location', 'confidence', 'by', 'at', 'model', 'status', 'source', 'result', 'external_iri']) });
  return {
    key: p.key, collection: c, record_status: p.record_status || null, schema_version: p.schema_version ?? null, managed: p.managed || null,
    created_at: p.created_at || null, updated_at: p.updated_at || null,
    fields, provenance: parseJson(p.provenance_json || '{}') || {},
    links: { out: row.out.map(link), in: row.inc.map(link) },
    meta: pick(p, ['source', 'source_path', 'imported_from', 'file_url', 'drive_file_id', 'legacy_pdf_uri']),
    extra,
  };
}
function pick(o, keys) { return Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]])); }

async function get(key) {
  const [row] = await db.run(READ, { key });
  const item = row && toItem(row);
  if (!item) throw new HttpError(404, row ? `${key} is not a collection item` : 'No such item');
  return item;
}

/* ------------------------------------------------------------------ writing */

// Turn a ref field's value (names, keys, {name}/{key} objects) into target keys. Vocabulary names are resolved (and
// created when new); items must be referenced by key.
async function resolveRefs(spec, value, by, model) {
  const list = (Array.isArray(value) ? value : [value]).filter((x) => !empty(x));
  if (list.length > MAX_REFS) throw new HttpError(400, `${spec.ref}: at most ${MAX_REFS} values in one field`);
  const out = [];
  const warnings = [];
  for (const x of list) {
    const name = typeof x === 'object' ? x.name : x;
    const key = typeof x === 'object' ? x.key : null;
    if (entityLabels.includes(spec.ref)) {
      const prefix = schema.entities[spec.ref].key_prefix;
      if (key || (typeof name === 'string' && name.startsWith(prefix))) { out.push({ key: key || name, check: true }); continue; }
      if (typeof name !== 'string' || !name.trim()) { warnings.push(`${spec.ref}: expected a name`); continue; }
      const r = await vocab.resolve(spec.ref, name, { by: by === 'owner' ? 'owner' : by, model });
      out.push({ key: r.key });
    } else if (key || (typeof name === 'string' && /^[a-z_]+:\S/.test(name))) {
      out.push({ key: key || name, check: true }); // another item: by key
    } else {
      const found = typeof name === 'string' && name.trim() ? await findByTitle(spec.ref, name) : [];
      if (found.length === 1) out.push({ key: found[0], check: true });
      else warnings.push(`${spec.ref} "${name}": ${found.length ? 'more than one match; pass its key' : 'not found (items are linked, never created, from a name)'}`);
    }
  }
  return { targets: out, warnings };
}

function currentValue(state, f, spec) {
  if (!state) return null;
  if (kindOf(spec) === 'json') return state.props[`${f}_json`] ?? state.props[f] ?? null;
  if (kindOf(spec) === 'edge') return refTargets(state, f, spec).length ? 'linked' : state.props[f] ?? null;
  return state.props[f] ?? null;
}

// The merge rule for one field: null when the write may go ahead, else the reason it is skipped.
function blocked(spec, by, value, current, prov, force) {
  if (by === 'owner') return null;
  if (!spec.by.includes(BY_CODE[by])) return `not a ${by} field`;
  if (empty(value)) return 'empty value';
  const owners = prov ? prov.by === 'owner' || prov.status === 'reviewed' : !empty(current);
  if (owners) return 'owner value';
  if (!empty(current) && !(force && prov && prov.by === by)) return 'already filled';
  return null;
}

const rowOf = (rec) => ({ labels: rec.get('labels'), props: db.plain(rec.get('props')), out: db.plain(rec.get('out')), inc: db.plain(rec.get('inc')) });

// write(key, input, { by, model, confidence, force, create, provenance }) -> { key, created, filled, skipped, warnings }
// create: { collection } makes the node first (409 if the key exists). provenance: extra entries to record as given.
async function write(key, rawInput, opts = {}) {
  const by = opts.by || 'owner';
  if (!BY_CODE[by]) throw new HttpError(400, `by must be one of ${Object.keys(BY_CODE).join(', ')}`);
  // confidence: one level for every field, or {field: level}
  const confs = opts.confidence == null ? [] : typeof opts.confidence === 'object' ? Object.values(opts.confidence) : [opts.confidence];
  if (confs.some((x) => !CONFIDENCE.includes(x))) throw new HttpError(400, `confidence must be one of ${CONFIDENCE.join(', ')}`);
  const confidenceOf = (f) => (opts.confidence && typeof opts.confidence === 'object' ? opts.confidence[f] : opts.confidence) || null;
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) throw new HttpError(400, 'fields must be an object');
  const pre = opts.create ? null : (await db.run(READ, { key }))[0];
  if (!opts.create && !pre) throw new HttpError(404, 'No such item');
  const c = opts.create ? collectionCheck(opts.create.collection) : collectionOfLabels(pre.labels);
  if (!c) throw new HttpError(400, `${key} is not a collection item`);
  const input = normalizeFields(c, rawInput);
  const locked = opts.create || by !== 'owner' ? [] : (types.get(c).locked || []).filter((f) => f in input); // sources still fill them
  if (locked.length) throw new HttpError(400, `${locked.join(', ')} cannot be edited on a ${c}`);
  const fields = specs(c);
  const checked = validate(c, input, { partial: !opts.create });
  if (checked.errors.length) throw new HttpError(400, checked.errors.join('; '), checked);
  const warnings = checked.warnings.filter((w) => !w.startsWith(`not in the ${c} schema`)); // reported below, once, as what was kept

  // resolve vocabulary names only for fields this write may change (so a skipped field never creates nodes)
  const prov0 = pre ? parseJson(pre.props.provenance_json || '{}') || {} : {};
  const refs = {};
  for (const [f, v] of Object.entries(input)) {
    const spec = fields[f];
    if (!spec || kindOf(spec) !== 'edge' || empty(v)) continue;
    if (blocked(spec, by, v, currentValue(pre, f, spec), prov0[f], opts.force)) continue;
    const r = await resolveRefs(spec, v, by, opts.model);
    refs[f] = r.targets; warnings.push(...r.warnings);
  }

  const res = await db.writeTx(async (tx) => {
    let created = false;
    if (opts.create) {
      const label = typeDef(c).label;
      await artifacts.upsertArtifact(tx, { key, label, props: { title: input.title, visibility: input.visibility || 'private' }, links: [] });
      created = true;
    }
    const state = rowOf((await tx.run(READ, { key })).records[0]);
    const prov = parseJson(state.props.provenance_json || '{}') || {};
    const at = new Date().toISOString();
    const sets = {};
    const filled = [];
    const skipped = [];
    const edgeWrites = [];
    const R = reserved(c);
    const unknown = [];
    for (const [f, v] of Object.entries(input)) {
      const spec = fields[f];
      if (!spec) {
        if (fieldsOf(c)[f]) { skipped.push({ field: f, reason: 'set by the hub' }); continue; }
        if (by !== 'owner') { skipped.push({ field: f, reason: 'not in the schema' }); continue; }
        if (!UNKNOWN_NAME.test(f) || R.has(f)) { warnings.push(f === 'status' ? 'status: set your reading status with /api/personal' : `ignored (reserved or not a valid field name): ${f}`); continue; }
        unknown.push(f);
        continue;
      }
      // on create the node holds only what this write put there, so the writer owns those fields
      const why = blocked(spec, by, v, opts.create ? null : currentValue(state, f, spec), opts.create ? undefined : prov[f], opts.force);
      if (why) { skipped.push({ field: f, reason: why }); continue; }
      const kind = kindOf(spec);
      if (kind === 'edge' && !empty(v) && !refs[f]) { skipped.push({ field: f, reason: 'changed while saving, try again' }); continue; }
      if (kind === 'prop') { const cd = codec(c, f); sets[f] = empty(v) ? null : cd ? cd.write(v) : scalar(v); }
      if (kind === 'json') { sets[`${f}_json`] = empty(v) ? null : JSON.stringify(v); sets[f] = null; if (!spec.list) Object.assign(sets, partValues(f, spec, v)); }
      if (kind === 'edge') { edgeWrites.push([f, spec, refs[f] || []]); sets[f] = null; }
      prov[f] = by === 'owner' ? { by: 'owner', at, status: 'reviewed' }
        : { by, at, ...(opts.model ? { model: opts.model } : {}), ...(confidenceOf(f) ? { confidence: confidenceOf(f) } : {}), status: 'auto' };
      filled.push(f);
    }
    for (const f of unknown.slice(0, MAX_UNKNOWN)) { sets[f] = scalar(input[f]); filled.push(f); }
    if (unknown.length > MAX_UNKNOWN) warnings.push(`only the first ${MAX_UNKNOWN} unknown fields were kept`);
    if (unknown.length) warnings.push(`not in the ${c} schema (kept as is): ${unknown.join(', ')}`);
    Object.assign(prov, opts.provenance || {});
    if (opts.create) { // schema defaults for what was not given (a hypothesis starts untested, an item's origin is own)
      for (const [f, spec] of Object.entries(fieldsOf(c))) {
        if (spec.default != null && kindOf(spec) === 'prop' && !(f in input) && !['visibility', 'record_status'].includes(f)) sets[f] = spec.default;
      }
    }
    // values the hub sets itself (an analysis marks the questions it extracts origin: extracted)
    for (const [f, v] of Object.entries(opts.system || {})) if (fieldsOf(c)[f] && fieldsOf(c)[f].by.includes('Sys')) sets[f] = v;
    sets.record_status = needsReview(prov) ? 'auto' : 'reviewed';

    for (const [f, spec, targets] of edgeWrites) {
      const rel = safeRel(spec.rel);
      const L = safeLabel(spec.ref);
      await tx.run(`MATCH (n:Artifact {key:$key})-[r:${rel}]->(t:${L}) WHERE r.field = $field OR r.field IS NULL DELETE r`, { key, field: f });
      const rows = targets.map((t, i) => ({ key: t.key, position: i }));
      if (!rows.length) continue;
      const made = await tx.run(
        `UNWIND $rows AS x MATCH (n:Artifact {key:$key}) MATCH (t:${L} {key:x.key})
         MERGE (n)-[r:${rel}]->(t) SET r.field = $field, r.position = x.position, r.source = 'items', r.by = $by, r.at = $at
         RETURN t.key AS key, coalesce(t.name, t.title) AS name`, { key, rows, field: f, by, at });
      const names = new Map(made.records.map((r) => [r.get('key'), r.get('name')]));
      for (const t of rows) if (!names.has(t.key)) warnings.push(`${f}: ${t.key} not found, skipped`);
      // the text property mirrors the links (the CSL export and older readers use a paper's venue text)
      const mirror = rows.filter((t) => names.has(t.key)).map((t) => names.get(t.key));
      sets[f] = !mirror.length ? null : spec.list ? mirror : mirror[0];
    }
    await tx.run('MATCH (n:Artifact {key:$key}) SET n += $sets, n.provenance_json = $prov, n.updated_at = datetime()', { key, sets, prov: JSON.stringify(prov) });
    return { created, filled, skipped };
  });
  await hooks.emit('afterWrite', { key, type: c, input: {}, created: res.created });
  return { key, created: res.created, filled: res.filled, skipped: res.skipped, warnings };
}

/* ------------------------------------------------------------------ create, update, delete */

const PAPER_MAPPED = ['title', 'doi', 'authors', 'date', 'year', 'venue', 'url', 'abstract', 'item_type', 'visibility'];
const nameOf = (x) => (x && typeof x === 'object' ? x.name : x);

// body: { collection, fields, slug?, file_url?, copy_to_drive? }
async function create(body) {
  const c = collectionCheck(body && body.collection);
  const fields = body.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new HttpError(400, 'fields must be an object');
  if (c === 'paper') return createPaper(fields, body);
  const withTitle = deriveTitle(c, fields);
  const { errors } = validate(c, withTitle);
  if (errors.length) throw new HttpError(400, errors.join('; '));
  const slug = slugify(body.slug || withTitle.title);
  if (!slug) throw new HttpError(400, 'could not derive a key from the title');
  return write(keyPrefix(c) + slug, withTitle, { by: 'owner', create: { collection: c } });
}

// Papers go through the paper writer (DOI lookup, authors as Person nodes, file link); the rest through write().
async function createPaper(fields, body) {
  const f = fields;
  const cd = codec('paper', 'item_type');
  const input = {
    title: f.title, DOI: f.doi, creators: (Array.isArray(f.authors) ? f.authors : f.authors ? [f.authors] : []).map(nameOf),
    date: f.date || (f.year != null ? String(f.year) : undefined), publicationTitle: nameOf(f.venue), url: f.url, abstractNote: f.abstract,
    itemType: f.item_type ? cd.write(f.item_type) : undefined, tags: f.visibility === 'public' ? ['public'] : [],
    file_url: body.file_url, copy_to_drive: body.copy_to_drive,
  };
  const added = await artifacts.add('paper', Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)));
  const at = new Date().toISOString();
  const node = await get(added.key);
  const provenance = {};
  for (const m of PAPER_MAPPED) {
    if (m in f) provenance[m] = { by: 'owner', at, status: 'reviewed' };
    else if (!empty(node.fields[m])) provenance[m] = { by: 'source', at, status: 'auto' }; // filled by the DOI lookup
  }
  const rest = Object.fromEntries(Object.entries(f).filter(([k]) => !PAPER_MAPPED.includes(k)));
  const out = await write(added.key, rest, { by: 'owner', provenance });
  return { ...out, created: added.created, filled: [...PAPER_MAPPED.filter((m) => m in f), ...out.filled], warnings: [...(added.warnings || []), ...out.warnings], ...pick(added, ['file_url', 'file_error']) };
}

async function update(key, fields, opts = {}) {
  return write(key, fields, { by: 'owner', ...opts });
}

async function remove(key) {
  await get(key); // 404 for anything that is not a collection item
  return artifacts.remove(key);
}

/* ------------------------------------------------------------------ links */

const relName = (rel) => {
  const r = String(rel || '');
  const up = schema.relations[r.toLowerCase()] || r.toUpperCase();
  if (!relationTypes.has(up)) throw new HttpError(400, `Unknown relation "${rel}"`);
  return up;
};

async function targetKey(target) {
  if (typeof target === 'string' && target.includes(':')) return target;
  if (target && typeof target === 'object' && target.key) return String(target.key);
  if (target && typeof target === 'object' && target.kind && target.name) return (await vocab.resolve(target.kind, target.name, { by: 'owner' })).key;
  throw new HttpError(400, 'target must be a key ("method:x", "concept:y") or {kind, name}');
}

// body: { rel, target, evidence?, location?, confidence? }
// A relation's own properties (TESTS has `result`): from the request, checked against relation_types.<rel>.props.
function relationProps(rel, body) {
  const props = {};
  for (const [k, ps] of Object.entries(schema.relation_types[rel].props || {})) {
    const v = body[k];
    if (v == null || v === '') { if (ps.required) return { error: `${rel} needs ${k}${ps.enum ? ` (${ps.enum.join(', ')})` : ''}` }; continue; }
    if (ps.type === 'enum' && !ps.enum.includes(v)) return { error: `${k} must be one of ${ps.enum.join(', ')}` };
    if (ps.type === 'text' && (typeof v !== 'string' || v.length > 500)) return { error: `${k} must be text of at most 500 characters` };
    if (ps.type === 'integer' && !Number.isInteger(v)) return { error: `${k} must be a whole number` };
    props[k] = v;
  }
  return { props };
}

async function link(key, body = {}) {
  const rel = relName(body.rel);
  const spec = schema.relation_types[rel];
  for (const [k, max] of [['evidence', 2000], ['location', 200]]) {
    if (body[k] != null && (typeof body[k] !== 'string' || body[k].length > max)) throw new HttpError(400, `${k} must be text of at most ${max} characters`);
  }
  if (body.confidence != null && !CONFIDENCE.includes(body.confidence)) throw new HttpError(400, `confidence must be one of ${CONFIDENCE.join(', ')}`);
  const item = await get(key);
  const tkey = await targetKey(body.target);
  const [t] = await db.run('MATCH (t {key:$k}) RETURN labels(t) AS labels', { k: tkey });
  if (!t) throw new HttpError(404, `Target ${tkey} not found`);
  const fromLabel = typeDef(item.collection).label;
  const targets = relTargets(rel, fromLabel);
  if (!targets.length || !t.labels.some((l) => targets.includes(l))) {
    throw new HttpError(400, `${rel} goes from ${spec.from.join('/')} to ${(targets.length ? targets : spec.to).join('/')}, not ${fromLabel} to ${t.labels.filter((l) => l !== 'Artifact').join('/')}`);
  }
  const own = relationProps(rel, body);
  if (own.error) throw new HttpError(400, own.error);
  const props = { evidence: body.evidence ?? null, location: body.location ?? null, confidence: body.confidence ?? null, ...own.props, by: 'owner', at: new Date().toISOString(), status: 'reviewed', source: 'items' };
  const [row] = await db.writeTx(async (tx) => (await tx.run(
    `MATCH (n:Artifact {key:$key}), (t {key:$tkey}) OPTIONAL MATCH (n)-[old:${safeRel(rel)}]->(t)
     WITH n, t, old IS NULL AS fresh MERGE (n)-[r:${safeRel(rel)}]->(t) SET r += $props RETURN fresh`, { key, tkey, props })).records.map((r) => ({ fresh: r.get('fresh') })));
  await hooks.emit('afterWrite', { key, type: item.collection, input: {}, created: false });
  if (rel === 'TESTS') await hypotheses.recompute([tkey]);
  return { key, rel, target: tkey, created: Boolean(row && row.fresh) };
}

async function unlink(key, { rel, target } = {}) {
  const r = relName(rel);
  if (!target) throw new HttpError(400, 'Pass the target key');
  await get(key);
  const [row] = await db.writeTx(async (tx) => (await tx.run(
    `MATCH (n:Artifact {key:$key})-[x:${safeRel(r)}]->(t {key:$target}) WITH collect(x) AS xs FOREACH (x IN xs | DELETE x) RETURN size(xs) AS n`,
    { key, target: String(target) })).records.map((x) => ({ n: db.plain(x.get('n')) })));
  if (!row || !row.n) throw new HttpError(404, 'No such link');
  await hooks.emit('afterWrite', { key, type: null, input: {}, created: false });
  if (r === 'TESTS') await hypotheses.recompute([String(target)]);
  return { key, rel: r, target: String(target), deleted: row.n };
}

/* ------------------------------------------------------------------ listing */

function sortSpec(c, sort) {
  const s = String(sort || '-updated_at');
  const desc = s.startsWith('-');
  const field = desc ? s.slice(1) : s;
  const def = typeDef(c);
  const all = fieldsOf(c);
  const allowed = new Set(['title', 'created_at', 'updated_at', ...(def.list_columns || []).filter((f) => all[f] && kindOf(all[f]) === 'prop' && !all[f].list)]);
  if (!allowed.has(field)) throw new HttpError(400, `sort must be one of ${[...allowed].map((f) => `${f}, -${f}`).join(', ')}`);
  const t = all[field].type;
  const expr = t === 'datetime' ? `coalesce(n.\`${field}\`.epochMillis, 0)` : t === 'integer' ? `coalesce(toInteger(n.\`${field}\`), -999999999)` : `toLower(toString(coalesce(n.\`${field}\`, '')))`;
  return { field, desc, expr };
}

const encodeCursor = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
function decodeCursor(s) {
  const v = parseJson(Buffer.from(String(s), 'base64url').toString('utf8'));
  if (!Array.isArray(v) || v.length !== 2 || typeof v[1] !== 'string') throw new HttpError(400, 'invalid cursor');
  return v;
}

async function filterValues(c, f, spec, raw) {
  const vals = String(raw).split(',').map((x) => x.trim()).filter(Boolean);
  if (kindOf(spec) !== 'edge') { const cd = codec(c, f); return vals.map((v) => (cd ? cd.write(v) : v)); }
  const keys = [];
  for (const v of vals) {
    if (entityLabels.includes(spec.ref) && !v.startsWith(schema.entities[spec.ref].key_prefix)) {
      const r = await vocab.resolve(spec.ref, v, { create: false });
      if (r.key) keys.push(r.key);
    } else keys.push(v);
  }
  return keys;
}

// query: { collection, q, sort, limit, cursor, <filter field>: 'a,b' } -> { collection, items, next_cursor, total }
async function list(query = {}) {
  const c = collectionCheck(query.collection);
  const def = typeDef(c);
  const all = fieldsOf(c);
  const filters = def.filters || [];
  const known = new Set(['collection', 'q', 'sort', 'limit', 'cursor', ...filters]);
  const bad = Object.keys(query).filter((k) => !known.has(k));
  if (bad.length) throw new HttpError(400, `unknown parameter ${bad.join(', ')}; filters for ${c}: ${filters.join(', ')}`);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), MAX_LIMIT);
  const L = safeLabel(def.label);
  const where = [];
  const params = { limit: neo4j.int(limit + 1) };
  for (const f of filters) {
    if (query[f] == null || query[f] === '') continue;
    const spec = all[f];
    const p = `f_${f}`;
    params[p] = await filterValues(c, f, spec, query[f]);
    if (kindOf(spec) === 'edge') where.push(`EXISTS { MATCH (n)-[:${safeRel(spec.rel)}]->(t:${safeLabel(spec.ref)}) WHERE t.key IN $${p} }`);
    else if (spec.list) where.push(`any(x IN coalesce(n.\`${f}\`, []) WHERE x IN $${p})`);
    else where.push(`n.\`${f}\` IN $${p}`);
  }
  if (query.q != null && String(query.q).length > MAX_QUERY) throw new HttpError(400, `q is limited to ${MAX_QUERY} characters`);
  if (query.q && String(query.q).trim()) {
    const lucene = luceneQuery(query.q);
    let keys = null;
    if (lucene) {
      try {
        keys = (await db.run(`CALL db.index.fulltext.queryNodes('artifact_text', $lucene) YIELD node WHERE node:${L} RETURN node.key AS key LIMIT 1000`, { lucene })).map((r) => r.key);
      } catch { keys = null; } // index missing: scan the titles below
    }
    if (keys) { params.qkeys = keys; where.push('n.key IN $qkeys'); }
    else { params.qtext = String(query.q).toLowerCase(); where.push('toLower(coalesce(n.title, \'\')) CONTAINS $qtext'); }
  }
  const base = `MATCH (n:${L})${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  const s = sortSpec(c, query.sort);
  let page = '';
  if (query.cursor) {
    const [cs, ck] = decodeCursor(query.cursor);
    params.cs = cs; params.ck = ck;
    page = s.desc ? 'WHERE s < $cs OR (s = $cs AND n.key < $ck)' : 'WHERE s > $cs OR (s = $cs AND n.key > $ck)';
  }
  const cols = (def.list_columns || []).filter((f) => all[f] && kindOf(all[f]) === 'edge');
  const edgeCols = cols.map((f) => `[(n)-[:${safeRel(all[f].rel)}]->(t:${safeLabel(all[f].ref)}) | {key: t.key, name: t.name}] AS \`e_${f}\``).join(', ');
  const dir = s.desc ? 'DESC' : 'ASC';
  const rows = await db.run(
    `${base} WITH n, ${s.expr} AS s ${page}
     RETURN n.key AS key, s, labels(n) AS labels, properties(n) AS props${edgeCols ? ', ' + edgeCols : ''}
     ORDER BY s ${dir}, n.key ${dir} LIMIT $limit`, params);
  const [{ total } = { total: 0 }] = await db.run(`${base} RETURN count(n) AS total`, params);
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => {
    const out = { key: r.key, title: r.props.title || null, record_status: r.props.record_status || null, updated_at: r.props.updated_at || null };
    for (const f of def.list_columns || []) {
      const spec = all[f];
      if (!spec || f === 'title') continue;
      if (kindOf(spec) === 'edge') {
        const v = (r[`e_${f}`] || []).length ? r[`e_${f}`] : empty(r.props[f]) ? [] : (Array.isArray(r.props[f]) ? r.props[f] : [r.props[f]]).map((name) => ({ key: null, name: String(name) }));
        out[f] = spec.list ? v : v[0] || null;
      } else out[f] = fieldValue({ props: r.props, out: [] }, c, f, spec);
    }
    return out;
  });
  const last = rows[limit - 1];
  return { collection: c, items, total, next_cursor: more && last ? encodeCursor([last.s, last.key]) : null };
}

module.exports = { deriveTitle, normalizeIri, findByTitle, relationProps, slugify, needsReview, partNames, partValues, COLLECTIONS, READ, get, list, create, update, write, remove, link, unlink, toItem, blocked, reserved, relName, kindOf, isSys, empty, encodeCursor, decodeCursor };
