// The audit: an optional review of what Claude saved. It never blocks use (Claude saves directly); it lists what is worth a
// look, with counts: low-confidence fields and links, empty Core/Standard fields, findings without a location, items below
// their type's current schema_version, and vocabulary nodes Claude created. accept() marks values reviewed, which also
// protects them from re-runs exactly like the owner's own edits.
const { schema, fieldsOf, entityLabels, safeRel } = require('./schema');
const { HttpError } = require('./errors');
const db = require('./db');
const items = require('./items');

const ALL_ITEMS = `MATCH (n:Artifact) WHERE n.collection IS NOT NULL
  RETURN labels(n) AS labels, properties(n) AS props,
    [(n)-[r]->(t) | {rel: type(r), r: properties(r), key: t.key, name: coalesce(t.name, t.title), labels: labels(t)}] AS out, [] AS inc
  ORDER BY n.key`;

const located = (k) => k && typeof k === 'object' && typeof k.location === 'string' && k.location.trim();

// -> { counts, low_confidence, low_confidence_links, empty_fields, ungrounded, outdated, vocab_by_claude, unreviewed_items }
async function report({ limit = 200 } = {}) {
  const max = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const lists = { low_confidence: [], low_confidence_links: [], empty_fields: [], ungrounded: [], outdated: [], unreviewed_items: [] };
  for (const row of await db.run(ALL_ITEMS)) {
    const it = items.toItem(row);
    if (!it) continue;
    const head = { key: it.key, title: it.fields.title, collection: it.collection };
    if (it.record_status !== 'reviewed') lists.unreviewed_items.push(head);
    for (const [field, p] of Object.entries(it.provenance)) {
      if (p && p.by === 'claude' && p.status === 'auto' && p.confidence === 'low') lists.low_confidence.push({ ...head, field, model: p.model || null, at: p.at || null });
    }
    for (const l of it.links.out) {
      const interpretive = schema.relation_types[l.rel] && schema.relation_types[l.rel].interpretive;
      if (l.by === 'claude' && l.status === 'auto' && (l.confidence === 'low' || (interpretive && !l.location))) {
        lists.low_confidence_links.push({ ...head, rel: l.rel, target: l.key, confidence: l.confidence || null, location: l.location || null, evidence: l.evidence || null });
      }
    }
    const empty = Object.entries(fieldsOf(it.collection))
      .filter(([f, spec]) => !items.isSys(spec) && f !== 'record_status' && ['core', 'standard'].includes(spec.tier) && items.empty(it.fields[f]))
      .map(([f, spec]) => ({ field: f, tier: spec.tier }));
    if (empty.length) lists.empty_fields.push({ ...head, fields: empty });
    (Array.isArray(it.fields.key_findings) ? it.fields.key_findings : []).forEach((k, index) => {
      if (!located(k)) lists.ungrounded.push({ ...head, field: 'key_findings', index, text: k && k.text });
    });
    const current = schema.types[it.collection].schema_version;
    if ((it.schema_version || 0) < current) lists.outdated.push({ ...head, schema_version: it.schema_version, current });
  }
  const vocab = await db.run(
    `MATCH (v) WHERE any(l IN labels(v) WHERE l IN $labels) AND v.by = 'claude' AND coalesce(v.record_status, 'auto') = 'auto'
     RETURN v.key AS key, v.name AS name, [l IN labels(v) WHERE l IN $labels][0] AS label, v.model AS model, size([(v)--() | 1]) AS uses ORDER BY v.key`,
    { labels: entityLabels });
  const all = { ...lists, vocab_by_claude: vocab };
  const counts = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.length]));
  return { counts, ...Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.slice(0, max)])), truncated: Object.values(all).some((v) => v.length > max) };
}

// body: { key, fields?: [..] (default: every field still auto), links?: [{rel, target}] } or { vocab: key }
async function accept(body = {}) {
  const at = new Date().toISOString();
  if (body.vocab) {
    const rows = await db.writeTx(async (tx) => (await tx.run(
      'MATCH (v {key:$key}) WHERE any(l IN labels(v) WHERE l IN $labels) SET v.record_status = \'reviewed\', v.reviewed_at = $at RETURN v.key AS key',
      { key: String(body.vocab), labels: entityLabels, at })).records);
    if (!rows.length) throw new HttpError(404, 'No such vocabulary node');
    return { vocab: String(body.vocab), record_status: 'reviewed' };
  }
  if (!body.key) throw new HttpError(400, 'Pass key (an item) or vocab (a vocabulary node)');
  if (body.fields != null && !Array.isArray(body.fields)) throw new HttpError(400, 'fields must be a list');
  if (body.links != null && !Array.isArray(body.links)) throw new HttpError(400, 'links must be a list of {rel, target}');
  await items.get(body.key); // 404 / not a collection item
  return db.writeTx(async (tx) => {
    const res = await tx.run('MATCH (n:Artifact {key:$key}) RETURN n.provenance_json AS p', { key: body.key });
    const prov = JSON.parse(res.records[0].get('p') || '{}');
    const wanted = body.fields || Object.keys(prov).filter((f) => prov[f] && prov[f].status === 'auto');
    const accepted = [];
    const missing = [];
    for (const f of wanted) {
      if (!prov[f]) { missing.push(f); continue; }
      prov[f] = { ...prov[f], status: 'reviewed', reviewed_at: at };
      accepted.push(f);
    }
    const remaining = Object.values(prov).filter((p) => p && p.status === 'auto').length;
    await tx.run(
      `MATCH (n:Artifact {key:$key}) SET n.provenance_json = $prov ${remaining ? '' : ", n.record_status = 'reviewed'"}`,
      { key: body.key, prov: JSON.stringify(prov) });
    let links = 0;
    for (const l of body.links || []) {
      const rel = items.relName(l && l.rel);
      const r = await tx.run(`MATCH (:Artifact {key:$key})-[x:${safeRel(rel)}]->({key:$t}) SET x.status = 'reviewed', x.reviewed_at = $at RETURN count(x) AS c`, { key: body.key, t: String(l.target), at });
      links += db.plain(r.records[0].get('c'));
    }
    return { key: body.key, accepted, not_found: missing, links, record_status: remaining ? 'auto' : 'reviewed' };
  });
}

module.exports = { report, accept };
