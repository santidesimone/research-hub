// Integration test against a REAL Neo4j (CI runs it in a container). Locally:
//   NEO4J_URI=bolt://localhost:7687 NEO4J_PASSWORD=hubpassword npm run test:integration
// It uses unique keys and removes everything it creates. Exits non-zero on any failure.
const assert = require('assert');
const db = require('../core/db');
const migrate = require('../core/migrate');
const artifacts = require('../core/artifacts');
const notes = require('../core/notes');
const backup = require('../core/backup');
const query = require('../core/query');
const publicExport = require('../core/public-export');
const files = require('../features/papers/files');
const vocab = require('../core/vocab');
const items = require('../core/items');
const analysis = require('../core/analysis');
const audit = require('../core/audit');
const crossref = require('../features/papers/crossref');
const openalex = require('../core/openalex');

// This test prunes Markdown-sourced notes and restores a backup, so it must never run against a database that holds your real library.
if (process.env.HUB_INTEGRATION !== '1') {
  console.error('Refusing to run: this test changes data. Point NEO4J_URI at a throwaway database and set HUB_INTEGRATION=1.');
  process.exit(2);
}

const stamp = Date.now();
const DRIVE_ID = 'ItTest' + stamp.toString(36).padEnd(12, 'x');

(async () => {
  await db.exec('RETURN 1 AS ok');
  const ran = await migrate.run();
  console.log('migrations applied this run:', ran.join(', ') || '(none, already up to date)');
  assert.ok((await migrate.applied()).includes('011_frameworks_questions_ontologies'));
  await db.exec('CALL db.awaitIndexes(60)');

  // paper with a Drive share link: stored canonically, nothing downloaded
  const doi = `10.9999/it-${stamp}`;
  const paperKey = 'doi:' + doi;
  const added = await artifacts.add('paper', {
    DOI: doi, title: 'Integration Test of Untraceable Payments', creators: ['Ada Lovelace'], date: '2024', abstractNote: 'secret abstract text',
    tags: ['topic:integration-testing', 'public'], file_url: `https://drive.google.com/open?id=${DRIVE_ID}`,
  });
  assert.equal(added.created, true);
  assert.equal(added.file_url, `https://drive.google.com/file/d/${DRIVE_ID}/view`);
  const [row] = await db.run('MATCH (p:Paper {key:$k}) RETURN p.file_url AS url, p.drive_file_id AS id', { k: paperKey });
  assert.equal(row.url, added.file_url); assert.equal(row.id, null, 'a plain link is not a hub-owned Drive file');
  await files.setLink(paperKey, 'https://arxiv.org/pdf/0000.00000');
  assert.equal((await files.paperRow(paperKey)).file_url, 'https://arxiv.org/pdf/0000.00000');
  await assert.rejects(() => files.setLink(paperKey, 'javascript:alert(1)'), (e) => e.status === 400);

  // ranked full-text search (and topic match)
  const hit = await query.searchPapers('untraceable pay');
  assert.ok(hit.rows.some((r) => r.key === paperKey), 'full-text search finds the paper');
  const topic = await query.searchPapers('integration-testing');
  assert.ok(topic.rows.some((r) => r.key === paperKey), 'topic search finds the paper');

  // read-only guard on the real server
  const ok = await query.readOnly('MATCH (n) RETURN count(n) AS c');
  assert.equal(ok.rows.length, 1);
  await assert.rejects(() => query.readOnly('CREATE (n:Hack {x:1}) RETURN n'), /read-only/i);
  await assert.rejects(() => query.readOnly('MATCH (n:Paper) DETACH DELETE n'), /read-only/i);

  // schema v3: seeded domains, database-managed method with validator warnings and unknown fields kept
  const domains = await db.run("MATCH (d:Domain) WHERE d.seeded RETURN d.key AS key");
  assert.ok(domains.length >= 10 && domains.some((d) => d.key === 'domain:digital-currency'));
  const method = await artifacts.add('method', { title: `Method B ${stamp}`, slug: `it-${stamp}-b`, level: 'technique', kind: 'technique', visibility: 'public', mood: 'kept' });
  assert.ok(method.warnings.some((w) => w.startsWith('level:')));
  const [mrow] = await db.run('MATCH (m:Method {key:$k}) RETURN m.managed AS managed, m.collection AS c, m.record_status AS rs, m.mood AS mood, m.source AS source', { k: `method:it-${stamp}-b` });
  assert.deepEqual(mrow, { managed: 'db', c: 'method', rs: 'auto', mood: 'kept', source: 'hub' });
  const useCase = await artifacts.add('use_case', { title: `Offline payments ${stamp}`, actors: [{ role: 'payer' }], status: 'idea' });
  assert.equal(useCase.key, `usecase:offline-payments-${stamp}`);
  const [ft] = await db.run("SHOW FULLTEXT INDEXES YIELD name, labelsOrTypes WHERE name = 'artifact_text' RETURN labelsOrTypes");
  assert.ok(ft.labelsOrTypes.includes('UseCase') && ft.labelsOrTypes.includes('CaseStudy'));

  // vocabulary matcher: the brief's variants, 20 parallel calls with mixed spellings, full-text typo lookup
  // letters a-p only: no trailing "s", which term normalisation would singularise away
  const tag = 'it' + [...stamp.toString(16)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  const spellings = [`Zero-knowledge proof ${tag}`, `ZK proofs ${tag}`, `zero knowledge proofs ${tag}`, `ZERO KNOWLEDGE PROOF ${tag}`, `ZKP ${tag}`];
  const parallel = await Promise.all(Array.from({ length: 20 }, (_, i) => vocab.resolve('Topic', spellings[i % spellings.length], { model: 'it-model' })));
  const topicNodes = await db.run('MATCH (t:Topic) WHERE t.norm ENDS WITH $tag RETURN t.key AS key, t.by AS by, t.model AS model, t.aliases AS aliases', { tag });
  assert.equal(topicNodes.length, 1, `parallel calls created ${topicNodes.length} nodes: ${topicNodes.map((t) => t.key).join(', ')}`);
  assert.equal(new Set(parallel.map((r) => r.key)).size, 1); assert.equal(parallel.filter((r) => r.created).length, 1);
  assert.deepEqual([topicNodes[0].by, topicNodes[0].model], ['claude', 'it-model']);
  for (const v of spellings) assert.equal((await vocab.resolve('Topic', v)).key, topicNodes[0].key, v);
  assert.ok(topicNodes[0].aliases.length >= 1, 'non-exact spellings were learnt as aliases');
  const crypto1 = await vocab.resolve('Concept', `Cryptographic accumulators ${tag}`);
  const typoed = await vocab.resolve('Concept', `Cryptogrphic accumulators ${tag}`, { create: false });
  assert.deepEqual([typoed.key, typoed.match], [crypto1.key, 'typo'], 'found through the vocab_text full-text index');
  assert.equal((await vocab.resolve('Concept', `Homomorphic encryption ${tag}`, { create: false })).key, null);
  assert.equal((await db.run('MATCH (c:Concept) WHERE c.norm CONTAINS $tag RETURN count(c) AS c', { tag }))[0].c, 1, 'create:false wrote nothing');
  // nodes written by the paper writer are found: authors were stamped with norm on write
  assert.deepEqual(await vocab.resolve('Person', 'Lovelace, Ada', { create: false }), { key: 'person:ada-lovelace', name: 'Ada Lovelace', created: false, match: 'exact' });
  await db.exec('MATCH (n) WHERE (n:Topic OR n:Concept) AND n.norm ENDS WITH $tag DETACH DELETE n', { tag });

  // items API: CRUD for all four collections, merge rules, links, filters, pagination
  const T = (x) => `${x} ${tag}`;
  const ip = await items.create({ collection: 'paper', fields: { title: T('Items paper'), authors: ['Grace Hopper'], year: 2021, item_type: 'preprint', contribution_type: 'empirical', key_findings: [{ text: 'f1', location: 'p. 2' }] } });
  const im = await items.create({ collection: 'method', fields: { title: T('Items method'), kind: 'technique', domain: ['payments'], procedure: ['a', 'b'] } });
  const iu = await items.create({ collection: 'use_case', fields: { title: T('Items use case'), status: 'idea', actors: [{ role: 'payer' }], domain: ['CBDC'] } });
  const ic = await items.create({ collection: 'case_study', fields: { title: T('Items case'), case_type: 'pilot', organisations: [T('Org B'), T('Org A')], outcomes: [{ measure: 'uptake', expected: true }] } });
  const gp = await items.get(ip.key);
  assert.deepEqual([gp.fields.item_type, gp.fields.year, gp.fields.contribution_type, gp.fields.authors[0].name], ['preprint', 2021, 'empirical', 'Grace Hopper']);
  assert.deepEqual(gp.fields.key_findings, [{ text: 'f1', location: 'p. 2' }]);
  assert.deepEqual((await items.get(im.key)).fields.domain, [{ key: 'domain:payments', name: 'payments' }], 'names link to the seeded Domains');
  assert.deepEqual((await items.get(iu.key)).fields.domain.map((d) => d.key), ['domain:digital-currency'], 'an alias of a seeded Domain');
  assert.deepEqual((await items.get(iu.key)).fields.actors, [{ role: 'payer' }]);
  const gc = await items.get(ic.key);
  assert.deepEqual(gc.fields.organisations.map((o) => o.name), [T('Org B'), T('Org A')]); assert.deepEqual(gc.fields.outcomes, [{ measure: 'uptake', expected: true }]);
  // owner edits survive Claude; Claude fills empty fields; force only replaces Claude's own values
  await items.update(im.key, { purpose: 'owner purpose' });
  const cw = await items.write(im.key, { purpose: 'claude purpose', when_to_use: 'claude when', topics: [T('Sampling topic')] }, { by: 'claude', model: 'it-model', confidence: 'low' });
  assert.deepEqual(cw.skipped, [{ field: 'purpose', reason: 'owner value' }]); assert.deepEqual(cw.filled, ['when_to_use', 'topics']);
  assert.equal((await items.write(im.key, { when_to_use: 'claude v2' }, { by: 'claude', force: true })).filled[0], 'when_to_use');
  const gm = await items.get(im.key);
  assert.deepEqual([gm.fields.purpose, gm.fields.when_to_use, gm.provenance.when_to_use.model, gm.provenance.purpose.by], ['owner purpose', 'claude v2', undefined, 'owner']);
  assert.equal((await db.run('MATCH (t:Topic) WHERE t.norm CONTAINS $tag RETURN t.by AS by', { tag }))[0].by, 'claude');
  await assert.rejects(() => items.update(ip.key, { doi: '10.1/x' }), (e) => e.status === 400);
  // typed links
  assert.equal((await items.link(im.key, { rel: 'ADDRESSES', target: iu.key, evidence: 'why', location: 's. 1', confidence: 'medium' })).created, true);
  await assert.rejects(() => items.link(im.key, { rel: 'ADDRESSES', target: ic.key }), (e) => e.status === 400);
  assert.ok((await items.get(iu.key)).links.in.some((l) => l.rel === 'ADDRESSES' && l.key === im.key && l.evidence === 'why'));
  assert.equal((await items.unlink(im.key, { rel: 'ADDRESSES', target: iu.key })).deleted, 1);
  // list: filters, full-text q, every page of a cursor walk
  for (const n of ['e', 'c', 'a', 'd', 'b']) await items.create({ collection: 'method', fields: { title: T(`Pager ${n}`), kind: n === 'c' ? 'tool' : 'metric', domain: n === 'a' ? ['payments'] : [] } });
  const want = ['a', 'b', 'c', 'd', 'e'].map((n) => `method:pager-${n}-${tag}`);
  let cursor = null; const seen = [];
  do { const pg = await items.list({ collection: 'method', q: 'pager', sort: 'title', limit: '2', ...(cursor ? { cursor } : {}) }); seen.push(...pg.items.map((x) => x.key)); cursor = pg.next_cursor; } while (cursor);
  assert.deepEqual(seen.filter((k) => want.includes(k)), want, 'pages in order, nothing skipped or repeated');
  assert.equal(seen.length, new Set(seen).size);
  const byKind = await items.list({ collection: 'method', kind: 'tool', q: 'pager' });
  assert.deepEqual(byKind.items.map((x) => x.key), [`method:pager-c-${tag}`]);
  const byDomain = await items.list({ collection: 'method', domain: 'Payments', q: tag });
  assert.deepEqual(byDomain.items.map((x) => x.key).sort(), [im.key, `method:pager-a-${tag}`].sort());
  assert.equal((await items.list({ collection: 'paper', item_type: 'preprint', q: tag })).items[0].key, ip.key);
  // delete
  for (const k of [ip.key, im.key, iu.key, ic.key, ...want]) await items.remove(k);
  await assert.rejects(() => items.get(im.key), (e) => e.status === 404);
  await db.exec('MATCH (n) WHERE (n:Topic OR n:Organisation) AND n.norm ENDS WITH $tag DETACH DELETE n', { tag });

  // Claude's analysis end to end (Crossref and OpenAlex answered by fakes, so this stays hermetic), then the design's
  // competency questions 1 and 4 in plain Cypher over what was saved
  const DOIS = { a: `10.7777/a-${tag}`, b: `10.7777/b-${tag}`, c: `10.7777/c-${tag}` };
  const R = (obj, status = 200) => ({ ok: status < 300, status, json: async () => obj });
  crossref.setHttp(async (url) => {
    const k = Object.keys(DOIS).find((x) => url.endsWith(encodeURIComponent(DOIS[x])));
    return k ? R({ message: { type: 'journal-article', title: [T(`CBDC adoption study ${k}`)], DOI: DOIS[k], author: [{ given: 'Grace', family: 'Hopper' }], issued: { 'date-parts': [[2022]] }, 'container-title': [T('Journal of Money')] } }) : R({}, 404);
  });
  openalex.setHttp(async () => R({ id: 'https://openalex.org/W1', cited_by_count: 3, open_access: { oa_status: 'gold' }, language: 'en' }));
  const cbdcTopic = T('CBDC adoption');
  const analyse = (k, design, n) => analysis.save({
    collection: 'paper', doi: DOIS[k], model: 'it-model',
    fields: { contribution_type: 'empirical', research_design: design, evidence: { type: 'survey', n }, key_findings: [{ text: 'uptake rises', location: 's. 5' }], tldr: 'short' },
    links: [{ rel: 'ABOUT', target: cbdcTopic, kind: 'Topic' }],
  });
  const ra = await analyse('a', 'quasi_experiment', 1200);
  await analyse('b', 'quasi_experiment', 40);
  await analyse('c', 'experiment', 5000);
  assert.equal(ra.created, true); assert.deepEqual(ra.flagged, []);
  const pa = await items.get(ra.key);
  assert.deepEqual([pa.fields.title, pa.fields.venue.name, pa.fields.citation_count, pa.fields.open_access, pa.provenance.title.by, pa.provenance.research_design.by], [T('CBDC adoption study a'), T('Journal of Money'), 3, 'gold', 'source', 'claude']);
  const topicKey = (await vocab.resolve('Topic', cbdcTopic, { create: false })).key;
  const q1 = await query.readOnly(
    `MATCH (p:Paper)-[:ABOUT]->(t:Topic {key: $topic})
     WHERE p.contribution_type = 'empirical' AND p.research_design = 'quasi_experiment' AND p.evidence__n > $n
     RETURN p.key AS key`, { topic: topicKey, n: 100 });
  assert.deepEqual(q1.rows.map((r) => r.key), [ra.key], 'competency question 1');
  // idempotent; the owner's edit survives a forced re-run
  const again = await analyse('a', 'quasi_experiment', 1200);
  assert.deepEqual([again.created, again.filled, again.links], [false, [], []]);
  await items.update(ra.key, { research_design: 'observational' });
  const forced = await analysis.save({ collection: 'paper', key: ra.key, model: 'it-model', force: true, fields: { research_design: 'quasi_experiment' } });
  assert.deepEqual(forced.skipped, [{ field: 'research_design', reason: 'owner value' }]);

  const m4 = await analysis.save({ collection: 'method', model: 'it-model', fields: { title: T('Q4 method'), kind: 'technique', purpose: 'p' } });
  const cs4 = await analysis.save({ collection: 'case_study', model: 'it-model', fields: { title: T('Q4 case'), case_type: 'pilot' } });
  const u = {};
  for (const n of ['addressed', 'instanced', 'orphan']) u[n] = (await analysis.save({ collection: 'use_case', model: 'it-model', fields: { title: T(`Q4 ${n}`), goal: 'g' } })).key;
  await analysis.save({ collection: 'method', key: m4.key, model: 'it-model', links: [{ rel: 'ADDRESSES', target: u.addressed }] });
  await analysis.save({ collection: 'case_study', key: cs4.key, model: 'it-model', links: [{ rel: 'INSTANCE_OF', target: u.instanced }] });
  const q4 = await query.readOnly(
    `MATCH (u:UseCase) WHERE u.title ENDS WITH $tag AND NOT (:Method)-[:ADDRESSES]->(u) AND NOT (:CaseStudy)-[:INSTANCE_OF]->(u) RETURN u.key AS key`, { tag });
  assert.deepEqual(q4.rows.map((r) => r.key), [u.orphan], 'competency question 4');
  // the audit sees Claude's vocabulary; accepting removes it
  const au = await audit.report({ limit: 1000 });
  assert.ok(au.vocab_by_claude.some((v) => v.key === topicKey) && au.unreviewed_items.some((x) => x.key === u.orphan));
  await audit.accept({ vocab: topicKey }); await audit.accept({ key: u.orphan });
  const au2 = await audit.report({ limit: 1000 });
  assert.ok(!au2.vocab_by_claude.some((v) => v.key === topicKey) && !au2.unreviewed_items.some((x) => x.key === u.orphan));
  for (const k of [ra.key, `doi:${DOIS.b}`, `doi:${DOIS.c}`, m4.key, cs4.key, ...Object.values(u)]) await items.remove(k);
  await db.exec('MATCH (n) WHERE (n:Topic OR n:Venue) AND n.norm ENDS WITH $tag DETACH DELETE n', { tag });
  crossref.setHttp((url, o) => fetch(url, o)); openalex.setHttp((url, o) => fetch(url, o));

  // backup -> delete -> restore gives back exactly the same graph: all four collections, every vocabulary label,
  // typed links with their evidence, provenance, object parts and the personal layer (Task 7 acceptance)
  {
    const RDOI = `10.8888/rt-${tag}`;
    crossref.setHttp(async (url) => (url.endsWith(encodeURIComponent(RDOI))
      ? R({ message: { type: 'journal-article', title: [T('Round trip paper')], DOI: RDOI, author: [{ given: 'Ada', family: T('Lovelace') }], issued: { 'date-parts': [[2021]] }, 'container-title': [T('Round Trip Journal')] } })
      : R({}, 404)));
    openalex.setHttp(async () => R({ id: 'https://openalex.org/W9', cited_by_count: 7, open_access: { oa_status: 'green' }, language: 'en' }));
    const rm = await items.create({ collection: 'method', fields: { title: T('RT method'), kind: 'technique', domain: ['payments'], procedure: ['a', 'b'] } });
    const ru = await items.create({ collection: 'use_case', fields: { title: T('RT use case'), goal: 'g', actors: [{ role: 'payer' }], visibility: 'public', summary: 's' } });
    const rc = await items.create({ collection: 'case_study', fields: { title: T('RT case'), case_type: 'pilot', organisations: [T('RT Org')], sector: 'payments', period: { from: '2023-01' }, visibility: 'public', sensitivity: 'confidential' } });
    const rp = await analysis.save({ collection: 'paper', doi: RDOI, model: 'rt-model', confidence: { main_claim: 'low' },
      fields: { main_claim: 'c', evidence: { type: 'survey', n: 42 }, key_findings: [{ text: 'k', location: 'p. 1' }] },
      links: [{ rel: 'INTRODUCES', target: rm.key }, { rel: 'ABOUT', target: T('RT topic'), kind: 'Topic' }, { rel: 'USES', target: T('RT dataset'), kind: 'Dataset' }] });
    await items.link(rm.key, { rel: 'ADDRESSES', target: ru.key, evidence: 'why', location: 's. 1', confidence: 'high' });
    await items.link(rc.key, { rel: 'INSTANCE_OF', target: ru.key });
    const concept = await artifacts.add('paper', { title: T('RT tagged paper'), tags: [`topic:rt-concept-${tag}`] });
    await require('../features/personal').setState(rp.key, { status: 'reading' });
    const mine = [rm.key, ru.key, rc.key, rp.key, concept.key];

    // what to compare: these items, everything they link to, their personal nodes, and the relationships among them
    const pick = (dump) => {
      const keys = new Set(mine);
      for (const r of dump.rels) if (mine.includes(r.from)) keys.add(r.to);
      for (const k of mine) keys.add('personal:' + k);
      const nodes = dump.nodes.filter((n) => keys.has(n.props.key)).map((n) => ({ labels: [...n.labels].sort(), props: n.props })).sort((a, b) => (a.props.key < b.props.key ? -1 : 1));
      const rels = dump.rels.filter((r) => keys.has(r.from) && keys.has(r.to)).sort((a, b) => (`${a.from}|${a.type}|${a.to}` < `${b.from}|${b.type}|${b.to}` ? -1 : 1));
      return { nodes, rels };
    };
    const dump = await backup.exportAll();
    const before = pick(dump);
    const labels = new Set(before.nodes.flatMap((n) => n.labels));
    for (const l of ['Paper', 'Method', 'UseCase', 'CaseStudy', 'Person', 'Concept', 'Topic', 'Domain', 'Venue', 'Organisation', 'Dataset', 'Personal']) assert.ok(labels.has(l), `the backup covers ${l}`);
    const relTypes = new Set(before.rels.map((r) => r.type));
    for (const t of ['AUTHORED_BY', 'PUBLISHED_IN', 'ABOUT', 'USES', 'INTRODUCES', 'ADDRESSES', 'INSTANCE_OF', 'INVOLVES', 'FOR']) assert.ok(relTypes.has(t), `the backup covers ${t}`);
    const paperNode = before.nodes.find((n) => n.props.key === rp.key).props;
    assert.ok(paperNode.provenance_json && paperNode.evidence__n === 42 && paperNode.record_status === 'auto');

    // delete all of it (vocabulary included), then restore the whole backup
    await db.exec('UNWIND $keys AS k MATCH (n {key: k}) DETACH DELETE n', { keys: before.nodes.map((n) => n.props.key) });
    assert.equal((await db.run('UNWIND $keys AS k MATCH (n {key: k}) RETURN count(n) AS c', { keys: before.nodes.map((n) => n.props.key) }))[0].c, 0);
    const res = await backup.restore(dump);
    assert.equal(res.rels_skipped, 0);
    const after = pick(await backup.exportAll());
    assert.deepEqual(after, before, 'identical after backup, delete and restore');
    // and timestamps are datetimes again, not text (the items list sorts on updated_at.epochMillis)
    const stamps = await db.run('UNWIND $keys AS k MATCH (n {key: k}) WHERE n.created_at IS NOT NULL RETURN n.key AS key, n.created_at.epochMillis AS c, n.updated_at.epochMillis AS u', { keys: before.nodes.map((n) => n.props.key) });
    assert.ok(stamps.length >= mine.length && stamps.every((x) => Number.isInteger(x.c)), 'created_at restored as a datetime');
    const sorted = await items.list({ collection: 'method', q: tag, sort: '-updated_at' });
    assert.ok(sorted.items.some((x) => x.key === rm.key), 'and sorting by updated_at still works');
    const back = await items.get(rp.key);
    assert.deepEqual([back.fields.evidence, back.provenance.main_claim.confidence, back.fields.venue.name], [{ type: 'survey', n: 42 }, 'low', T('Round Trip Journal')], 'readable through the API again');

    // the public preview of the restored graph: whitelisted fields, no confidential case study, no organisations
    publicExport.invalidate();
    const pubRT = JSON.parse((await publicExport.read()).text);
    const pubU = pubRT.nodes.find((n) => n.key === ru.key);
    assert.deepEqual(Object.keys(pubU.props).sort(), ['key', 'summary', 'title']);
    assert.ok(!pubRT.nodes.some((n) => n.key === rc.key), 'a confidential case study stays private even when marked public');
    assert.ok(!pubRT.edges.some((e) => e.from === rc.key || e.to === rc.key));
    await items.update(rc.key, { sensitivity: 'public' });
    publicExport.invalidate();
    const pubRT2 = JSON.parse((await publicExport.read()).text);
    assert.ok(pubRT2.nodes.some((n) => n.key === rc.key) && pubRT2.edges.some((e) => e.from === rc.key && e.to === ru.key), 'once public, it and its link appear');
    assert.ok(!pubRT2.nodes.some((n) => n.labels.includes('Organisation')) && pubRT2.nodes.some((n) => n.key === 'domain:payments'), 'organisations never; domains yes');

    for (const k of mine) await items.remove(k).catch(() => artifacts.remove(k));
    await db.exec('MATCH (n) WHERE (n:Topic OR n:Dataset OR n:Organisation OR n:Venue OR n:Person OR n:Concept) AND n.norm CONTAINS $tag DETACH DELETE n', { tag });
    crossref.setHttp((url, o) => fetch(url, o)); openalex.setHttp((url, o) => fetch(url, o));
  }

  // Task 8: the addendum's worked example end to end, its competency questions in plain Cypher, and a backup round trip
  {
    const T8 = (x) => `${x} ${tag}`;
    const mk = async (collection, fields) => (await items.create({ collection, fields })).key;
    const fw = { tsm: await mk('framework', { title: T8('Two-sided market theory'), framework_kind: 'theoretical' }),
      pd: await mk('framework', { title: T8('Path dependence'), framework_kind: 'theoretical' }),
      dd: await mk('framework', { title: T8('Diamond-Dybvig bank-run model'), framework_kind: 'theoretical' }) };
    const q = await mk('research_question', { text: T8('Why do stablecoins struggle to replace card payments?'), kind: 'explanatory', status: 'open' });
    const q2 = await mk('research_question', { text: T8('Do merchants price stablecoin payments differently?'), kind: 'descriptive', status: 'open' });
    for (const f of Object.values(fw)) await items.link(q, { rel: 'FRAMED_BY', target: f });
    const h = {
      h1: await mk('hypothesis', { statement: T8('Adoption requires simultaneous merchant and consumer growth'), direction: 'positive' }),
      h2: await mk('hypothesis', { statement: T8('Entrenched interchange and acquiring relationships raise switching costs'), direction: 'positive' }),
      h3: await mk('hypothesis', { statement: T8('Redemption risk reduces trust in stablecoins'), direction: 'negative' }),
    };
    for (const [hk, f] of [[h.h1, fw.tsm], [h.h2, fw.pd], [h.h3, fw.dd]]) { await items.link(hk, { rel: 'DERIVED_FROM', target: f }); await items.link(hk, { rel: 'ANSWERS', target: q }); }
    const p1 = await mk('paper', { title: T8('Stablecoin adoption in retail payments'), year: 2024 });
    const p2 = await mk('paper', { title: T8('One-sided growth of stablecoin acceptance'), year: 2025 });
    await items.link(p1, { rel: 'FRAMED_BY', target: fw.tsm });
    await items.link(p1, { rel: 'TESTS', target: h.h1, result: 'supported', evidence: 'joint growth in table 3', location: 'p. 9' });
    await items.link(p2, { rel: 'TESTS', target: h.h1, result: 'refuted', evidence: 'merchant-led adoption', location: 's. 4' });
    await items.link(p1, { rel: 'TESTS', target: h.h2, result: 'supported', evidence: 'switching costs', location: 'p. 11' });
    await items.link(q, { rel: 'ADDRESSED_BY', target: p1 });
    const fibo = await mk('ontology', { title: T8('Financial Industry Business Ontology'), acronym: T8('FIBO'), kind: 'ontology', iri: 'https://spec.edmcouncil.org/fibo/ontology/', urls: [{ role: 'docs', url: 'https://spec.edmcouncil.org/fibo/' }] });
    const fnd = await mk('ontology', { title: T8('FIBO Foundations'), kind: 'ontology', parent: T8('FIBO') });
    const unused = await mk('ontology', { title: T8('An ontology nobody uses'), kind: 'taxonomy' });
    const uc = await mk('use_case', { title: T8('Shared legal-entity vocabulary'), goal: 'one vocabulary for counterparties' });
    await items.link(fibo, { rel: 'USED_BY', target: uc });

    const statusOf = async (k) => (await items.get(k)).fields.status;
    assert.deepEqual([await statusOf(h.h1), await statusOf(h.h2), await statusOf(h.h3)], ['mixed', 'supported', 'untested'], 'statuses derived from the TESTS results');
    assert.ok((await items.get(fnd)).fields.parent.key === fibo, 'a module is PART_OF its ontology, found by acronym');
    const C = async (cypher, params) => (await query.readOnly(cypher, { tag, ...params })).rows;
    assert.deepEqual((await C('MATCH (p:Paper)-[:FRAMED_BY]->(:Framework {key: $f}) RETURN p.key AS key', { f: fw.tsm })).map((r) => r.key), [p1], 'papers using a given framework');
    assert.deepEqual((await C(`MATCH (hy:Hypothesis)<-[t:TESTS]-(:Paper) WHERE hy.title ENDS WITH $tag WITH hy, collect(DISTINCT t.result) AS rs
       WHERE 'supported' IN rs AND 'refuted' IN rs RETURN hy.key AS key, hy.status AS status`)), [{ key: h.h1, status: 'mixed' }], 'hypotheses with conflicting test results');
    assert.deepEqual((await C(`MATCH (rq:ResearchQuestion {status: 'open'}) WHERE rq.title ENDS WITH $tag AND NOT (rq)-[:ADDRESSED_BY]->(:Paper) RETURN rq.key AS key`)).map((r) => r.key), [q2], 'open questions no paper addresses');
    assert.deepEqual((await C('MATCH (o:Ontology) WHERE o.title ENDS WITH $tag AND NOT (o)-[:USED_BY]->() AND NOT ()-[:PART_OF]->(o) AND NOT (o)-[:PART_OF]->() RETURN o.key AS key')).map((r) => r.key), [unused], 'ontologies used by no item');
    assert.deepEqual((await C('MATCH (:Ontology)-[:USED_BY]->(u:UseCase) WHERE u.title ENDS WITH $tag RETURN u.key AS key')).map((r) => r.key), [uc], 'use cases that reference an ontology');
    assert.deepEqual((await items.list({ collection: 'hypothesis', q: 'redemption trust ' + tag })).items.map((x) => x.key), [h.h3], 'statements are in the full-text index');

    // backup -> delete -> restore keeps the new labels, relations, TESTS results and derived statuses
    const mine8 = [...Object.values(fw), q, q2, ...Object.values(h), p1, p2, fibo, fnd, unused, uc];
    const pick8 = (d) => {
      const keys = new Set(mine8);
      const nodes = d.nodes.filter((n) => keys.has(n.props.key)).map((n) => ({ labels: [...n.labels].sort(), props: n.props })).sort((a, b) => (a.props.key < b.props.key ? -1 : 1));
      const rels = d.rels.filter((r) => keys.has(r.from) && keys.has(r.to)).sort((a, b) => (`${a.from}|${a.type}|${a.to}` < `${b.from}|${b.type}|${b.to}` ? -1 : 1));
      return { nodes, rels };
    };
    const dump8 = await backup.exportAll();
    const before8 = pick8(dump8);
    const labels8 = new Set(before8.nodes.flatMap((n) => n.labels));
    for (const l of ['Framework', 'ResearchQuestion', 'Hypothesis', 'Ontology']) assert.ok(labels8.has(l), `backup covers ${l}`);
    const types8 = new Set(before8.rels.map((r) => r.type));
    for (const t of ['FRAMED_BY', 'DERIVED_FROM', 'ANSWERS', 'TESTS', 'ADDRESSED_BY', 'USED_BY', 'PART_OF']) assert.ok(types8.has(t), `backup covers ${t}`);
    assert.ok(before8.rels.some((r) => r.type === 'TESTS' && r.props.result === 'refuted'));
    await db.exec('UNWIND $keys AS k MATCH (n {key: k}) DETACH DELETE n', { keys: mine8 });
    await backup.restore(dump8);
    assert.deepEqual(pick8(await backup.exportAll()), before8, 'identical after backup, delete and restore');
    assert.equal(await statusOf(h.h1), 'mixed');
    for (const k of mine8) await items.remove(k).catch(() => {});
  }

  // notes sync: upsert, edges to the paper and a concept, prune; methods are skipped and never pruned
  const entries = [
    { path: `notes/it-${stamp}-a.md`, meta: { title: 'Note A', annotates: [paperKey], concepts: ['integration-testing'], visibility: 'private' }, body: '# A\ntext' },
    { path: `projects/it-${stamp}-p.md`, meta: { title: 'Project P', visibility: 'public' }, body: 'project text' },
    { path: `methods/it-${stamp}-b.md`, meta: { title: 'Method B', level: 'technique', visibility: 'public' }, body: 'method text' },
  ];
  const r1 = await notes.sync(entries, { prune: false });
  assert.equal(r1.created, 2); assert.equal(r1.edges, 2); assert.equal(r1.skipped.length, 1);
  const [edge] = await db.run("MATCH (n:Note {key:$k})-[r:ANNOTATES]->(p:Paper {key:$p}) RETURN r.source AS s", { k: `note:it-${stamp}-a`, p: paperKey });
  assert.equal(edge.s, 'markdown');
  // a db-managed item that somehow carries source 'markdown' is still never pruned
  await db.exec('MATCH (m:Method {key:$k}) SET m.source = $s', { k: `method:it-${stamp}-b`, s: 'markdown' });
  const r2 = await notes.sync([entries[1]], { prune: true });
  assert.ok(r2.removed.includes(`note:it-${stamp}-a`)); assert.ok(!r2.removed.includes(`method:it-${stamp}-b`));
  assert.equal((await db.run('MATCH (m:Method {key:$k}) RETURN count(m) AS c', { k: `method:it-${stamp}-b` }))[0].c, 1);
  await db.exec('MATCH (m:Method {key:$k}) SET m.source = $s', { k: `method:it-${stamp}-b`, s: 'hub' });
  await assert.rejects(() => notes.sync([], { prune: true }), /Refusing to prune/);

  // public preview: public items only, whitelisted fields only
  publicExport.invalidate();
  const pub = JSON.parse((await publicExport.read()).text);
  const pubPaper = pub.nodes.find((n) => n.key === paperKey);
  assert.ok(pubPaper, 'public paper is exported');
  assert.equal(pubPaper.props.abstract, undefined); assert.equal(pubPaper.props.file_url, undefined);
  assert.ok(pub.nodes.find((n) => n.key === `method:it-${stamp}-b`));

  // backup -> restore is idempotent
  const before = (await db.run('MATCH (n) RETURN count(n) AS c'))[0].c;
  const dump = await backup.exportAll();
  assert.ok(dump.nodes.some((n) => n.props.key === paperKey));
  await backup.restore(dump);
  await backup.restore(dump);
  assert.equal((await db.run('MATCH (n) RETURN count(n) AS c'))[0].c, before, 'restoring twice changes nothing');

  // clean up
  await artifacts.remove(paperKey);
  await db.exec("MATCH (n:Artifact) WHERE n.key STARTS WITH 'method:it-' OR n.key STARTS WITH 'note:it-' OR n.key STARTS WITH 'project:it-' OR n.key STARTS WITH 'usecase:offline-payments-' DETACH DELETE n");
  await db.exec("MATCH (c:Concept {key:'concept:integration-testing'}) WHERE NOT (c)--() DELETE c");
  console.log('integration tests passed');
})().then(() => db.driver.close()).catch(async (e) => { console.error(e); await db.driver.close(); process.exit(1); });
