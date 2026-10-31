// Claude's analysis, saved in one call with no approval step (docs/SCHEMA_DESIGN.md, principle 2).
// save() finds or creates the item, fills a paper's source facts from Crossref and OpenAlex server-side, saves Claude's
// fields through items.write (fill empty only, never the owner's or reviewed values, `force` only replaces Claude's own),
// writes typed links with their evidence, and reports what was filled, skipped, still empty and flagged.
// Safety rules: empty beats wrong (nothing is guessed: unknown link targets are skipped, not created), and every finding
// needs a location (findings without one are saved but flagged "ungrounded" and listed by the audit).
const { schema, fieldsOf, keyPrefix, safeRel, entityLabels, relTargets } = require('./schema');
const hypotheses = require('./hypotheses');
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
// Each link and each vocabulary name costs lookups: keep one request bounded.
const MAX_LINKS = 200;
const MAX_FIELDS = 300;
const OPEN_ACCESS = { gold: 'gold', green: 'green', closed: 'closed' }; // OpenAlex's hybrid, bronze, diamond have no equivalent: left empty
const slugify = items.slugify;
// What a paper analysis may extract (Task 8): the collection each list creates or reuses.
const EXTRACT = { frameworks: 'framework', research_questions: 'research_question', hypotheses: 'hypothesis' };
const MAX_EXTRACT = 50;
const today = () => new Date().toISOString().slice(0, 10);

function check(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'send a JSON object');
  if (!items.COLLECTIONS.includes(body.collection)) throw new HttpError(400, `collection must be one of ${items.COLLECTIONS.join(', ')}`);
  if (typeof body.model !== 'string' || !body.model.trim()) throw new HttpError(400, 'model is required (the model that did the analysis)');
  if (body.fields != null && (typeof body.fields !== 'object' || Array.isArray(body.fields))) throw new HttpError(400, 'fields must be an object');
  if (body.links != null && !Array.isArray(body.links)) throw new HttpError(400, 'links must be a list');
  if (body.extract != null) {
    if (body.collection !== 'paper') throw new HttpError(400, 'extract is for paper analyses');
    if (typeof body.extract !== 'object' || Array.isArray(body.extract)) throw new HttpError(400, `extract must be an object with ${Object.keys(EXTRACT).join(', ')}`);
    for (const [k, v] of Object.entries(body.extract)) {
      if (!EXTRACT[k]) throw new HttpError(400, `extract.${k} is not one of ${Object.keys(EXTRACT).join(', ')}`);
      if (!Array.isArray(v)) throw new HttpError(400, `extract.${k} must be a list`);
      if (v.length > MAX_EXTRACT) throw new HttpError(400, `at most ${MAX_EXTRACT} entries in extract.${k}`);
    }
  }
  if (body.tier != null && !TIERS[body.tier]) throw new HttpError(400, 'tier must be standard or deep');
  if ((body.links || []).length > MAX_LINKS) throw new HttpError(400, `at most ${MAX_LINKS} links per analysis`);
  if (Object.keys(body.fields || {}).length > MAX_FIELDS) throw new HttpError(400, `at most ${MAX_FIELDS} fields per analysis`);
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

// One typed link written by Claude: endpoints and relation properties checked, never over an owner link.
// -> { done } | { skipped } (and { flagged } when an interpretive link has no location)
async function saveLink(key, fromLabel, l, { model, force }, label) {
  if (!l || typeof l !== 'object') return { skipped: { link: label, reason: 'expected {rel, target, ...}' } };
  const rel = items.relName(l.rel);
  const spec = schema.relation_types[rel];
  const targets = relTargets(rel, fromLabel);
  if (!targets.length) return { skipped: { link: label, rel, reason: `${rel} does not start at a ${fromLabel}` } };
  if (l.confidence != null && !['low', 'medium', 'high'].includes(l.confidence)) return { skipped: { link: label, rel, reason: 'confidence must be low, medium or high' } };
  const evidence = typeof l.evidence === 'string' ? l.evidence.trim().slice(0, 2000) : '';
  if (spec.interpretive && !evidence) return { skipped: { link: label, rel, reason: `${rel} is interpretive: it needs the justifying passage as evidence` } };
  const own = items.relationProps(rel, l);
  if (own.error) return { skipped: { link: label, rel, reason: own.error } };
  const target = await findTarget({ ...l, model }, targets);
  if (target.skip) return { skipped: { link: label, rel, reason: target.skip } };
  const [t] = await db.run('MATCH (t {key:$k}) RETURN labels(t) AS labels', { k: target.key });
  if (!t || !t.labels.some((x) => targets.includes(x))) return { skipped: { link: label, rel, target: target.key, reason: `${rel} cannot point to that` } };
  const [old] = await db.run(`MATCH (:Artifact {key:$key})-[r:${safeRel(rel)}]->({key:$t}) RETURN properties(r) AS r`, { key, t: target.key });
  if (old && (old.r.by === 'owner' || old.r.status === 'reviewed' || (old.r.by == null && old.r.source !== 'analysis'))) return { skipped: { link: label, rel, target: target.key, reason: 'owner link' } };
  if (old && !force) return { skipped: { link: label, rel, target: target.key, reason: 'already linked' } };
  const location = typeof l.location === 'string' && l.location.trim() ? l.location.trim().slice(0, 200) : null;
  const props = { evidence: evidence || null, location, confidence: l.confidence || 'medium', ...own.props, by: 'claude', model, at: new Date().toISOString(), status: 'auto', source: 'analysis' };
  await db.writeTx((tx) => tx.run(`MATCH (n:Artifact {key:$key}), (t {key:$t}) MERGE (n)-[r:${safeRel(rel)}]->(t) SET r += $props`, { key, t: target.key, props }));
  if (rel === 'TESTS') await hypotheses.recompute([target.key]);
  return { done: { rel, target: target.key }, ...(spec.interpretive && !location ? { flagged: { link: label, rel, target: target.key, reason: 'ungrounded: interpretive link without a location' } } : {}) };
}

