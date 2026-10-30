// Claude's analysis, saved in one call with no approval step (docs/SCHEMA_DESIGN.md, principle 2).
// save() finds or creates the item, fills a paper's source facts from Crossref and OpenAlex server-side, saves Claude's
// fields through items.write (fill empty only, never the owner's or reviewed values, `force` only replaces Claude's own),
// writes typed links with their evidence, and reports what was filled, skipped, still empty and flagged.
// Safety rules: empty beats wrong (nothing is guessed: unknown link targets are skipped, not created), and every finding
// needs a location (findings without one are saved but flagged "ungrounded" and listed by the audit).
const { schema, fieldsOf, keyPrefix, safeRel, entityLabels } = require('./schema');
const { HttpError } = require('./errors');
const db = require('./db');
const items = require('./items');
const vocab = require('./vocab');
const artifacts = require('./artifacts');
const openalex = require('./openalex');
const config = require('./config');
const { resolveDoi } = require('../features/papers/crossref');
const { cleanDoi } = require('../features/papers/item');

const TIERS = { standard: ['core', 'standard'], deep: ['core', 'standard', 'deep'] };
const OPEN_ACCESS = { gold: 'gold', green: 'green', closed: 'closed' }; // OpenAlex's hybrid, bronze, diamond have no equivalent: left empty
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const today = () => new Date().toISOString().slice(0, 10);

function check(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'send a JSON object');
  if (!items.COLLECTIONS.includes(body.collection)) throw new HttpError(400, `collection must be one of ${items.COLLECTIONS.join(', ')}`);
  if (typeof body.model !== 'string' || !body.model.trim()) throw new HttpError(400, 'model is required (the model that did the analysis)');
  if (body.fields != null && (typeof body.fields !== 'object' || Array.isArray(body.fields))) throw new HttpError(400, 'fields must be an object');
  if (body.links != null && !Array.isArray(body.links)) throw new HttpError(400, 'links must be a list');
  if (body.tier != null && !TIERS[body.tier]) throw new HttpError(400, 'tier must be standard or deep');
}

/* ------------------------------------------------------------------ identity */

async function exists(key) { return (await db.run('MATCH (n:Artifact {key:$key}) RETURN n.key AS key', { key })).length > 0; }

// -> { key, created, warnings, doi }
async function findOrCreatePaper(body, fields) {
  const warnings = [];
  const doi = body.doi || fields.doi ? cleanDoi(body.doi || fields.doi).toLowerCase() : null;
  if (doi) {
    const key = 'doi:' + doi;
    if (await exists(key)) return { key, created: false, warnings, doi };
    let found = null;
    try { found = await resolveDoi(doi); } catch (e) { warnings.push(`Crossref: ${e.message}`); }
    if (!found || !found.title) {
      if (!fields.title) throw new HttpError(422, 'Could not look up that DOI at Crossref, and no title was given.');
      warnings.push('Crossref did not return this DOI; created from the title given');
      found = { DOI: doi, title: fields.title };
    }
    const added = await artifacts.add('paper', { ...found, DOI: doi, file_url: body.file_url, copy_to_drive: body.copy_to_drive });
    return { key: added.key, created: true, warnings: [...warnings, ...(added.warnings || []), ...(added.file_error ? [added.file_error] : [])], doi };
  }
  if (!body.url) throw new HttpError(400, 'a paper needs key, doi or url');
  const [byUrl] = await db.run('MATCH (p:Paper {url:$url}) RETURN p.key AS key ORDER BY p.key LIMIT 1', { url: body.url });
  if (byUrl) return { key: byUrl.key, created: false, warnings, doi: null };
  if (!fields.title) throw new HttpError(400, 'a paper without a DOI needs a title');
  const added = await artifacts.add('paper', { title: fields.title, url: body.url, itemType: 'preprint', file_url: body.file_url, copy_to_drive: body.copy_to_drive });
  return { key: added.key, created: true, warnings: added.warnings || [], doi: null };
}

// What Crossref and OpenAlex say, as schema fields written by `source` (refreshing earlier source values, never the owner's).
async function sourceFields(doi, warnings) {
  const out = {};
  if (!doi) return out;
  try {
    const w = await openalex.lookupWork(doi);
    if (w) {
      if (Number.isInteger(w.cited_by_count)) { out.citation_count = w.cited_by_count; out.citation_count_at = today(); }
      const oa = w.open_access && OPEN_ACCESS[w.open_access.oa_status];
      if (oa) out.open_access = oa;
      if (typeof w.language === 'string' && w.language) out.language = w.language;
      const venue = w.primary_location && w.primary_location.source && w.primary_location.source.display_name;
      if (venue) out._openalex_venue = venue;
      if (w.id) out._openalex_id = String(w.id).split('/').pop();
    } else warnings.push('OpenAlex does not know this DOI');
  } catch (e) { warnings.push(`OpenAlex: ${e.message}`); }
  return out;
}

