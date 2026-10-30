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
  assert.ok((await migrate.applied()).includes('005_collections'));
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