async function saveLinks(key, fromLabel, links, opts) {
  const done = [];
  const skipped = [];
  const flagged = [];
  for (const [i, l] of links.entries()) {
    try {
      const r = await saveLink(key, fromLabel, l, opts, `links[${i}]`);
      if (r.done) done.push(r.done);
      if (r.skipped) skipped.push(r.skipped);
      if (r.flagged) flagged.push(r.flagged);
    } catch (e) {
      if (!e.status || e.status >= 500) throw e;
      skipped.push({ link: `links[${i}]`, reason: e.message });
    }
  }
  return { done, skipped, flagged };
}

// A paper analysis may extract the frameworks the paper uses, the research questions it states and the hypotheses it
// tests. Each is matched to an existing item by its exact title (or text, acronym, alias), or created by Claude
// (questions and hypotheses with origin: extracted), then linked: paper FRAMED_BY framework, question ASKED_IN paper,
// paper TESTS hypothesis (with result, evidence, location). -> { frameworks, research_questions, hypotheses, skipped, flagged }
async function extractFromPaper(paperKey, extract, opts) {
  const report = { frameworks: [], research_questions: [], hypotheses: [], skipped: [], flagged: [] };
  for (const [list, coll] of Object.entries(EXTRACT)) {
    for (const [i, entry] of (extract[list] || []).entries()) {
      const at = `extract.${list}[${i}]`;
      try {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { report.skipped.push({ extract: at, reason: 'expected an object of fields' }); continue; }
        const { result, evidence, location, confidence, name, ...rest } = entry;
        const fields = items.deriveTitle(coll, { ...rest, ...(rest.title ? {} : name ? { title: name } : {}) });
        if (typeof fields.title !== 'string' || !fields.title.trim()) { report.skipped.push({ extract: at, reason: `needs ${schema.types[coll].title_from || 'a name'}` }); continue; }
        // a tested hypothesis needs its result and the passage before anything is written (no untested leftovers)
        if (list === 'hypotheses') {
          const why = items.relationProps('TESTS', { result }).error || (typeof evidence === 'string' && evidence.trim() ? null : 'TESTS is interpretive: it needs the justifying passage as evidence');
          if (why) { report.skipped.push({ extract: at, reason: why }); continue; }
        }
        const label = schema.types[coll].label;
        const found = await items.findByTitle(label, fields.title);
        if (found.length > 1) { report.skipped.push({ extract: at, reason: `"${fields.title}" matches more than one ${coll}` }); continue; }
        let key = found[0];
        let created = false;
        if (key) {
          const { title, ...more } = fields; // fill what is empty on the existing item; never rename it
          if (Object.keys(more).length) await items.write(key, more, opts);
        } else {
          key = keyPrefix(coll) + slugify(fields.title);
          if (await exists(key)) { const { title, ...more } = fields; if (Object.keys(more).length) await items.write(key, more, opts); }
          else {
            await items.write(key, fields, { ...opts, create: { collection: coll }, system: schema.types[coll].fields.origin ? { origin: 'extracted' } : {} });
            created = true;
          }
        }
        const link = list === 'frameworks' ? [paperKey, 'Paper', { rel: 'FRAMED_BY', target: key, evidence, location, confidence }]
          : list === 'research_questions' ? [key, 'ResearchQuestion', { rel: 'ASKED_IN', target: paperKey, evidence, location, confidence }]
            : [paperKey, 'Paper', { rel: 'TESTS', target: key, result, evidence, location, confidence }];
        const r = await saveLink(link[0], link[1], link[2], opts, at);
        report[list].push({ key, created, linked: Boolean(r.done) });
        if (r.skipped) report.skipped.push({ extract: at, ...r.skipped });
        if (r.flagged) report.flagged.push(r.flagged);
      } catch (e) {
        if (!e.status || e.status >= 500) throw e;
        report.skipped.push({ extract: at, reason: e.message });
      }
    }
  }
  return report;
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
    Object.assign(fields, items.deriveTitle(c, fields)); // questions and hypotheses: from their text or statement
    if (typeof fields.title !== 'string' || !fields.title.trim()) throw new HttpError(400, `a new ${c} needs a ${schema.types[c].title_from || 'title'} (or pass key)`);
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
  const extracted = body.extract ? await extractFromPaper(key, body.extract, { by: 'claude', model: opts.model, confidence: 'medium', force: opts.force }) : null;
  if (extracted) flagged.push(...extracted.flagged);

  const item = await items.get(key);
  const tiers = TIERS[body.tier || 'standard'];
  const empty = Object.entries(fieldsOf(c))
    .filter(([f, spec]) => !items.isSys(spec) && f !== 'record_status' && tiers.includes(spec.tier) && items.empty(item.fields[f]))
    .map(([f]) => f);
  return {
    key, url: `${config.get().base}/library?key=${encodeURIComponent(key)}`, created,
    filled: result.filled, skipped: result.skipped, links: linked.done, links_skipped: linked.skipped,
    ...(extracted ? { extracted: { frameworks: extracted.frameworks, research_questions: extracted.research_questions, hypotheses: extracted.hypotheses, skipped: extracted.skipped } } : {}),
    empty_core_standard: empty, warnings, flagged,
  };
}

module.exports = { save, findTarget, saveLink, extractFromPaper, TIERS, EXTRACT };