/* ------------------------------------------------------------------ links */

async function findTarget(link, toLabels) {
  const t = link.target;
  if (typeof t === 'string' && t.includes(':') && (await db.run('MATCH (n {key:$k}) RETURN n.key AS key', { k: t })).length) return { key: t };
  const name = typeof t === 'object' && t ? t.name : t;
  if (typeof name !== 'string' || !name.trim()) return { skip: 'target must be a key or a name' };
  const kind = link.kind || (typeof t === 'object' && t ? t.kind : null);
  const vocabTo = toLabels.filter((l) => entityLabels.includes(l));
  const label = kind ? (entityLabels.find((l) => l.toLowerCase() === String(kind).toLowerCase())
    || toLabels.find((l) => l.toLowerCase() === String(kind).toLowerCase().replace(/_/g, ''))) : vocabTo.length === 1 ? vocabTo[0] : null;
  if (label && entityLabels.includes(label)) {
    if (!toLabels.includes(label)) return { skip: `${label} is not a valid target` };
    return { key: (await vocab.resolve(label, name, { by: 'claude', model: link.model })).key, vocab: true };
  }
  // another item: an exact title only, never created from a name
  const labels = label ? [label] : toLabels.filter((l) => !entityLabels.includes(l));
  if (!labels.length) return { skip: `pass kind: one of ${vocabTo.join(', ')}` };
  const rows = await db.run('MATCH (n:Artifact) WHERE any(l IN labels(n) WHERE l IN $labels) AND toLower(n.title) = toLower($name) RETURN n.key AS key LIMIT 2', { labels, name: name.trim() });
  if (rows.length === 1) return { key: rows[0].key };
  return { skip: rows.length ? `"${name}" matches more than one item; pass its key` : `no ${labels.join('/')} titled "${name}"; pass a key` };
}

async function saveLinks(key, fromLabel, links, { model, force }) {
  const done = [];
  const skipped = [];
  const flagged = [];
  for (const [i, l] of links.entries()) {
    const label = `links[${i}]`;
    try {
      if (!l || typeof l !== 'object') { skipped.push({ link: label, reason: 'expected {rel, target, ...}' }); continue; }
      const rel = items.relName(l.rel);
      const spec = schema.relation_types[rel];
      if (!spec.from.includes(fromLabel)) { skipped.push({ link: label, rel, reason: `${rel} does not start at a ${fromLabel}` }); continue; }
      if (l.confidence != null && !['low', 'medium', 'high'].includes(l.confidence)) { skipped.push({ link: label, rel, reason: 'confidence must be low, medium or high' }); continue; }
      const evidence = typeof l.evidence === 'string' ? l.evidence.trim().slice(0, 2000) : '';
      if (spec.interpretive && !evidence) { skipped.push({ link: label, rel, reason: `${rel} is interpretive: it needs the justifying passage as evidence` }); continue; }
      const target = await findTarget({ ...l, model }, spec.to);
      if (target.skip) { skipped.push({ link: label, rel, reason: target.skip }); continue; }
      const [t] = await db.run('MATCH (t {key:$k}) RETURN labels(t) AS labels', { k: target.key });
      if (!t || !t.labels.some((x) => spec.to.includes(x))) { skipped.push({ link: label, rel, target: target.key, reason: `${rel} cannot point to that` }); continue; }
      const [old] = await db.run(`MATCH (:Artifact {key:$key})-[r:${safeRel(rel)}]->({key:$t}) RETURN properties(r) AS r`, { key, t: target.key });
      if (old && (old.r.by === 'owner' || old.r.status === 'reviewed' || (old.r.by == null && old.r.source !== 'analysis'))) { skipped.push({ link: label, rel, target: target.key, reason: 'owner link' }); continue; }
      if (old && !force) { skipped.push({ link: label, rel, target: target.key, reason: 'already linked' }); continue; }
      const location = typeof l.location === 'string' && l.location.trim() ? l.location.trim().slice(0, 200) : null;
      const props = { evidence: evidence || null, location, confidence: l.confidence || 'medium', by: 'claude', model, at: new Date().toISOString(), status: 'auto', source: 'analysis' };
      await db.writeTx((tx) => tx.run(`MATCH (n:Artifact {key:$key}), (t {key:$t}) MERGE (n)-[r:${safeRel(rel)}]->(t) SET r += $props`, { key, t: target.key, props }));
      done.push({ rel, target: target.key });
      if (spec.interpretive && !location) flagged.push({ link: label, rel, target: target.key, reason: 'ungrounded: interpretive link without a location' });
    } catch (e) {
      if (!e.status || e.status >= 500) throw e;
      skipped.push({ link: label, reason: e.message });
    }
  }
  return { done, skipped, flagged };
}

/* ------------------------------------------------------------------ save */

// body: { collection, key? | doi? | url?, fields, links, model, tier?, confidence? (level or {field: level}), force?, file_url?, copy_to_drive? }
async function save(body) {
  check(body);
  const c = body.collection;
  const fields = { ...(body.fields || {}) };
  // confidence: one level, or {field: level} with medium for the fields it does not name
  const confidence = body.confidence && typeof body.confidence === 'object'
    ? { ...Object.fromEntries(Object.keys(fields).map((f) => [f, 'medium'])), ...body.confidence } : body.confidence ?? 'medium';
  const opts = { by: 'claude', model: body.model.trim(), confidence, force: Boolean(body.force) };
  const warnings = [];
  let key;
  let created = false;
  let doi = null;
  let result = { filled: [], skipped: [], warnings: [] };

  if (body.key) {
    const item = await items.get(body.key);
    if (item.collection !== c) throw new HttpError(400, `${body.key} is a ${item.collection}, not a ${c}`);
    key = item.key;
    doi = c === 'paper' && item.fields.doi ? item.fields.doi : null;
  } else if (c === 'paper') {
    const p = await findOrCreatePaper(body, fields);
    ({ key, created, doi } = p);
    warnings.push(...p.warnings);
  } else {
    if (typeof fields.title !== 'string' || !fields.title.trim()) throw new HttpError(400, `a new ${c} needs a title (or pass key)`);
    key = keyPrefix(c) + slugify(fields.title);
    if (!(await exists(key))) {
      result = await items.write(key, fields, { ...opts, create: { collection: c } });
      created = true;
    }
  }

  if (c === 'paper') {
    // source facts first, so Claude's values never take a field a source can fill
    const src = await sourceFields(doi, warnings);
    const { _openalex_venue: oaVenue, _openalex_id: oaId, ...facts } = src;
    if (created) {
      const node = await items.get(key);
      const at = new Date().toISOString();
      const provenance = Object.fromEntries(Object.entries(node.fields).filter(([f, v]) => !items.empty(v) && !['tags', 'visibility'].includes(f)).map(([f]) => [f, { by: 'source', at, status: 'auto' }]));
      await items.write(key, {}, { by: 'source', provenance });
    }
    const venueName = (await items.get(key)).fields.venue?.name || oaVenue;
    if (venueName) facts.venue = venueName; // becomes a Venue node (PUBLISHED_IN)
    if (Object.keys(facts).length) {
      const r = await items.write(key, facts, { by: 'source', force: true }); // source refreshes its own values only
      warnings.push(...r.warnings);
    }
    if (oaId) await db.writeTx((tx) => tx.run('MATCH (p:Paper {key:$key}) WHERE p.openalex_id IS NULL SET p.openalex_id = $id', { key, id: oaId }));
    delete fields.doi;
  }

  if (!(created && c !== 'paper')) result = await items.write(key, fields, opts);
  warnings.push(...result.warnings);

  const flagged = [];
  if (Array.isArray(fields.key_findings) && result.filled.includes('key_findings')) {
    fields.key_findings.forEach((k, index) => {
      if (!k || typeof k !== 'object' || typeof k.location !== 'string' || !k.location.trim()) flagged.push({ field: 'key_findings', index, text: k && k.text, reason: 'ungrounded: no location' });
    });
  }
  const fromLabel = schema.types[c].label;
  const linked = await saveLinks(key, fromLabel, body.links || [], { model: opts.model, force: opts.force });
  flagged.push(...linked.flagged);

  const item = await items.get(key);
  const tiers = TIERS[body.tier || 'standard'];
  const empty = Object.entries(fieldsOf(c))
    .filter(([f, spec]) => !items.isSys(spec) && f !== 'record_status' && tiers.includes(spec.tier) && items.empty(item.fields[f]))
    .map(([f]) => f);
  return {
    key, url: `${config.get().base}/library?key=${encodeURIComponent(key)}`, created,
    filled: result.filled, skipped: result.skipped, links: linked.done, links_skipped: linked.skipped,
    empty_core_standard: empty, warnings, flagged,
  };
}

module.exports = { save, findTarget, TIERS };
