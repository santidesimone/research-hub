// Offline tests: pure logic plus the Cypher the writer would issue, using a fake transaction. Run: npm test
const assert = require('assert');
const path = require('path');

// Fake db module so nothing needs a running Neo4j.
const calls = [];
let existing = null;
let txImpl = null;   // tests may install a handler that answers specific statements
let runImpl = async () => []; // ... and one for reads outside a transaction
const fakeTx = { run: async (q, p) => {
  calls.push([q, p]);
  if (txImpl) { const r = await txImpl(q, p); if (r) return r; }
  return { records: q.includes('RETURN a.key') ? [{}] : q.includes('RETURN labels(n)') && existing ? [{ get: () => existing }] : q.includes('count(r)') ? [{ get: () => ({ toNumber: () => (p.tkey === 'method:missing' ? 0 : 1) }) }] : [] };
} };
const dbPath = require.resolve('../core/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { run: (q, p) => runImpl(q, p), exec: async () => [], writeTx: async (fn) => fn(fakeTx), driver: {}, plain: (v) => v } };

const types = require('../core/types');
const artifacts = require('../core/artifacts');
const item = require('../features/papers/item');
const csl = require('../features/papers/csl');
const { schema, publicView, safeRel, safeLabel } = require('../core/schema');
const seed = require('../../data/seed_papers.json');

(async () => {
  // schema
  assert.deepEqual(types.names().sort(), Object.keys(schema.types).sort());
  assert.ok(publicView().labels.find((l) => l.label === 'Person'));
  assert.throws(() => safeRel('DROP'), /not in schema/);
  assert.throws(() => safeLabel('Paper) DETACH DELETE (n'), /not in schema/);

  // papers: seed items parse, keys unique
  const keys = new Set();
  for (const raw of seed) { const a = types.get('paper').parse(raw); keys.add(a.key); assert.ok(a.props.title && a.props.authors.length, raw.title); }
  assert.equal(keys.size, seed.length);
  const a = types.get('paper').parse({ title: 'T', creators: ['Ada Lovelace'], date: '2024-05', tags: ['topic:digital-cash', 'public'] });
  assert.match(a.key, /^paper:[0-9a-f]{10}$/); assert.equal(a.props.visibility, 'public'); assert.equal('status' in a.props, false, 'status is not core metadata');
  assert.equal(item.paperKey({ DOI: 'https://doi.org/10.1/ABC', title: 'x' }), 'doi:10.1/abc');
  assert.throws(() => types.get('paper').parse({ itemType: 'x', title: 't' }), (e) => e.status === 400);

  // writer: create, then conflict, then overwrite
  const r = await artifacts.add('paper', { title: 'T', creators: ['Ada Lovelace'], tags: ['topic:privacy'] });
  assert.equal(r.created, true);
  assert.ok(calls.some(([q]) => q.includes('AUTHORED_BY')) && calls.some(([q]) => q.includes('ABOUT')));
  existing = ['Artifact', 'Paper'];
  await assert.rejects(() => artifacts.add('paper', { title: 'T' }), (e) => e.status === 409);
  await artifacts.add('paper', { title: 'T' }, { overwrite: true });
  existing = ['Artifact', 'Method'];
  await assert.rejects(() => artifacts.add('paper', { title: 'T' }, { overwrite: true }), (e) => e.status === 409 && /belongs to/.test(e.message));
  existing = null;

  // generic types (note/method/project) through the same writer
  const m = types.get('method').parse({ title: 'Snowball Sampling', level: 'technique', uses: ['method:x'], concepts: ['literature review'] });
  assert.equal(m.key, 'method:snowball-sampling'); assert.equal(m.props.level, 'technique'); assert.equal(m.props.repo, undefined);
  const out = await artifacts.add('note', { title: 'N1', annotates: ['DOI:10.1/ABC'], uses: ['method:missing'], body: '# hi' });
  assert.equal(out.key, 'note:n1'); assert.equal(out.warnings.length, 1);
  assert.ok(calls.some(([, p]) => p && p.tkey === 'doi:10.1/abc'));
  assert.throws(() => types.get('note').parse({ summary: 'no title' }), (e) => e.status === 400);
  assert.throws(() => types.get('nope'), (e) => e.status === 404);

  // CSL round trip
  const row = { key: 'doi:10.1/x', props: { title: 'T', year: 2024, doi: '10.1/x', authors: ['Ada Lovelace'], author_lasts: ['Lovelace'], item_type: 'preprint', venue: 'arXiv'  , visibility: 'public' }, topics: ['digital cash'] };
  const c = csl.toCsl(row); assert.deepEqual(c.author[0], { family: 'Lovelace', given: 'Ada' });
  const back = types.get('paper').parse(csl.fromCsl(c));
  assert.equal(back.key, 'doi:10.1/x'); assert.equal(back.props.visibility, 'public'); assert.equal(back.props.year, 2024);

  // migrations are discoverable and ordered
  const migrate = require('../core/migrate');
  assert.deepEqual(migrate.available().map((m) => m.id), ['001_constraints', '002_papers_owned_by_hub', '003_files_are_links', '004_fulltext_search', '005_collections', '006_vocab_matching', '007_items_json_fields', '008_vocab_letters_plain', '009_object_parts', '010_record_status_from_provenance', '011_frameworks_questions_ontologies', '012_oauth', '013_curation', 'personal_001_layer']);
  // personal layer: separate node, driven by hooks, core untouched
  calls.length = 0;
  require('../features/personal').mount({ get() {}, put() {}, delete() {}, post() {} });
  await artifacts.add('paper', { title: 'Layered', creators: ['A B'], tags: ['status:reading', 'topic:x'] });
  const personalCalls = calls.filter(([q]) => q.includes('Personal'));
  assert.equal(personalCalls.length, 1); assert.deepEqual(personalCalls[0][1].props, { status: 'reading' });
  assert.ok(!calls.filter(([q]) => !q.includes('Personal')).some(([q, p]) => JSON.stringify(p).includes('reading')), 'status never written by the core');
  calls.length = 0;
  await artifacts.add('paper', { title: 'Inbox item' }); // new paper, no status -> layer default
  assert.deepEqual(calls.filter(([q]) => q.includes('Personal'))[0][1].props, { status: 'to-read' });
  // owner session cookie, query guard
  process.env.HUB_API_TOKEN = 'abc';
  const auth = require('../core/auth');
  const good = auth.sign(Date.now() + 5000);
  assert.ok(auth.verify(good)); assert.ok(!auth.verify(good + 'x')); assert.ok(!auth.verify(auth.sign(Date.now() - 1000)));
  const q = require('../core/query');
  assert.throws(() => q.guard('CALL db.labels()'), /procedure/);
  assert.throws(() => q.guard('MATCH (n) RETURN n; MATCH (m) RETURN m'), /one statement/);
  assert.throws(() => q.guard('LOAD CSV FROM "x" AS r RETURN r'), /LOAD CSV/);
  assert.doesNotThrow(() => q.guard('MATCH (n) CALL  { WITH n RETURN 1 AS x } RETURN x'));
  assert.doesNotThrow(() => q.guard('MATCH (p:Paper) RETURN p.title LIMIT 5'));

  // every app has a manifest and entry; every skin defines every token the base CSS uses
  const fs = require('fs');
  for (const d of fs.readdirSync(path.join(__dirname, '..', 'apps'))) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'apps', d, 'app.json')) && fs.existsSync(path.join(__dirname, '..', 'apps', d, 'app.js')), 'app ' + d);
  }
  const used = new Set([...fs.readFileSync(path.join(__dirname, '..', 'public', 'shell', 'base.css'), 'utf8').matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
  for (const s of fs.readdirSync(path.join(__dirname, '..', 'skins'))) {
    const css = fs.readFileSync(path.join(__dirname, '..', 'skins', s, 'skin.css'), 'utf8');
    for (const v of used) assert.ok(css.includes(v + ':'), `skin ${s} is missing ${v}`);
    // the graph and the Library colour nodes with --node-<type or entity> (types by name, entities lowercased)
    for (const n of [...Object.keys(schema.types), ...Object.keys(schema.entities).map((l) => l.toLowerCase())]) {
      assert.equal((css.match(new RegExp(`--node-${n}:`, 'g')) || []).length, 2, `skin ${s} needs --node-${n} for light and dark`);
    }
  }

  /* ------------------------------------------------------------ file links */
  const links = require('../core/links');
  const DRV = '1AbCdEfGhIjKlMnOp';
  assert.equal(links.normalize(`https://drive.google.com/open?id=${DRV}`), `https://drive.google.com/file/d/${DRV}/view`);
  assert.equal(links.normalize(`https://drive.google.com/file/d/${DRV}/view?usp=sharing`), `https://drive.google.com/file/d/${DRV}/view`);
  assert.equal(links.normalize(`https://drive.google.com/file/u/0/d/${DRV}/preview`), `https://drive.google.com/file/d/${DRV}/view`);
  assert.equal(links.normalize('https://arxiv.org/pdf/0000.00000'), 'https://arxiv.org/pdf/0000.00000');
  for (const bad of ['http://x.org/a.pdf', 'javascript:alert(1)', 'ftp://x.org/a', 'not a url', '', '   ', 'https://user:pw@x.org/a']) assert.throws(() => links.normalize(bad), (e) => e.status === 400, bad);
  assert.equal(links.describe(`https://drive.google.com/file/d/${DRV}/view`).embed_url, `https://drive.google.com/file/d/${DRV}/preview`);
  assert.equal(links.describe('https://arxiv.org/pdf/1').embed_url, null);
  assert.equal(links.describe(null), null);
  assert.throws(() => types.get('paper').parse({ title: 'T', file_url: 'http://insecure.example/a.pdf' }), (e) => e.status === 400);
  assert.equal('file_url' in types.get('paper').parse({ title: 'T', file_url: 'https://arxiv.org/pdf/1' }).props, false, 'the link is written after the node exists');

  /* ------------------------------------------------------------ config, rate limit, security headers */
  const config = require('../core/config');
  let pr = config.problems(config.get({ NODE_ENV: 'production', HUB_API_TOKEN: 'short', NEO4J_PASSWORD: 'hubpassword' }));
  assert.equal(pr.errors.length, 2, 'production rejects a short token and the default database password');
  pr = config.problems(config.get({ NODE_ENV: 'production', HUB_API_TOKEN: 'x'.repeat(32), NEO4J_PASSWORD: 'real-one', GOOGLE_CLIENT_ID: 'a' }));
  assert.equal(pr.errors.length, 1, 'production rejects half-configured Drive');
  assert.deepEqual(config.problems(config.get({ NODE_ENV: 'production', HUB_API_TOKEN: 'x'.repeat(32), NEO4J_PASSWORD: 'real-one' })).errors, []);
  pr = config.problems(config.get({}));
  assert.equal(pr.errors.length, 0, 'local mode only warns'); assert.ok(pr.warnings.some((w) => /HUB_API_TOKEN/.test(w)));
  assert.equal(config.get({}).host, '127.0.0.1'); assert.equal(config.get({ NODE_ENV: 'production' }).host, '0.0.0.0'); assert.equal(config.get({ NODE_ENV: 'production' }).logFormat, 'json');

  const { limiter } = require('../core/ratelimit');
  const lim = limiter({ max: 2 });
  let passed = 0;
  const codes = [];
  for (let i = 0; i < 3; i++) {
    const hdr = {}; const res = { set(k, v) { hdr[k] = v; return this; }, status(c) { codes.push(c); return this; }, json() { return this; } };
    lim({ ip: '9.9.9.9' }, res, () => passed++);
  }
  assert.equal(passed, 2); assert.deepEqual(codes, [429]);

  const security = require('../core/security');
  const policy = security.csp('NONCE123', { font: ['https://fonts.example'] });
  assert.ok(policy.includes("script-src 'self' 'nonce-NONCE123'") && !/script-src[^;]*unsafe-inline/.test(policy), 'no inline scripts without the nonce');
  assert.ok(policy.includes('https://fonts.example') && policy.includes("frame-ancestors 'none'") && policy.includes("object-src 'none'"));
  const page = require('../core/shell').render({ query: {} }, 'NONCE123');
  assert.ok(!page.html.includes('{{') && (page.html.match(/nonce="NONCE123"/g) || []).length === 2, 'both inline scripts carry the nonce');

  /* ------------------------------------------------------------ Google Drive module (fake HTTP) */
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'rt' });
  const drive = require('../core/drive');
  const net = [];
  let sessions = 0, failPermission = false, tokenOk = true;
  const J = (obj, status = 200, headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => obj, clone() { return this; } });
  drive.setHttp(async (url, opts = {}) => {
    net.push([opts.method || 'GET', url, opts]);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return tokenOk ? J({ access_token: 'AT', expires_in: 3600 }) : J({ error: 'invalid_grant' }, 400);
    if (url.includes('/drive/v3/files?q=')) return J({ files: [] });
    if (url.includes('/drive/v3/files?fields=id') && opts.method === 'POST') return J({ id: 'FOLDER1' });
    if (url.includes('uploadType=resumable')) { sessions++; return J({}, 200, { location: `https://upload.example/s${sessions}` }); }
    if (url.startsWith('https://upload.example/s')) return J({ id: 'FILE' + url.slice(-1) });
    if (url.includes('/permissions')) return failPermission ? J({ error: { message: 'sharing is disabled by policy' } }, 403) : J({ id: 'perm' });
    if (url.includes('/drive/v3/files/') && opts.method === 'PATCH') return url.includes('GONE') ? J({}, 404) : J({});
    throw new Error('unexpected request ' + url);
  });
  const PDF = Buffer.from('%PDF-1.4 test');
  const up = await drive.upload('A/B: "Title"?', PDF);
  assert.deepEqual(up, { id: 'FILE1', url: 'https://drive.google.com/file/d/FILE1/view', mime: 'application/pdf' }, 'a PDF by default, as before');
  const start = net.find((c) => c[1].includes('uploadType=resumable'));
  assert.equal(start[2].headers.Authorization, 'Bearer AT'); assert.equal(JSON.parse(start[2].body).name, 'A B Title.pdf'); assert.deepEqual(JSON.parse(start[2].body).parents, ['FOLDER1']);
  assert.deepEqual(JSON.parse(net.find((c) => c[1].includes('/permissions'))[2].body), { role: 'reader', type: 'anyone', allowFileDiscovery: false });
  await drive.upload('Second', PDF);
  assert.equal(net.filter((c) => c[1].includes('oauth2')).length, 1, 'access token is reused');
  assert.equal(net.filter((c) => c[0] === 'POST' && c[1].endsWith('/drive/v3/files?fields=id')).length, 1, 'the folder is created once');
  failPermission = true;
  await assert.rejects(() => drive.upload('Blocked', PDF), /making the file readable/);
  assert.ok(net.some((c) => c[0] === 'PATCH' && c[1].includes('/files/FILE3')), 'a file that could not be shared is trashed, not left private and orphaned');
  failPermission = false;
  await drive.trash('GONE1'); // already deleted: not an error
  drive._reset(); tokenOk = false;
  await assert.rejects(() => drive.upload('x', PDF), (e) => e.status === 503 && /rejected the stored login/.test(e.message));
  tokenOk = true; drive._reset();
  delete process.env.GOOGLE_REFRESH_TOKEN;
  await assert.rejects(() => drive.upload('x', PDF), (e) => e.status === 503 && /not set up/.test(e.message));
  process.env.GOOGLE_REFRESH_TOKEN = 'rt';

  /* ------------------------------------------------------------ paper files (link, upload, replace) */
  const files = require('../features/papers/files');
  let paper = { key: 'doi:10.1/p', title: 'My Paper', file_url: null, drive_file_id: 'OLDfile1234567' };
  runImpl = async (q) => (q.includes('p.drive_file_id AS drive_file_id') ? [paper] : []);
  const base = calls.length;
  const out1 = await files.uploadPdf('doi:10.1/p', PDF);
  assert.ok(out1.file_url.startsWith('https://drive.google.com/file/d/') && out1.drive_file_id && out1.replaced_drive_file === 'OLDfile1234567');
  assert.ok(calls.slice(base).some(([q]) => q.includes('SET p.file_url = $url, p.drive_file_id = $id')));
  assert.ok(net.some((c) => c[0] === 'PATCH' && c[1].includes('OLDfile1234567')), 'the replaced Drive file goes to the trash');
  await assert.rejects(() => files.uploadPdf('doi:10.1/p', Buffer.from('not a pdf')), (e) => e.status === 400);
  const mark = calls.length;
  const out2 = await files.setLink('doi:10.1/p', 'https://arxiv.org/pdf/1');
  assert.equal(out2.file_url, 'https://arxiv.org/pdf/1'); assert.equal(out2.trashed_drive_file, 'OLDfile1234567');
  assert.ok(calls.slice(mark).some(([q]) => q.includes('REMOVE p.drive_file_id')));
  const mark2 = calls.length;
  await files.setLink('doi:10.1/p', 'https://drive.google.com/file/d/OLDfile1234567/view'); // same file: keep ownership
  assert.ok(!calls.slice(mark2).some(([q]) => q.includes('REMOVE p.drive_file_id')));
  paper = { key: 'doi:10.1/p', title: 'My Paper', file_url: 'https://arxiv.org/pdf/1', drive_file_id: null };
  const out3 = await files.removeLink('doi:10.1/p');
  assert.equal(out3.removed, true); assert.equal(out3.trashed_drive_file, undefined, 'files the hub did not upload are never touched');
  runImpl = async () => [];
  await assert.rejects(() => files.setLink('doi:nope', 'https://arxiv.org/pdf/1'), (e) => e.status === 404);
  // add with a link: stored once the node exists; copy_to_drive from a host that is not allowed keeps the link and reports why
  runImpl = async (q) => (q.includes('p.drive_file_id AS drive_file_id') ? [{ key: 'doi:10.1/p', title: 'x', file_url: null, drive_file_id: null }] : []);
  const withLink = await artifacts.add('paper', { title: 'Linked paper', file_url: 'https://arxiv.org/pdf/2' });
  assert.equal(withLink.file_url, 'https://arxiv.org/pdf/2'); assert.equal(withLink.file_error, undefined);
  const copyFail = await artifacts.add('paper', { title: 'Copy paper', file_url: 'https://evil.example/x.pdf', copy_to_drive: true });
  assert.equal(copyFail.file_url, 'https://evil.example/x.pdf'); assert.match(copyFail.file_error, /not allowed.*kept the original link/);
  runImpl = async () => [];

  /* ------------------------------------------------------------ Markdown notes sync */
  const notes = require('../core/notes');
  const hooks = require('../core/hooks');
  const t1 = notes.toItem({ path: 'notes/My Note.md', meta: { title: 'Hello', summary: 's', visibility: 'public', note_kind: 'reading', annotates: ['DOI:10.1/ABC'], uses: 'method:tdd', concepts: ['digital-cash', 'Privacy'], extra: { a: 1 } }, body: '# Hi' }).item;
  assert.equal(t1.key, 'note:My Note'); assert.equal(t1.label, 'Note');
  assert.deepEqual({ title: t1.props.title, visibility: t1.props.visibility, note_kind: t1.props.note_kind, body: t1.props.body, source_path: t1.props.source_path, path: t1.props.path }, { title: 'Hello', visibility: 'public', note_kind: 'reading', body: '# Hi', source_path: 'notes/My Note.md', path: null });
  assert.deepEqual(t1.relations.map((r) => `${r.rel} ${r.target}`).sort(), ['ANNOTATES doi:10.1/abc', 'USES method:tdd']);
  assert.deepEqual(t1.concepts, [{ key: 'concept:digital-cash', name: 'digital cash' }, { key: 'concept:privacy', name: 'Privacy' }]);
  const tm = notes.toItem({ path: 'projects/snow.md', meta: {}, body: '' }).item;
  assert.equal(tm.key, 'project:snow'); assert.equal(tm.props.title, 'snow'); assert.equal(tm.props.repo, null, 'fields removed from front matter are removed from the node'); assert.equal(tm.props.body, null);
  assert.deepEqual([tm.props.managed, tm.props.schema_version], ['markdown', 1]);
  // methods are database-managed now: their files are skipped, by folder or by kind
  assert.match(notes.toItem({ path: 'methods/snow.md', meta: {}, body: '' }).skip, /managed in the hub database/);
  assert.match(notes.toItem({ path: 'notes/x.md', meta: { kind: 'method' } }).skip, /managed in the hub database/);
  assert.match(notes.toItem({ path: 'x.md', meta: { kind: 'use_case' } }).skip, /managed in the hub database/);
  assert.equal(notes.toItem({ path: 'methods/x.md', meta: { kind: 'note' } }).item.key, 'note:x', 'an explicit Markdown kind still wins');
  assert.ok(notes.toItem({ path: 'notes/x.md', meta: { visibility: 'secret' } }).warnings[0].includes('using private'));
  assert.equal(notes.toItem({ path: 'x.md', meta: { kind: 'project' } }).item.key, 'project:x');
  assert.ok(notes.toItem({ path: 'misc/x.md', meta: {} }).skip.includes('put it in a')); assert.ok(notes.toItem({ path: 'notes/x.txt', meta: {} }).skip);

  const txLog = [];
  txImpl = async (q, p) => {
    txLog.push([q, p]);
    if (q.startsWith('MATCH (n:Artifact) WHERE n.key IN $keys RETURN')) return { records: [{ get: () => 'note:old' }] };
    if (q.includes('WHERE n.key IN $targets')) return { records: [{ get: () => 'method:tdd' }] };
    if (q.includes('DETACH DELETE n RETURN key')) return { records: [{ get: () => 'note:gone' }] };
    return null;
  };
  const events = [];
  hooks.on('afterWrite', (e) => events.push(['w', e.key, e.created])); hooks.on('afterRemove', (e) => events.push(['r', e.key]));
  const res = await notes.sync([
    { path: 'notes/a.md', meta: { title: 'A', uses: ['method:tdd'], annotates: ['doi:10.9/missing'], concepts: ['x'] }, body: 'a' },
    { path: 'projects/b.md', meta: {}, body: 'b' }, { path: 'methods/m.md', meta: {}, body: 'm' },
    { path: 'notes/a.md', meta: {}, body: 'dup' }, { path: 'bad/c.md', meta: {} },
  ]);
  assert.equal(res.upserted, 2); assert.equal(res.created, 2); assert.deepEqual(res.removed, ['note:gone']); assert.equal(res.edges, 2);
  assert.equal(res.skipped.length, 3); assert.ok(res.skipped.some((x) => x.startsWith('methods/m.md:'))); assert.ok(res.warnings.some((w) => /note:a ANNOTATES -> doi:10.9\/missing: target not found/.test(w)));
  const stm = txLog.map(([q]) => q).join('\n');
  assert.ok(stm.includes('SET n:Note') && stm.includes('SET n:Project') && !stm.includes('SET n:Method') && stm.includes("n.source = 'markdown'") && stm.includes('MERGE (a)-[x:USES]->(b)') && !stm.includes('x:ANNOTATES'), 'one batched statement per label and relation, missing targets skipped');
  assert.ok(events.some((e) => e[0] === 'w' && e[1] === 'note:a' && e[2] === true) && events.some((e) => e[0] === 'r' && e[1] === 'note:gone'));
  await assert.rejects(() => notes.sync([], { prune: true }), (e) => e.status === 400 && /Refusing to prune/.test(e.message));
  runImpl = async (q) => (q.includes('NOT n.key IN') ? [{ key: 'note:zzz' }] : []);
  const dry = await notes.sync([{ path: 'notes/a.md', meta: {} }], { dryRun: true });
  assert.deepEqual([dry.dry_run, dry.would_create, dry.would_remove], [true, 1, ['note:zzz']]);
  runImpl = async () => []; txImpl = null;

  /* ------------------------------------------------------------ backup / restore */
  const backup = require('../core/backup');
  runImpl = async (q) => (q.includes('labels(n) AS labels') ? [{ labels: ['Artifact', 'Paper'], props: { key: 'doi:1', title: 'T' } }] : [{ from: 'doi:1', to: 'person:x', type: 'AUTHORED_BY', props: { source: 'hub' } }]);
  const dump = await backup.exportAll();
  assert.equal(dump.format, 'research-hub-backup'); assert.equal(dump.nodes.length, 1); assert.equal(dump.rels[0].type, 'AUTHORED_BY');
  runImpl = async () => [];
  const F = { format: 'research-hub-backup', version: 1 };
  await assert.rejects(() => backup.restore({ format: 'nope' }), (e) => e.status === 400);
  await assert.rejects(() => backup.restore({ ...F, nodes: [{ labels: ['Artifact', 'Evil) DETACH DELETE (n'], props: { key: 'a' } }] }), (e) => e.status === 400 && /label/.test(e.message));
  await assert.rejects(() => backup.restore({ ...F, rels: [{ from: 'a', to: 'b', type: 'DROP', props: {} }] }), (e) => e.status === 400);
  await assert.rejects(() => backup.restore({ ...F, nodes: [{ labels: ['Artifact', 'Paper'], props: {} }] }), (e) => e.status === 400);
  txLog.length = 0;
  txImpl = async (q, p) => { txLog.push([q, p]); return q.includes('RETURN count(x)') ? { records: [{ get: () => ({ toNumber: () => p.rows.length }) }] } : { records: [] }; };
  const rr = await backup.restore({ ...F,
    nodes: [{ labels: ['Artifact', 'Paper'], props: { key: 'doi:1', title: 'T', created_at: '2024-01-01T00:00:00Z' } }, { labels: ['Personal'], props: { key: 'personal:doi:1', status: 'read' } }, { labels: ['Person'], props: { key: 'person:x', name: 'X' } }],
    rels: [{ from: 'doi:1', to: 'person:x', type: 'AUTHORED_BY', props: { source: 'hub' } }, { from: 'personal:doi:1', to: 'doi:1', type: 'FOR' }] });
  assert.deepEqual(rr, { nodes: 3, rels_requested: 2, rels_restored: 2, rels_skipped: 0 });
  const rs = txLog.map(([q]) => q).join('\n');
  assert.ok(rs.includes('MERGE (n:Artifact {key:r.key})') && rs.includes('SET n:Paper') && rs.includes('MERGE (n:Personal {key:r.key})') && rs.includes('datetime(r.props.created_at)'));
  txImpl = null;

  /* ------------------------------------------------------------ public preview: whitelist, cache, stable ETag */
  const pubExport = require('../core/public-export');
  let builds = 0;
  runImpl = async (q) => {
    builds++;
    if (q.includes('RETURN a.key AS key')) return [{ key: 'doi:1', labels: ['Artifact', 'Paper'], props: { key: 'doi:1', title: 'T', year: 2024, abstract: 'secret', file_url: 'https://x', drive_file_id: 'd', body: 'private text' } }];
    if (q.includes('DISTINCT b.key')) return [{ key: 'person:x', labels: ['Person'], props: { key: 'person:x', name: 'X' } }];
    return [{ from: 'doi:1', to: 'person:x', type: 'AUTHORED_BY' }];
  };
  pubExport.invalidate();
  const c1 = await pubExport.read(); const body1 = JSON.parse(c1.text);
  assert.deepEqual(Object.keys(body1.nodes[0].props).sort(), ['key', 'title', 'year'], 'only whitelisted fields are public');
  assert.equal(body1.nodes.length, 2); assert.equal(body1.edges.length, 1);
  const c1b = await pubExport.read(); assert.equal(c1b, c1, 'cached'); assert.equal(builds, 3);
  pubExport.invalidate(); const c2 = await pubExport.read();
  assert.equal(c2.etag, c1.etag, 'unchanged data keeps its ETag'); assert.equal(builds, 6);
  runImpl = async () => [];

  /* ------------------------------------------------------------ schema v3: loader */
  const S = require('../core/schema');
  assert.deepEqual(S.check(schema), [], 'the shipped schema is valid');
  const broken = (mutate) => { const c = JSON.parse(JSON.stringify(schema)); mutate(c); return S.check(c).join('\n'); };
  assert.match(broken((c) => { c.types.method.fields.kind.type = 'colour'; }), /method\.fields\.kind: unknown type colour/);
  assert.match(broken((c) => { c.types.method.fields.kind.enum = []; }), /kind: enum needs values/);
  assert.match(broken((c) => { c.types.paper.fields.venue.ref = 'Journal'; }), /venue: ref Journal is not an entity or type label/);
  assert.match(broken((c) => { c.types.paper.fields.venue.rel = 'HOSTED_BY'; }), /venue: rel HOSTED_BY is not in relation_types/);
  assert.match(broken((c) => { c.types.use_case.public_props.push('goal'); }), /use_case\.public_props: goal is not in the global public_props whitelist/);
  assert.match(broken((c) => { c.entity_public_props.push('aliases'); }), /entity_public_props: aliases/);
  assert.match(broken((c) => { c.types.note.managed = 'files'; }), /types\.note: managed must be one of/);
  assert.match(broken((c) => { c.types.note.schema_version = 0; }), /types\.note: schema_version/);
  assert.match(broken((c) => { c.types.case_study.list_columns.push('nope'); }), /case_study: layout names unknown field nope/);
  assert.match(broken((c) => { c.relations.cites_loosely = 'CITES_LOOSELY'; }), /relations\.cites_loosely: CITES_LOOSELY is not in relation_types/);
  assert.match(broken((c) => { c.relation_types.USES.to.push('Gadget'); }), /relation_types\.USES: unknown label Gadget/);
  assert.match(broken((c) => { c.common_fields.visibility.default = 'secret'; }), /visibility: default "secret" is not a valid value/);
  assert.match(broken((c) => { c.types.method.fields.kind.tier = 'gold'; }), /kind: tier must be/);
  assert.match(broken((c) => { c.types.method.fields.kind.by = ['Z']; }), /kind: by must list/);
  const os = require('os');
  const badFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-schema-')), 'schema.json');
  fs.writeFileSync(badFile, JSON.stringify({ ...schema, version: 'three' }));
  assert.throws(() => S.load(badFile), /schema\/schema\.json is invalid:[\s\S]*version must be an integer/);
  assert.deepEqual(Object.keys(schema.types).filter((t) => schema.types[t].collection).sort(), ['case_study', 'framework', 'hypothesis', 'method', 'ontology', 'paper', 'research_question', 'use_case']);
  assert.deepEqual(['note', 'project'].map(S.managedBy), ['markdown', 'markdown']);
  assert.deepEqual(['method', 'use_case', 'case_study', 'paper'].map(S.managedBy), ['db', 'db', 'db', 'api']);
  assert.ok(['Topic', 'Concept', 'Domain', 'Person', 'Venue', 'Organisation', 'Dataset'].every((l) => S.entityLabels.includes(l)));
  assert.ok(['INTRODUCES', 'ADDRESSES', 'INSTANCE_OF', 'VARIANT_OF', 'INVOLVES', 'PUBLISHED_IN', 'BROADER', 'CITES', 'AUTHORED_BY'].every((r) => S.safeRel(r)));
  assert.deepEqual(S.orphanLabels, ['Person', 'Concept'], 'seeded Domains and other vocabulary are never deleted as orphans');
  assert.ok(S.fieldsOf('case_study').title && S.fieldsOf('case_study').case_type && !S.fieldsOf('note').title, 'collections get the common fields');

  /* ------------------------------------------------------------ schema v3: validator */
  const v0 = S.validate('use_case', { summary: 'no title' });
  assert.deepEqual(v0.errors, ['title is required']);
  const v1 = S.validate('case_study', {
    title: 'Pilot', case_type: 'pilot', geography: 'EU', organisations: ['ECB'], sector: 'payments', sources: [{ url: 'https://x.example/r', note: 'report' }],
    period: { from: '2023-01', to: 'later' }, outcomes: [{ measure: 'uptake', expected: 'yes' }], sensitivity: 'secret', lessons: 'one', mood: 'good', provenance: { x: 1 },
  });
  assert.deepEqual(v1.errors, []);
  assert.deepEqual(v1.unknown, ['mood']);
  for (const w of ['period: to: expected a date (YYYY, YYYY-MM or YYYY-MM-DD)', 'outcomes: expected: expected true or false', 'sensitivity: expected one of public, internal, confidential', 'lessons: expected a list', 'tldr is empty (Core field)', 'not in the case_study schema (kept as is): mood']) {
    assert.ok(v1.warnings.includes(w), `warns: ${w} (got ${v1.warnings.join(' | ')})`);
  }
  assert.ok(!v1.warnings.some((w) => /provenance|record_status|visibility|created_at/.test(w)), 'hub-set fields and fields with defaults are not reported');
  const v2 = S.validate('paper', { title: 'P', relevance: 7, rigor: 3, citation_count: -1, url: 'ftp://x', key_findings: [{ text: 't', page: 3 }] });
  for (const w of ['relevance: must be at most 5', 'citation_count: must be at least 0', 'url: expected an http(s) link', 'key_findings: unknown part "page" (expected text, location)']) assert.ok(v2.warnings.includes(w), w);
  assert.ok(!v2.warnings.some((w) => w.startsWith('rigor')));
  assert.deepEqual(S.validate('note', { title: 'n', body: 'b', annotates: ['x'], concepts: ['c'], note_kind: 'reading' }), { errors: [], warnings: [], unknown: [] }, 'Markdown types: base fields, relations and their props are known');

  /* ------------------------------------------------------------ schema v3: generic writer */
  const uc = types.get('use_case').parse({ title: 'Offline payments', goal: 'Pay without a network', status: 'idea', actors: [{ role: 'payer' }], mood: 'good', source: 'evil', 'bad key': 1, collection: 'paper' });
  assert.equal(uc.key, 'usecase:offline-payments'); assert.equal(uc.label, 'UseCase');
  assert.equal(uc.props.goal, 'Pay without a network'); assert.equal(uc.props.actors_json, '[{"role":"payer"}]', 'objects are stored as JSON text in <field>_json'); assert.equal(uc.props.actors, null);
  const mStatus = types.get('method').parse({ title: 'M', status: 'reading', procedure_json: 'x' });
  assert.ok(!('status' in mStatus.props) && !('procedure_json' in mStatus.props), 'a reading status or a storage name is never kept as a field');
  assert.ok(!mStatus.warnings.some((w) => w.includes('kept as is')), 'and is not reported as kept');
  assert.ok(mStatus.warnings.includes('status: saved as your personal status, not on the item') && mStatus.warnings.includes('ignored (reserved or not a valid field name): procedure_json'));
  assert.ok(types.get('method').parse({ title: 'M', mood: 'x', status: 'y' }).warnings.includes('not in the method schema (kept as is): mood'));
  assert.equal(uc.props.mood, 'good', 'unknown fields are preserved');
  assert.ok(!('source' in uc.props) && !('bad key' in uc.props) && !('collection' in uc.props), 'reserved and unsafe names are never written from input');
  assert.ok(uc.warnings.some((w) => /ignored \(reserved or not a valid field name\): source, bad key/.test(w)));
  assert.equal(types.get('case_study').parse({ title: 'Lisbon pilot' }).key, 'case:lisbon-pilot');
  assert.throws(() => types.get('case_study').parse({ title: '   ' }), (e) => e.status === 400);
  const legacyMethod = types.get('method').parse({ title: 'Snowballing', level: 'technique', domain: 'research' });
  assert.deepEqual([legacyMethod.props.level, legacyMethod.props.domain], ['technique', 'research'], 'old method data is stored unchanged');
  assert.ok(legacyMethod.warnings.includes('level: expected one of foundational, intermediate, advanced'));
  calls.length = 0;
  const ucOut = await artifacts.add('use_case', { title: 'Offline payments', status: 'nonsense' });
  assert.ok(ucOut.warnings.includes('status: expected one of idea, candidate, validated, in_use, retired'), 'validator warnings reach the API response');
  assert.ok(!calls.some(([q]) => q.includes('Personal')), "a use case's own status field never becomes your personal status");
  const personal = require('../features/personal');
  assert.equal(personal.statusFromInput({ status: 'idea' }, 'use_case'), null);
  assert.equal(personal.statusFromInput({ tags: ['status:reading'] }, 'use_case'), 'reading', 'the tag form still works');
  assert.equal(personal.statusFromInput({ status: 'reading' }, 'method'), 'reading');
  const [ucWrite] = calls.filter(([q]) => q.includes('n += $sys'));
  assert.deepEqual(ucWrite[1].sys, { managed: 'db', schema_version: 1, collection: 'use_case' });
  assert.deepEqual(ucWrite[1].onCreate, { record_status: 'auto', visibility: 'private' }, 'no visibility given: the default applies on create only');
  assert.ok(!('visibility' in ucWrite[1].props), 'an existing item keeps its visibility when the input does not say'); assert.ok(ucWrite[0].includes('ON CREATE SET n.created_at = datetime(), n += $onCreate'), 'record_status is only set on create');
  assert.deepEqual(artifacts.systemProps('Note'), { props: { managed: 'markdown', schema_version: 1 }, onCreate: {} });
  calls.length = 0;
  runImpl = async () => [{ key: 'usecase:x' }];
  await artifacts.remove('usecase:x');
  const cleanup = calls.map(([q]) => q).filter((q) => q.includes('WHERE NOT (x)--() DELETE x'));
  assert.deepEqual(cleanup.map((q) => q.match(/MATCH \(x:(\w+)\)/)[1]), ['Person', 'Concept']);
  runImpl = async () => [];

  /* ------------------------------------------------------------ schema v3: prune never touches database-managed items */
  txLog.length = 0;
  txImpl = async (q, p) => { txLog.push([q, p]); return null; };
  await notes.sync([{ path: 'notes/a.md', meta: {}, body: 'a' }]);
  const [pruneQ] = txLog.filter(([q]) => q.includes('DETACH DELETE n RETURN key'));
  assert.ok(pruneQ[0].includes('any(l IN labels(n) WHERE l IN $labels)')); assert.deepEqual(pruneQ[1].labels, ['Note', 'Project']);
  let dryQ;
  runImpl = async (q, p) => { if (q.includes('NOT n.key IN')) dryQ = [q, p]; return []; };
  await notes.sync([{ path: 'notes/a.md', meta: {} }], { dryRun: true });
  assert.deepEqual(dryQ[1].labels, ['Note', 'Project']);
  runImpl = async () => []; txImpl = null;

  /* ------------------------------------------------------------ schema v3: public preview per type, vocabulary */
  let vocabParams;
  runImpl = async (q, p) => {
    if (q.includes('RETURN a.key AS key')) return [{ key: 'usecase:u', labels: ['Artifact', 'UseCase'], props: { key: 'usecase:u', title: 'U', summary: 's', tldr: 't', goal: 'private goal', domain: 'payments', body: 'b' } }];
    if (q.includes('DISTINCT b.key')) { vocabParams = p; return [{ key: 'domain:payments', labels: ['Domain'], props: { key: 'domain:payments', name: 'payments', aliases: ['x'], by: 'owner', title: 'odd' } }]; }
    return [];
  };
  pubExport.invalidate();
  const pubV3 = JSON.parse((await pubExport.read()).text);
  assert.deepEqual(Object.keys(pubV3.nodes.find((n) => n.key === 'usecase:u').props).sort(), ['key', 'summary', 'title'], 'a type list narrows the global whitelist');
  assert.deepEqual(Object.keys(pubV3.nodes.find((n) => n.key === 'domain:payments').props).sort(), ['key', 'name'], 'vocabulary nodes export key and name only');
  assert.ok(vocabParams.vocab.includes('Domain') && !vocabParams.vocab.includes('Organisation'), 'organisations stay out of the public preview');
  assert.deepEqual([...S.publicProps(['Organisation'])], []); assert.deepEqual([...S.publicProps(['Personal'])], []);
  runImpl = async () => []; pubExport.invalidate();

  /* ------------------------------------------------------------ schema v3: backup covers vocabulary */
  txImpl = async (q, p) => (q.includes('RETURN count(x)') ? { records: [{ get: () => ({ toNumber: () => p.rows.length }) }] } : { records: [] });
  const rv = await backup.restore({ ...F, nodes: [{ labels: ['Domain'], props: { key: 'domain:payments', name: 'payments' } }, { labels: ['Artifact', 'CaseStudy'], props: { key: 'case:x', title: 'X' } }], rels: [{ from: 'case:x', to: 'org:ecb', type: 'INVOLVES' }] });
  assert.equal(rv.nodes, 2); assert.equal(rv.rels_restored, 1);
  await assert.rejects(() => backup.restore({ ...F, nodes: [{ labels: ['HubSetting'], props: { key: 'x' } }] }), (e) => e.status === 400);
  txImpl = null;

  /* ------------------------------------------------------------ schema v3: migration 005 */
  const m005 = require('../migrations/005_collections');
  const mlog = [];
  let ftRow = { labelsOrTypes: ['Paper', 'Method', 'Note', 'Project'], properties: ['title', 'abstract', 'summary', 'authors', 'venue', 'body'] };
  const fakeMigDb = { run: async (q, p) => { mlog.push([q, p]); return q.startsWith('SHOW FULLTEXT') ? (ftRow ? [ftRow] : []) : []; } };
  await m005.up(fakeMigDb);
  const mq = mlog.map(([q]) => q).join('\n');
  for (const l of ['topic', 'domain', 'venue', 'organisation', 'dataset']) assert.ok(mq.includes(`CREATE CONSTRAINT ${l}_key IF NOT EXISTS`), l);
  assert.ok(mq.includes('DROP INDEX artifact_text') && mq.includes(`FOR (n:${S.typeLabels.join('|')}) ON EACH [n.title, n.tldr`), 'full-text index rebuilt over every type in the schema');
  assert.ok(mq.includes("MATCH (n:Method {source:'markdown'}) SET n.source = 'hub', n.imported_from = 'markdown'"), 'Markdown methods become database-managed');
  assert.ok(!mq.includes("MATCH (n:Note {source:'markdown'}) SET"), 'notes stay Markdown-managed');
  assert.ok(mq.indexOf("(n:Method)-[r]->()") < mq.indexOf("MATCH (n:Method {source:'markdown'}) SET"), 'edges are converted before the nodes, so a re-run still finds them');
  const methodStamp = mlog.find(([q, p]) => q.startsWith('MATCH (n:Method) SET n.managed') && p.name === 'method');
  assert.deepEqual([methodStamp[1].managed, methodStamp[1].version], ['db', 1]); assert.ok(methodStamp[0].includes('n.collection = $name'));
  const noteStamp = mlog.find(([q]) => q.startsWith('MATCH (n:Note) SET n.managed'));
  assert.ok(!noteStamp[0].includes('collection'), 'notes are not a collection');
  const seedRows = mlog.find(([q]) => q.includes('MERGE (d:Domain'))[1].rows;
  assert.equal(seedRows.length, 10); assert.deepEqual(seedRows[0], { key: 'domain:digital-currency', name: 'digital currency', aliases: ['CBDC', 'central bank digital currency'] });
  assert.ok(mlog.find(([q]) => q.includes('MERGE (d:Domain'))[0].includes('ON CREATE SET'), 'owner edits to seeded domains survive a re-run');
  mlog.length = 0; ftRow = { labelsOrTypes: S.typeLabels, properties: ['title', 'tldr', 'abstract', 'summary', 'authors', 'venue', 'body'] };
  await m005.up(fakeMigDb);
  assert.ok(!mlog.some(([q]) => /DROP INDEX|CREATE FULLTEXT/.test(q)), 'an up-to-date index is left alone');
  mlog.length = 0; ftRow = null;
  await m005.up(fakeMigDb);
  assert.ok(mlog.some(([q]) => q.startsWith('CREATE FULLTEXT INDEX artifact_text')) && !mlog.some(([q]) => q.includes('DROP INDEX')), 'a missing index is created');

  /* ------------------------------------------------------------ vocabulary: normalising and judging names */
  const vocab = require('../core/vocab');
  const norm = (m, x) => vocab.analyse(m, x).norm;
  assert.equal(norm('term', 'Zero-knowledge proof'), 'zero knowledge proof');
  assert.equal(norm('term', 'zero knowledge proofs'), 'zero knowledge proof');
  assert.equal(norm('term', 'Zéro–Knowledge  PROOFS!'), 'zero knowledge proof', 'accents, dashes, case and plurals');
  assert.equal(norm('term', 'ZKPs'), 'zkp');
  assert.equal(norm('person', 'Lovelace, Ada'), 'ada lovelace'); assert.equal(norm('person', 'José García'), 'jose garcia');
  assert.equal(norm('name', 'Proceedings of Systems'), 'proceedings of systems', 'proper names are not singularised');
  assert.deepEqual(['analysis', 'physics', 'process', 'policies', 'approaches', 'news', 'gas'].map(vocab.singular), ['analysis', 'physics', 'process', 'policy', 'approach', 'news', 'gas']);
  assert.deepEqual(vocab.analyse('term', 'ZERO KNOWLEDGE PROOF').acr, [false, false, false], 'a shouted phrase is not a row of acronyms');
  const VJ = (a, b, aliases = []) => vocab.judge(vocab.analyse('term', a), 'term', { name: b, aliases });
  assert.equal(VJ('zero knowledge proofs', 'Zero-knowledge proof'), 'exact');
  assert.equal(VJ('ZK proofs', 'Zero-knowledge proof'), 'acronym');
  assert.equal(VJ('ZKP', 'zero knowledge proof'), 'acronym');
  assert.equal(VJ('ZKP', 'ZK proofs'), 'acronym', 'two acronym spellings match each other directly');
  // a word written in capitals next to lowercase text is tried both as an acronym and as a word
  assert.equal(VJ('ZK proofs rollup', 'ZERO KNOWLEDGE PROOF rollup'), 'acronym');
  assert.equal(VJ('ZERO KNOWLEDGE PROOFS in practice', 'ZKP in practice'), 'acronym');
  assert.deepEqual(vocab.analyse('term', 'ZERO KNOWLEDGE PROOF rollup').sigs, ['zerokproofr', 'zkpr']);
  assert.deepEqual(vocab.derived('Topic', 'ZKP', ['ZK proofs']).aliases_letters, ['zkp', 'zp'], 'every signature of an alias is stored');
  assert.equal(VJ('AI systems', 'artificial intelligence systems'), 'acronym');
  assert.equal(VJ('ZK', 'zero knowledge'), null, 'two letters and no shared word: too ambiguous');
  assert.equal(VJ('ZK proofs', 'ZK theorems'), null, 'shared letters do not excuse different words');
  assert.equal(VJ('ZKP', 'zero knowledge theorem'), null, 'every letter must line up');
  assert.equal(VJ('zero knowledge proof systems', 'ZKP'), null, 'a longer name is not an acronym match');
  assert.deepEqual(['ZKP', 'ZK proofs', 'zero-knowledge proofs', 'privacy'].map((x) => vocab.analyse('term', x).letters), ['zkp', 'zkp', 'zkp', null]);
  assert.equal(VJ('central bank digital currency', 'digital currency', ['CBDC', 'central bank digital currency']), 'alias');
  assert.equal(VJ('CBDC', 'central bank digital currency'), 'acronym'); assert.equal(VJ('central bank digital currency', 'CBDC'), 'acronym', 'either side may be the acronym');
  assert.equal(VJ('cryptograpy', 'Cryptography'), 'typo');
  for (const [a, b] of [['AI', 'art investing'], ['zk proofs', 'zero knowledge proof'], ['formal methods', 'normal methods'], ['proof zero knowledge', 'zero knowledge proof'],
    ['zero knowledge', 'zero knowledge proof'], ['cryptograpy protocoll', 'cryptography protocol'], ['privacy', 'privacy engineering'], ['cryptograpy theory', 'cryptography theories of x'], ['model checking', 'modal checking']]) {
    assert.equal(VJ(a, b), null, `"${a}" must not match "${b}"`);
  }
  assert.equal(vocab.lucene(vocab.analyse('term', 'ZK cryptographic proofs')), 'cryptographic~1 OR proof', 'acronyms are not searched; long words fuzzy');
  assert.equal(vocab.labelOf('topic'), 'Topic'); assert.throws(() => vocab.labelOf('Paper'), (e) => e.status === 400);
  assert.deepEqual(vocab.derived('Domain', 'Digital currency', ['CBDC', 'cbdc', 'Central bank digital currencies']),
    { norm: 'digital currency', letters: 'dc', letters_plain: null, aliases_norm: ['cbdc', 'central bank digital currency'], aliases_letters: ['cbdc'], aliases_text: 'cbdc | central bank digital currency' });

  /* ------------------------------------------------------------ vocabulary: resolve() against a fake graph */
  const rec = (o) => ({ get: (k) => o[k] });
  const ZKP = { key: 'concept:zero-knowledge-proof', name: 'Zero-knowledge proof', aliases: [] };
  let reads; let vtx;
  const fakeGraph = ({ exact = [], fuzzy = [], locked: underLock = [], ftFails = false } = {}) => {
    reads = []; vtx = [];
    runImpl = async (q, p) => { reads.push([q, p]); if (q.includes('fulltext.queryNodes')) { if (ftFails) throw new Error('no such index'); return fuzzy; } return exact; };
    txImpl = async (q, p) => { vtx.push([q, p]); if (q.includes('LIMIT 200') || q.includes('RETURN n.key AS key, n.name AS name')) return { records: underLock.map(rec) }; return { records: [] }; };
  };
  fakeGraph({ exact: [ZKP] });
  assert.deepEqual(await vocab.resolve('concept', 'zero knowledge proofs'), { key: ZKP.key, name: ZKP.name, created: false, match: 'exact' });
  assert.equal(reads[0][1].norm, 'zero knowledge proof'); assert.equal(vtx.length, 0, 'an exact match writes nothing');
  assert.deepEqual(reads[0][1].sigs, ['zkp']); assert.ok(reads[0][0].includes('n.letters IN $sigs OR n.letters_plain IN $sigs') && /ORDER BY CASE WHEN n.norm = \$norm OR \$norm IN coalesce\(n.aliases_norm, \[\]\) THEN 0 ELSE 1 END/.test(reads[0][0]), 'acronym candidates by letters; exact hits sort first');

  fakeGraph({ fuzzy: [ZKP], locked: [ZKP] });
  const zk = await vocab.resolve('Concept', 'ZK proofs');
  assert.deepEqual([zk.key, zk.match, zk.created], [ZKP.key, 'acronym', false]);
  assert.ok(vtx[0][0].includes('MERGE (l:VocabLock {label:$label})') && vtx[0][1].label === 'Concept', 'alias writes take the lock first');
  const aliasSet = vtx.find(([q]) => q.includes('SET n.aliases = $aliases'));
  assert.deepEqual([aliasSet[1].aliases, aliasSet[1].an], [['ZK proofs'], ['zk proof']], 'the spelling is learnt as an alias');

  fakeGraph({ fuzzy: [ZKP], locked: [ZKP] });
  assert.equal((await vocab.resolve('Concept', 'ZK proofs', { create: false })).match, 'acronym'); assert.equal(vtx.length, 0, 'create:false never writes');
  fakeGraph();
  assert.deepEqual(await vocab.resolve('Concept', 'Homomorphic encryption', { create: false }), { key: null, name: 'Homomorphic encryption', created: false, match: null });
  assert.equal(vtx.length, 0);

  fakeGraph();
  const made = await vocab.resolve('Concept', 'Zero-knowledge proofs', { aliases: ['ZKP'], model: 'claude-x' });
  assert.deepEqual(made, { key: 'concept:zero-knowledge-proof', name: 'Zero-knowledge proofs', created: true, match: 'new' });
  const vq = vtx.map(([q]) => q);
  assert.ok(vq[0].includes('VocabLock') && vq[1].includes('LIMIT 200') && vq[2].startsWith('MERGE (n:Concept {key:$key})'), 'lock, re-check, then create');
  assert.ok(vq[2].includes('ON CREATE SET') && vq[2].includes("n.record_status = 'auto'"));
  assert.deepEqual([vtx[2][1].by, vtx[2][1].model, vtx[2][1].aliases, vtx[2][1].derived.norm, vtx[2][1].derived.aliases_norm], ['claude', 'claude-x', ['ZKP'], 'zero knowledge proof', ['zkp']]);
  assert.deepEqual(vtx[1][1].words, ['zero', 'knowledge', 'proof']);
  assert.ok(vq[2].includes('n.by = $by') && vq[2].includes('n.model = $model'), 'provenance is written on create');
  fakeGraph();
  await vocab.resolve('Concept', 'ZK proofs of it');
  assert.deepEqual(vtx[1][1].words, ['proof'], 'the locked re-check scans ordinary words of 3+ letters only');

  fakeGraph({ exact: [{ key: 'concept:a', name: 'cryptograpy', aliases: [] }, { key: 'concept:b', name: 'Cryptography', aliases: [] }] });
  assert.equal((await vocab.resolve('Concept', 'cryptography')).key, 'concept:b', 'an exact match beats a typo match that sorts first');
  fakeGraph({ fuzzy: [ZKP], locked: [{ ...ZKP, aliases: ['ZK-proofs'] }] });
  await vocab.resolve('Concept', 'ZK proofs');
  assert.ok(!vtx.some(([q]) => q.includes('SET n.aliases')), 'a spelling already learnt (by a parallel call) is not added twice');

  fakeGraph({ locked: [{ key: 'concept:zkp-by-someone', name: 'zero knowledge proof', aliases: [] }] });
  const raced = await vocab.resolve('Concept', 'Zero-knowledge proofs');
  assert.deepEqual([raced.key, raced.created], ['concept:zkp-by-someone', false], 'a node created meanwhile is found under the lock');
  assert.ok(!vtx.some(([q]) => q.startsWith('MERGE (n:Concept')), 'and no second node is created');

  fakeGraph({ ftFails: true });
  assert.equal((await vocab.resolve('Topic', 'Payments')).created, true, 'a missing full-text index only disables fuzzy matching');
  fakeGraph();
  await assert.rejects(() => vocab.resolve('Concept', ' -- '), (e) => e.status === 400);
  await assert.rejects(() => vocab.resolve('Concept', 'x'.repeat(201)), (e) => e.status === 400);
  await assert.rejects(() => vocab.resolve('Paper', 'x'), (e) => e.status === 400);
  runImpl = async () => []; txImpl = null;

  /* ------------------------------------------------------------ vocabulary: the hub's own writers stamp matcher fields */
  calls.length = 0;
  await artifacts.add('note', { title: 'Vocab note', concepts: ['Zero-knowledge-proofs'] });
  const conceptMerge = calls.find(([q]) => q.includes('MERGE (t:Concept'));
  assert.ok(conceptMerge[0].includes('t += $tderived')); assert.deepEqual(conceptMerge[1].tderived, { norm: 'zero knowledge proof', letters: 'zkp', letters_plain: null });
  txLog.length = 0;
  txImpl = async (q, p) => { txLog.push([q, p]); return null; };
  await notes.sync([{ path: 'notes/v.md', meta: { concepts: ['Smart contracts'] } }], { prune: false });
  const cRows = txLog.find(([q]) => q.includes('MERGE (c:Concept'));
  assert.ok(cRows[0].includes('c += r.derived')); assert.deepEqual(cRows[1].rows[0].derived, { norm: 'smart contract', letters: 'sc', letters_plain: null });
  txLog.length = 0;
  txImpl = async (q, p) => { txLog.push([q, p]); return q.includes('RETURN count(x)') ? { records: [{ get: () => ({ toNumber: () => p.rows.length }) }] } : { records: [] }; };
  await backup.restore({ ...F, nodes: [{ labels: ['Concept'], props: { key: 'concept:a', name: 'Smart contracts' } }, { labels: ['Concept'], props: { key: 'concept:b', name: 'B', norm: 'kept' } }] });
  const restored = txLog.find(([q]) => q.includes('MERGE (n:Concept')) [1].rows;
  assert.equal(restored.find((r) => r.key === 'concept:a').props.norm, 'smart contract', 'old backups get the derived fields');
  assert.equal(restored.find((r) => r.key === 'concept:b').props.norm, 'kept');
  txImpl = null;

  /* ------------------------------------------------------------ vocabulary: migration 006 */
  const m006 = require('../migrations/006_vocab_matching');
  const m6 = [];
  let pending = { Person: [{ key: 'person:jos-garc-a', name: 'José García', aliases: [] }], Concept: [{ key: 'concept:smart-contracts', name: 'smart contracts', aliases: ['SC'] }, { key: 'concept:x', name: null, aliases: [] }, { key: 'concept:dash', name: '--', aliases: [] }] };
  await m006.up({ run: async (q, p) => {
    m6.push([q, p]);
    const label = (q.match(/^MATCH \(n:(\w+)\) WHERE n.norm IS NULL/) || [])[1];
    if (label) { const out = pending[label] || []; pending[label] = []; return out.map((r) => ({ ...r, name: r.name || r.key })); }
    return [];
  } });
  const m6q = m6.map(([q]) => q).join('\n');
  for (const l of ['person', 'concept', 'topic', 'domain', 'venue', 'organisation', 'dataset']) assert.ok(m6q.includes(`CREATE INDEX ${l}_norm IF NOT EXISTS`) && m6q.includes(`CREATE INDEX ${l}_letters IF NOT EXISTS`), l);
  assert.ok(m6q.includes('CREATE FULLTEXT INDEX vocab_text IF NOT EXISTS FOR (n:Person|Concept|Topic|Domain|Venue|Organisation|Dataset) ON EACH [n.norm, n.aliases_text]'));
  assert.ok(m6q.includes('REQUIRE l.label IS UNIQUE')); assert.deepEqual(m6.find(([q]) => q.includes('MERGE (:VocabLock'))[1].labels, S.entityLabels);
  const backfill = m6.filter(([q]) => q.startsWith('UNWIND $rows AS r MATCH')).flatMap(([, p]) => p.rows);
  assert.deepEqual(backfill.find((r) => r.key === 'person:jos-garc-a').props.norm, 'jose garcia');
  assert.deepEqual(backfill.find((r) => r.key === 'concept:smart-contracts').props, { norm: 'smart contract', letters: 'sc', letters_plain: null, aliases_norm: ['sc'], aliases_letters: ['sc'], aliases_text: 'sc' });
  assert.equal(backfill.find((r) => r.key === 'concept:x').props.norm, 'x', 'a node without a name is matched by its key');
  assert.equal(backfill.find((r) => r.key === 'concept:dash').props.norm, 'concept:dash', 'norm is never left empty');

  /* ------------------------------------------------------------ items: an in-memory graph behind the fake db */
  const items = require('../core/items');
  const G = new Map(); // key -> { labels, props, out: [{ rel, to, r }] }
  const gRow = (k) => {
    const n = G.get(k); if (!n) return null;
    const out = n.out.map((e) => { const t = G.get(e.to) || { labels: [], props: {} }; return { rel: e.rel, r: { ...e.r }, key: e.to, name: t.props.name ?? t.props.title, labels: t.labels }; });
    const inc = [...G.entries()].flatMap(([sk, sn]) => sn.out.filter((e) => e.to === k).map((e) => ({ rel: e.rel, r: { ...e.r }, key: sk, name: sn.props.title, labels: sn.labels })));
    return { labels: [...n.labels], props: { ...n.props }, out, inc };
  };
  const gRecs = (rows) => ({ records: rows.map((o) => ({ get: (k) => o[k] })) });
  const gTx = async (q, p) => {
    calls.push([q, p]);
    if (q.includes('AS inc')) { const r = gRow(p.key); return gRecs(r ? [r] : []); }
    if (q.startsWith('MATCH (n:Artifact {key:$key}) RETURN labels(n) AS labels')) return gRecs(G.has(p.key) ? [{ labels: G.get(p.key).labels }] : []);
    if (q.includes('MERGE (n:Artifact {key:$key})')) {
      const label = q.match(/SET n:(\w+)/)[1];
      const n = G.get(p.key) || { labels: ['Artifact', label], props: { key: p.key, ...p.onCreate }, out: [] };
      Object.assign(n.props, p.props, p.sys, { source: 'hub' }); G.set(p.key, n); return gRecs([]);
    }
    if (q.includes("WHERE r.source = 'hub' DELETE r")) { const n = G.get(p.key); if (n) n.out = n.out.filter((e) => e.r.source !== 'hub'); return gRecs([]); }
    const tm = q.match(/MERGE \(t:(\w+) \{key:\$tkey\}\)/);
    if (tm) { if (!G.has(p.tkey)) G.set(p.tkey, { labels: [tm[1]], props: { key: p.tkey, ...p.tprops }, out: [] }); G.get(p.key).out.push({ rel: q.match(/MERGE \(n\)-\[r:(\w+)\]->\(t\)/)[1], to: p.tkey, r: { source: 'hub' } }); return gRecs([]); }
    const del = q.match(/^MATCH \(n:Artifact \{key:\$key\}\)-\[r:(\w+)\]->\(t:(\w+)\) WHERE r.field = \$field OR r.field IS NULL DELETE r/);
    if (del) { const n = G.get(p.key); n.out = n.out.filter((e) => !(e.rel === del[1] && (G.get(e.to) || { labels: [] }).labels.includes(del[2]) && (e.r.field == null || e.r.field === p.field))); return gRecs([]); }
    const mk = q.match(/MATCH \(t:(\w+) \{key:x.key\}\)\s+MERGE \(n\)-\[r:(\w+)\]->\(t\)/);
    if (mk) {
      const n = G.get(p.key); const ok = [];
      for (const x of p.rows) { if (!G.has(x.key) || !G.get(x.key).labels.includes(mk[1])) continue; n.out = n.out.filter((e) => !(e.rel === mk[2] && e.to === x.key)); n.out.push({ rel: mk[2], to: x.key, r: { field: p.field, position: x.position, source: 'items', by: p.by, at: p.at } }); ok.push({ key: x.key, name: G.get(x.key).props.name ?? G.get(x.key).props.title }); }
      return gRecs(ok);
    }
    if (q.startsWith('MATCH (n:Artifact {key:$key}) SET n += $sets')) { const n = G.get(p.key); for (const [k, v] of Object.entries(p.sets)) { if (v == null) delete n.props[k]; else n.props[k] = v; } n.props.provenance_json = p.prov; return gRecs([]); }
    const lk = q.match(/OPTIONAL MATCH \(n\)-\[old:(\w+)\]->\(t\)/);
    if (lk) { const n = G.get(p.key); const fresh = !n.out.some((e) => e.rel === lk[1] && e.to === p.tkey); n.out = n.out.filter((e) => !(e.rel === lk[1] && e.to === p.tkey)); n.out.push({ rel: lk[1], to: p.tkey, r: { ...p.props } }); return gRecs([{ fresh }]); }
    const ul = q.match(/-\[x:(\w+)\]->\(t \{key:\$target\}\) WITH collect/);
    if (ul) { const n = G.get(p.key); const before = n.out.length; n.out = n.out.filter((e) => !(e.rel === ul[1] && e.to === p.target)); return gRecs([{ n: before - n.out.length }]); }
    if (q.includes('DETACH DELETE n')) { G.delete(p.key); return gRecs([]); }
    if (q.startsWith('MATCH (a:Artifact {key:$key}) RETURN a.key')) return gRecs(G.has(p.key) ? [{ 'a.key': p.key }] : []); // personal layer
    return gRecs([]);
  };
  const gRun = async (q, p) => {
    if (q.includes('AS inc')) { const r = gRow(p.key); return r ? [r] : []; }
    if (q.startsWith('MATCH (n:Artifact {key:$key}) RETURN n.key AS key')) return G.has(p.key) ? [{ key: p.key }] : [];
    if (q.startsWith('MATCH (t {key:$k}) RETURN labels(t)')) return G.has(p.k) ? [{ labels: G.get(p.k).labels }] : [];
    return [];
  };
  const resolved = [];
  const realResolve = vocab.resolve;
  vocab.resolve = async (kind, name, opts = {}) => {
    const label = vocab.labelOf(kind);
    resolved.push([label, name, opts]);
    const key = schema.entities[label].key_prefix + vocab.analyse(schema.entities[label].match, name).norm.replace(/ /g, '-');
    if (opts.create === false) return { key: G.has(key) ? key : null, created: false, match: G.has(key) ? 'exact' : null };
    if (!G.has(key)) G.set(key, { labels: [label], props: { key, name, by: opts.by }, out: [] });
    return { key, name, created: true, match: 'new' };
  };
  runImpl = gRun; txImpl = gTx;

  /* ------------------------------------------------------------ items: create and read, all four collections */
  const mItem = await items.create({ collection: 'method', fields: { title: 'Snowball sampling', kind: 'technique', procedure: ['seed', 'expand'], domain: ['Research methodology'], strengths: 'cheap', mood: 'kept', status: 'reading' } });
  assert.deepEqual([mItem.key, mItem.created], ['method:snowball-sampling', true]);
  assert.ok(mItem.warnings.includes('status: set your reading status with /api/personal'), 'a reading status is never stored on the item');
  assert.deepEqual(mItem.warnings.filter((w) => /schema \(kept as is\)|status/.test(w)), ['status: set your reading status with /api/personal', 'not in the method schema (kept as is): mood'], 'one accurate message per unknown field');
  assert.ok(mItem.warnings.includes('strengths: expected a list') && mItem.warnings.includes('not in the method schema (kept as is): mood'));
  const mNode = G.get('method:snowball-sampling');
  assert.deepEqual(mNode.props.procedure, ['seed', 'expand']); assert.equal(mNode.props.status, undefined); assert.equal(mNode.props.mood, 'kept');
  assert.deepEqual([mNode.props.collection, mNode.props.managed, mNode.props.record_status], ['method', 'db', 'reviewed'], 'the owner\'s own item needs no review');
  assert.deepEqual(JSON.parse(mNode.props.provenance_json).kind, { by: 'owner', at: JSON.parse(mNode.props.provenance_json).kind.at, status: 'reviewed' });
  assert.deepEqual(mNode.out.find((e) => e.rel === 'ABOUT').r, { field: 'domain', position: 0, source: 'items', by: 'owner', at: mNode.out[0].r.at });
  assert.equal(resolved.at(-1)[2].by, 'owner', 'vocabulary created by an owner write is flagged by=owner');
  const mGot = await items.get('method:snowball-sampling');
  assert.deepEqual(mGot.fields.domain, [{ key: 'domain:research-methodology', name: 'Research methodology' }]);
  assert.deepEqual([mGot.fields.kind, mGot.fields.purpose, mGot.extra, mGot.record_status, mGot.collection], ['technique', null, { mood: 'kept' }, 'reviewed', 'method']);
  assert.ok(!('record_status' in mGot.fields) && !('provenance' in mGot.fields) && !('mood' in mGot.fields));
  await assert.rejects(() => items.create({ collection: 'method', fields: { title: 'Snowball sampling' } }), (e) => e.status === 409);
  await assert.rejects(() => items.create({ collection: 'note', fields: { title: 'n' } }), (e) => e.status === 400 && /collection must be one of/.test(e.message));
  await assert.rejects(() => items.create({ collection: 'use_case', fields: { goal: 'no title' } }), (e) => e.status === 400 && /title is required/.test(e.message));

  const ucItem = await items.create({ collection: 'use_case', fields: { title: 'Offline payments', status: 'idea', actors: [{ role: 'payer', organisation_type: 'bank' }], requirements: [{ kind: 'quality', text: 'works offline' }] } });
  assert.equal(ucItem.key, 'usecase:offline-payments');
  const ucNode = G.get('usecase:offline-payments');
  assert.equal(ucNode.props.actors_json, '[{"role":"payer","organisation_type":"bank"}]'); assert.equal(ucNode.props.actors, undefined); assert.equal(ucNode.props.status, 'idea', "a use case's own status is a field");
  assert.deepEqual((await items.get('usecase:offline-payments')).fields.requirements, [{ kind: 'quality', text: 'works offline' }], 'objects come back parsed');
  const csItem = await items.create({ collection: 'case_study', slug: 'lisbon', fields: { title: 'Lisbon CBDC pilot', case_type: 'pilot', organisations: ['ECB', 'Banco de Portugal'], sector: 'Payments', sources: [{ url: 'https://example.org/r' }] } });
  assert.equal(csItem.key, 'case:lisbon');
  const csGot = await items.get('case:lisbon');
  assert.deepEqual(csGot.fields.organisations.map((o) => o.key), ['org:ecb', 'org:banco-de-portugal'], 'ordered as given, not alphabetically');
  assert.deepEqual(csGot.fields.sector, { key: 'domain:payment', name: 'Payments' }, 'a single ref field is one value');

  /* ------------------------------------------------------------ items: papers through the paper writer */
  const pItem = await items.create({ collection: 'paper', fields: { title: 'Accumulators', authors: ['Ada Lovelace', 'Alan Turing'], year: 2024, item_type: 'conference_paper', venue: 'CRYPTO', contribution_type: 'empirical', research_problem: 'p' } });
  assert.equal(pItem.created, true); assert.ok(pItem.key.startsWith('paper:'));
  const pNode = G.get(pItem.key);
  assert.equal(pNode.props.item_type, 'conferencePaper', 'stored the way the CSL export expects'); assert.equal(pNode.props.contribution_type, 'empirical');
  const pGot = await items.get(pItem.key);
  assert.equal(pGot.fields.item_type, 'conference_paper', 'returned in the schema\'s values');
  assert.deepEqual(pGot.fields.authors.map((a) => a.name), ['Ada Lovelace', 'Alan Turing']);
  assert.deepEqual(pGot.fields.venue, { key: null, name: 'CRYPTO' }, 'text from the paper writer is shown with key null');
  assert.deepEqual([pGot.provenance.title.by, pGot.provenance.contribution_type.by, pGot.provenance.year.by], ['owner', 'owner', 'owner']);
  assert.ok(!('abstract' in pGot.provenance), 'no provenance for a field nobody filled');
  await items.update(pItem.key, { item_type: 'talk' });
  assert.equal(G.get(pItem.key).props.item_type, 'presentation', 'edits are stored in the paper writer\'s values');
  G.get(pItem.key).props.abstract = 'from Crossref';
  G.get(pItem.key).props.provenance_json = JSON.stringify({ ...JSON.parse(G.get(pItem.key).props.provenance_json), abstract: { by: 'source', status: 'auto' } });
  assert.equal((await items.write(pItem.key, { abstract: 'claude rewrite' }, { by: 'claude', force: true })).skipped[0].reason, 'not a claude field');
  assert.equal((await items.write(pItem.key, { peer_review: 'grey' }, { by: 'source' })).filled[0], 'peer_review');
  assert.equal((await items.write(pItem.key, { peer_review: 'preprint' }, { by: 'claude', force: true })).skipped[0].reason, 'already filled', 'force replaces only values Claude itself wrote');
  for (const f of ['doi', 'authors', 'venue']) await assert.rejects(() => items.update(pItem.key, { [f]: 'x' }), (e) => e.status === 400 && /cannot be edited on a paper/.test(e.message), f);

  /* ------------------------------------------------------------ items: owner edits and the merge rules */
  const up1 = await items.update('method:snowball-sampling', { kind: 'procedure', procedure: [], level: 'intermediate' });
  assert.deepEqual(up1.filled, ['kind', 'procedure', 'level']);
  assert.equal(G.get('method:snowball-sampling').props.procedure, undefined, 'the owner can clear a field');
  await assert.rejects(() => items.update('method:snowball-sampling', { title: '' }), (e) => e.status === 400 && /title is required/.test(e.message));
  assert.deepEqual((await items.update('method:snowball-sampling', { purpose: 'p' })).warnings, [], 'a PATCH is not warned about other empty Core fields');
  assert.deepEqual((await items.update('method:snowball-sampling', { tldr: '' })).warnings, ['tldr is empty (Core field)'], 'but emptying one is');
  await items.update('method:snowball-sampling', { domain: ['Payments'] });
  assert.deepEqual(G.get('method:snowball-sampling').out.filter((e) => e.rel === 'ABOUT').map((e) => e.to), ['domain:payment'], 'a ref field is replaced, not appended');
  assert.ok((await items.update('usecase:offline-payments', { actors_json: 'x' })).warnings.includes('ignored (reserved or not a valid field name): actors_json'));
  delete JSON.parse(G.get('method:snowball-sampling').props.provenance_json).purpose;
  G.get('method:snowball-sampling').props.provenance_json = JSON.stringify({ ...JSON.parse(G.get('method:snowball-sampling').props.provenance_json), purpose: undefined });
  G.get('method:snowball-sampling').props.when_to_use = 'legacy text, no provenance';
  resolved.length = 0;
  const cl = await items.write('method:snowball-sampling', {
    kind: 'tool', procedure: ['claude step'], when_to_use: 'claude', when_not_to_use: 'never', level: 'advanced', inputs: [], topics: ['Sampling'], domain: ['Payments'], mood2: 'x',
  }, { by: 'claude', model: 'claude-x', confidence: 'medium' });
  const why = Object.fromEntries(cl.skipped.map((x) => [x.field, x.reason]));
  assert.deepEqual(why, { kind: 'owner value', procedure: 'owner value', when_to_use: 'owner value', level: 'not a claude field', inputs: 'empty value', domain: 'owner value', mood2: 'not in the schema' });
  assert.deepEqual(cl.filled, ['when_not_to_use', 'topics']);
  const clProv = JSON.parse(G.get('method:snowball-sampling').props.provenance_json);
  assert.deepEqual({ ...clProv.when_not_to_use, at: 0 }, { by: 'claude', at: 0, model: 'claude-x', confidence: 'medium', status: 'auto' });
  assert.deepEqual(resolved.map(([l, n, o]) => [l, n, o.by]), [['Topic', 'Sampling', 'claude']], 'a skipped ref field never creates vocabulary');
  assert.equal(G.get('method:snowball-sampling').props.kind, 'procedure', 'owner edits are never overwritten');
  const again = await items.write('method:snowball-sampling', { when_not_to_use: 'claude v2' }, { by: 'claude' });
  assert.deepEqual(again.skipped, [{ field: 'when_not_to_use', reason: 'already filled' }]);
  const forced = await items.write('method:snowball-sampling', { when_not_to_use: 'claude v2' }, { by: 'claude', force: true });
  assert.deepEqual(forced.filled, ['when_not_to_use'], 'force replaces a value the same writer wrote');
  assert.deepEqual((await items.write('method:snowball-sampling', { when_to_use: 'x' }, { by: 'claude', force: true })).skipped[0].reason, 'owner value', 'force never touches owner values');
  await items.write('method:snowball-sampling', { example: 'claude example' }, { by: 'claude' });
  const pv = JSON.parse(G.get('method:snowball-sampling').props.provenance_json); pv.example.status = 'reviewed';
  G.get('method:snowball-sampling').props.provenance_json = JSON.stringify(pv);
  assert.equal((await items.write('method:snowball-sampling', { example: 'v2' }, { by: 'claude', force: true })).skipped[0].reason, 'owner value', 'a Claude value the owner reviewed is protected too');
  // the merge decision is re-checked inside the transaction: a field that became writable meanwhile is skipped, never cleared
  const realRun = runImpl;
  runImpl = async (q, p) => { const rows = await realRun(q, p); if (q.includes('AS inc') && rows[0]) rows[0].props.provenance_json = JSON.stringify({ ...JSON.parse(rows[0].props.provenance_json || '{}'), domain: { by: 'owner' } }); return rows; };
  resolved.length = 0;
  const stale = await items.write('usecase:offline-payments', { domain: ['Payments'] }, { by: 'claude' });
  runImpl = realRun;
  assert.deepEqual(stale.skipped, [{ field: 'domain', reason: 'changed while saving, try again' }]); assert.equal(resolved.length, 0);
  assert.ok(!G.get('usecase:offline-payments').out.some((e) => e.rel === 'ABOUT'), 'nothing was linked or cleared');
  await items.update('method:snowball-sampling', { when_not_to_use: 'owner says' });
  assert.equal((await items.write('method:snowball-sampling', { when_not_to_use: 'claude v3' }, { by: 'claude', force: true })).skipped[0].reason, 'owner value', 'once the owner edits a Claude value it is the owner\'s');
  await assert.rejects(() => items.write('method:snowball-sampling', {}, { by: 'robot' }), (e) => e.status === 400);
  await assert.rejects(() => items.write('method:snowball-sampling', {}, { by: 'claude', confidence: 'sure' }), (e) => e.status === 400);
  await assert.rejects(() => items.update('method:nope', { purpose: 'x' }), (e) => e.status === 404);
  assert.equal(items.blocked({ by: ['C'] }, 'source', 'v', null, null, false), 'not a source field');

  /* ------------------------------------------------------------ items: typed links */
  const lk1 = await items.link('method:snowball-sampling', { rel: 'addresses', target: 'usecase:offline-payments', evidence: 'section 2', location: 'p. 3', confidence: 'high' });
  assert.deepEqual(lk1, { key: 'method:snowball-sampling', rel: 'ADDRESSES', target: 'usecase:offline-payments', created: true });
  const lkEdge = G.get('method:snowball-sampling').out.find((e) => e.rel === 'ADDRESSES');
  assert.deepEqual([lkEdge.r.evidence, lkEdge.r.location, lkEdge.r.confidence, lkEdge.r.by, lkEdge.r.status, lkEdge.r.source], ['section 2', 'p. 3', 'high', 'owner', 'reviewed', 'items']);
  assert.equal((await items.link('method:snowball-sampling', { rel: 'ADDRESSES', target: 'usecase:offline-payments' })).created, false);
  assert.ok((await items.get('usecase:offline-payments')).links.in.some((l) => l.rel === 'ADDRESSES' && l.key === 'method:snowball-sampling'));
  await assert.rejects(() => items.link('method:snowball-sampling', { rel: 'ADDRESSES', target: pItem.key }), (e) => e.status === 400 && /ADDRESSES goes from Method to UseCase, not Method to Paper/.test(e.message));
  await assert.rejects(() => items.link('usecase:offline-payments', { rel: 'ADDRESSES', target: 'method:snowball-sampling' }), (e) => e.status === 400);
  await assert.rejects(() => items.link('usecase:offline-payments', { rel: 'ADDRESSES', target: 'usecase:offline-payments' }), (e) => e.status === 400 && /from Method/.test(e.message), 'the source label is checked too');
  await assert.rejects(() => items.link('method:snowball-sampling', { rel: 'LIKES', target: 'usecase:offline-payments' }), (e) => e.status === 400 && /Unknown relation/.test(e.message));
  await assert.rejects(() => items.link('method:snowball-sampling', { rel: 'ADDRESSES', target: 'usecase:offline-payments', confidence: 'sure' }), (e) => e.status === 400);
  await assert.rejects(() => items.link('method:snowball-sampling', { rel: 'ADDRESSES', target: 'usecase:offline-payments', evidence: 'x'.repeat(2001) }), (e) => e.status === 400);
  await assert.rejects(() => items.link('method:snowball-sampling', { rel: 'ADDRESSES', target: 'usecase:missing' }), (e) => e.status === 404);
  assert.equal((await items.link('case:lisbon', { rel: 'about', target: { kind: 'topic', name: 'Retail CBDC' } })).target, 'topic:retail-cbdc');
  assert.equal((await items.unlink('method:snowball-sampling', { rel: 'addresses', target: 'usecase:offline-payments' })).deleted, 1);
  await assert.rejects(() => items.unlink('method:snowball-sampling', { rel: 'addresses', target: 'usecase:offline-payments' }), (e) => e.status === 404);

  /* ------------------------------------------------------------ items: HTTP routes (real Express, encoded DOI keys) */
  G.set('doi:10.1/a/b', { labels: ['Artifact', 'Paper'], props: { key: 'doi:10.1/a/b', title: 'Slashes', collection: 'paper' }, out: [] });
  G.set('note:n', { labels: ['Artifact', 'Note'], props: { key: 'note:n', title: 'N' }, out: [] });
  const appX = require('express')();
  require('../features/items').mount(appX);
  appX.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const srv = await new Promise((ok) => { const x = appX.listen(0, '127.0.0.1', () => ok(x)); });
  const iBase = `http://127.0.0.1:${srv.address().port}`;
  const H = { Authorization: 'Bearer abc', 'Content-Type': 'application/json' };
  try {
    for (const [m, u] of [['GET', '/api/items?collection=method'], ['POST', '/api/items'], ['GET', '/api/items/x%3Ay'], ['PATCH', '/api/items/x%3Ay'], ['DELETE', '/api/items/x%3Ay'], ['PUT', '/api/items/x%3Ay/links'], ['DELETE', '/api/items/x%3Ay/links']]) {
      assert.equal((await fetch(iBase + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: ['GET', 'DELETE'].includes(m) ? undefined : '{}' })).status, 401, `${m} ${u} is owner only`);
    }
    const g1 = await (await fetch(`${iBase}/api/items/${encodeURIComponent('doi:10.1/a/b')}`, { headers: H })).json();
    assert.equal(g1.key, 'doi:10.1/a/b', 'a DOI key with slashes round-trips');
    assert.equal((await fetch(`${iBase}/api/items/${encodeURIComponent('note:n')}`, { headers: H })).status, 404, 'notes are not collection items');
    const pr = await fetch(`${iBase}/api/items`, { method: 'POST', headers: H, body: JSON.stringify({ collection: 'use_case', fields: { title: 'Via HTTP' } }) });
    assert.equal(pr.status, 201);
    const pa = await fetch(`${iBase}/api/items/${encodeURIComponent('usecase:via-http')}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { goal: 'g' } }) });
    assert.deepEqual((await pa.json()).filled, ['goal']);
    const lp = await fetch(`${iBase}/api/items/${encodeURIComponent('method:snowball-sampling')}/links`, { method: 'PUT', headers: H, body: JSON.stringify({ rel: 'ADDRESSES', target: 'usecase:via-http' }) });
    assert.equal((await lp.json()).created, true);
    const ld = await fetch(`${iBase}/api/items/${encodeURIComponent('method:snowball-sampling')}/links?rel=ADDRESSES&target=${encodeURIComponent('usecase:via-http')}`, { method: 'DELETE', headers: H });
    assert.equal((await ld.json()).deleted, 1);
    assert.equal((await fetch(`${iBase}/api/items/${encodeURIComponent('usecase:via-http')}`, { method: 'DELETE', headers: H })).status, 200);
    assert.ok(!G.has('usecase:via-http'));
    assert.equal((await fetch(`${iBase}/api/items/${encodeURIComponent('note:n')}`, { method: 'DELETE', headers: H })).status, 404, 'DELETE only removes collection items');
  } finally { srv.close(); }

  /* ------------------------------------------------------------ items: listing (query building) */
  let lq = [];
  runImpl = async (q, p) => {
    lq.push([q, p]);
    if (q.includes('fulltext.queryNodes')) return [{ key: 'method:a' }];
    if (q.includes('count(n) AS total')) return [{ total: 3 }];
    if (q.includes('ORDER BY s')) return [1, 2, 3].map((i) => ({ key: `method:m${i}`, s: `t${i}`, labels: ['Artifact', 'Method'], props: { key: `method:m${i}`, title: `T${i}`, kind: 'tool', domain: i === 3 ? 'research' : undefined }, e_domain: i === 1 ? [{ key: 'domain:payment', name: 'Payments' }] : [] }));
    return [];
  };
  const page1 = await items.list({ collection: 'method', kind: 'tool,metric', domain: 'Payments,domain:x', q: 'snow', sort: 'title', limit: '2' });
  const [listQ, listP] = lq.find(([q]) => q.includes('ORDER BY s'));
  assert.ok(listQ.includes('n.`kind` IN $f_kind') && listQ.includes('EXISTS { MATCH (n)-[:ABOUT]->(t:Domain) WHERE t.key IN $f_domain }') && listQ.includes('n.key IN $qkeys'));
  assert.deepEqual([listP.f_kind, listP.f_domain, listP.qkeys], [['tool', 'metric'], ['domain:payment', 'domain:x'], ['method:a']]);
  assert.ok(listQ.includes("toLower(toString(coalesce(n.`title`, ''))) AS s") && listQ.includes('ORDER BY s ASC, n.key ASC'));
  assert.equal(listP.limit.toNumber(), 3, 'one extra row tells whether there is a next page');
  assert.deepEqual([page1.items.length, page1.total], [2, 3]);
  assert.deepEqual(page1.items[0], { key: 'method:m1', title: 'T1', record_status: null, updated_at: null, kind: 'tool', level: null, maturity: null, domain: [{ key: 'domain:payment', name: 'Payments' }] });
  assert.deepEqual(items.decodeCursor(page1.next_cursor), ['t2', 'method:m2']);
  lq = [];
  await items.list({ collection: 'method', sort: '-updated_at', cursor: page1.next_cursor });
  const [q2, p2] = lq.find(([q]) => q.includes('ORDER BY s'));
  assert.ok(q2.includes('coalesce(n.`updated_at`.epochMillis, 0) AS s') && q2.includes('WHERE s < $cs OR (s = $cs AND n.key < $ck)') && q2.includes('ORDER BY s DESC, n.key DESC'));
  assert.deepEqual([p2.cs, p2.ck], ['t2', 'method:m2']);
  lq = [];
  assert.equal((await items.list({ collection: 'method', limit: '3' })).next_cursor, null, 'an exactly full last page has no next page');
  lq = [];
  const p3 = await items.list({ collection: 'method' });
  assert.equal(p3.next_cursor, null, 'no next page when the extra row is absent'); assert.equal(lq.find(([q]) => q.includes('ORDER BY s'))[1].limit.toNumber(), 26);
  assert.deepEqual(p3.items[2].domain, [{ key: null, name: 'research' }], 'older text values show in list columns');
  lq = [];
  await items.list({ collection: 'paper', item_type: 'journal_article', sort: '-year', limit: '1000' });
  const [q4, p4] = lq.find(([q]) => q.includes('ORDER BY s'));
  assert.deepEqual(p4.f_item_type, ['journalArticle']); assert.ok(q4.includes('coalesce(toInteger(n.`year`), -999999999) AS s')); assert.equal(p4.limit.toNumber(), 101, 'limit is capped at 100');
  lq = [];
  runImpl = async (q, p) => { lq.push([q, p]); if (q.includes('fulltext')) throw new Error('no index'); return q.includes('count(n)') ? [{ total: 0 }] : []; };
  await items.list({ collection: 'use_case', q: 'Offline' });
  assert.ok(lq.find(([q]) => q.includes('ORDER BY s'))[0].includes("toLower(coalesce(n.title, '')) CONTAINS $qtext"), 'title scan when the index is missing');
  lq = [];
  await items.list({ collection: 'case_study', sector: 'Unknown sector' });
  assert.deepEqual(lq.find(([q]) => q.includes('ORDER BY s'))[1].f_sector, [], 'an unknown vocabulary name matches nothing (and creates nothing)');
  await assert.rejects(() => items.list({ collection: 'method', colour: 'red' }), (e) => e.status === 400 && /filters for method: kind, level, maturity, domain, topics/.test(e.message));
  await assert.rejects(() => items.list({ collection: 'method', sort: 'purpose' }), (e) => e.status === 400 && /sort must be one of/.test(e.message));
  await assert.rejects(() => items.list({ collection: 'method', cursor: 'garbage' }), (e) => e.status === 400 && /invalid cursor/.test(e.message));
  await assert.rejects(() => items.list({}), (e) => e.status === 400);
  vocab.resolve = realResolve; runImpl = async () => []; txImpl = null;

  /* ------------------------------------------------------------ vocabulary: migration 008 */
  const m008 = require('../migrations/008_vocab_letters_plain');
  const m8 = [];
  const pages8 = { Topic: [[{ key: 'topic:zero-knowledge-proof-x', name: 'ZERO KNOWLEDGE PROOF x', aliases: ['ZK proofs x'] }]] };
  await m008.up({ run: async (q, p) => {
    m8.push([q, p]);
    const lab = (q.match(/^MATCH \(n:(\w+)\) RETURN n.key AS key/) || [])[1];
    if (lab) { const skip = Number(q.match(/SKIP (\d+)/)[1]); return skip === 0 ? (pages8[lab] || [[]])[0] : []; }
    return [];
  } });
  for (const l of S.entityLabels) assert.ok(m8.some(([q]) => q.includes(`CREATE INDEX ${l.toLowerCase()}_letters_plain IF NOT EXISTS`)), l);
  const p8 = m8.find(([q]) => q.startsWith('UNWIND $rows AS r MATCH (n:Topic'))[1].rows[0].props;
  assert.deepEqual([p8.letters, p8.letters_plain, p8.aliases_letters], ['zerokproofx', 'zkpx', ['zkpx', 'zpx']]);
  assert.ok(m8.find(([q]) => q.startsWith('MATCH (n:Topic) RETURN'))[0].includes('ORDER BY n.key SKIP 0 LIMIT 500'), 'stable paging over every node');

  /* ------------------------------------------------------------ analysis: one call, against the in-memory graph */
  const analysis = require('../core/analysis');
  const audit = require('../core/audit');
  const crossref = require('../features/papers/crossref');
  const openalex = require('../core/openalex');
  const srcNet = [];
  let crossrefDown = false, openalexDown = false;
  const JR = (obj, status = 200) => ({ ok: status < 300, status, json: async () => obj });
  crossref.setHttp(async (url) => {
    srcNet.push(url);
    if (crossrefDown) return JR({}, 500);
    if (url.endsWith(encodeURIComponent('10.5555/abc'))) return JR({ message: { type: 'journal-article', title: ['Private Payments at Scale'], DOI: '10.5555/ABC', URL: 'https://doi.org/10.5555/abc',
      author: [{ given: 'José', family: 'García' }, { given: 'Ada', family: 'Lovelace' }], issued: { 'date-parts': [[2023, 4]] }, 'container-title': ['Journal of Payments'], abstract: '<p>An abstract.</p>' } });
    return JR({}, 404);
  });
  openalex.setHttp(async (url) => {
    srcNet.push(url);
    if (openalexDown) return JR({}, 500);
    if (url.includes('10.9/hybrid')) return JR({ id: 'https://openalex.org/W9', cited_by_count: 1, open_access: { oa_status: 'hybrid' } });
    if (url.includes('10.5555/abc')) return JR({ id: 'https://openalex.org/W123', cited_by_count: 12, open_access: { oa_status: 'green' }, language: 'en', primary_location: { source: { display_name: 'J. Payments' } } });
    return JR({}, 404);
  });
  const aRun = async (q, p) => {
    if (q.startsWith('MATCH (p:Paper {url:$url})')) return [...G.values()].filter((n) => n.labels.includes('Paper') && n.props.url === p.url).map((n) => ({ key: n.props.key }));
    if (q.startsWith('MATCH (n {key:$k}) RETURN n.key AS key')) return G.has(p.k) ? [{ key: p.k }] : [];
    if (q.includes('toLower(n.title) = toLower($name)')) return [...G.values()].filter((n) => n.labels.some((l) => p.labels.includes(l)) && String(n.props.title).toLowerCase() === p.name.toLowerCase()).map((n) => ({ key: n.props.key }));
    const old = q.match(/^MATCH \(:Artifact \{key:\$key\}\)-\[r:(\w+)\]->\(\{key:\$t\}\) RETURN properties\(r\)/);
    if (old) { const e = (G.get(p.key) || { out: [] }).out.find((x) => x.rel === old[1] && x.to === p.t); return e ? [{ r: { ...e.r } }] : []; }
    if (q.includes('WHERE n.collection IS NOT NULL')) return [...G.values()].filter((n) => n.props.collection).map((n) => ({ ...gRow(n.props.key), inc: [] }));
    if (q.includes("v.by = 'claude'")) return [...G.values()].filter((n) => n.labels.some((l) => p.labels.includes(l)) && n.props.by === 'claude' && (n.props.record_status || 'auto') === 'auto').map((n) => ({ key: n.props.key, name: n.props.name, label: n.labels[0], model: n.props.model || null, uses: 1 }));
    return gRun(q, p);
  };
  const aTx = async (q, p) => {
    const lw = q.match(/^MATCH \(n:Artifact \{key:\$key\}\), \(t \{key:\$t\}\) MERGE \(n\)-\[r:(\w+)\]->\(t\) SET r \+= \$props/);
    if (lw) { calls.push([q, p]); const n = G.get(p.key); const e = n.out.find((x) => x.rel === lw[1] && x.to === p.t); if (e) Object.assign(e.r, p.props); else n.out.push({ rel: lw[1], to: p.t, r: { ...p.props } }); return gRecs([]); }
    if (q.includes('SET p.openalex_id = $id')) { const n = G.get(p.key); if (!q.includes('openalex_id IS NULL') || n.props.openalex_id == null) n.props.openalex_id = p.id; return gRecs([]); }
    if (q.startsWith('MATCH (n:Artifact {key:$key}) RETURN n.provenance_json AS p')) return gRecs([{ p: G.get(p.key).props.provenance_json }]);
    if (q.startsWith('MATCH (n:Artifact {key:$key}) SET n.provenance_json = $prov')) { const n = G.get(p.key); n.props.provenance_json = p.prov; if (q.includes("record_status = 'reviewed'")) n.props.record_status = 'reviewed'; return gRecs([]); }
    const acc = q.match(/^MATCH \(:Artifact \{key:\$key\}\)-\[x:(\w+)\]->\(\{key:\$t\}\) SET x.status = 'reviewed'/);
    if (acc) { const es = G.get(p.key).out.filter((x) => x.rel === acc[1] && x.to === p.t); es.forEach((e) => { e.r.status = 'reviewed'; }); return gRecs([{ c: es.length }]); }
    if (q.startsWith('MATCH (v {key:$key}) WHERE any(l IN labels(v)')) { const v = G.get(p.key); if (!v || !v.labels.some((l) => p.labels.includes(l))) return gRecs([]); v.props.record_status = 'reviewed'; return gRecs([{ key: p.key }]); }
    return gTx(q, p);
  };
  runImpl = aRun; txImpl = aTx;
  const stubResolve = async (kind, name, opts = {}) => {
    const label = vocab.labelOf(kind);
    resolved.push([label, name, opts]);
    const key = schema.entities[label].key_prefix + vocab.analyse(schema.entities[label].match, name).norm.replace(/ /g, '-');
    if (opts.create === false) return { key: G.has(key) ? key : null, created: false, match: G.has(key) ? 'exact' : null };
    if (!G.has(key)) G.set(key, { labels: [label], props: { key, name, by: opts.by, ...(opts.model ? { model: opts.model } : {}) }, out: [] });
    return { key, name, created: true, match: 'new' };
  };
  vocab.resolve = stubResolve;
  G.set('doi:10.1/other', { labels: ['Artifact', 'Paper'], props: { key: 'doi:10.1/other', title: 'The Other Paper', collection: 'paper', schema_version: 1 }, out: [] });

  const A1 = {
    collection: 'paper', doi: 'https://doi.org/10.5555/ABC', model: 'claude-test',
    fields: { title: 'Claude title', authors: ['Someone'], abstract: 'claude abstract', relevance: 5, contribution_type: 'empirical', research_problem: 'rp',
      key_findings: [{ text: 'f1', location: 'p. 3' }, { text: 'f2' }], doi: '10.5555/abc', evidence: { type: 'survey', n: 1200, period: '2020-2022' } },
    confidence: { research_problem: 'low' },
    links: [
      { rel: 'INTRODUCES', target: 'Brand new method', kind: 'Method' },
      { rel: 'about', target: 'Zero-knowledge proofs', kind: 'Topic' },
      { rel: 'CRITIQUES', target: 'doi:10.1/other' },
      { rel: 'CRITIQUES', target: 'The Other Paper', evidence: '"we disagree with X" (s. 4)', confidence: 'low' },
      { rel: 'ADDRESSES', target: 'usecase:offline-payments' },
    ],
  };
  srcNet.length = 0; resolved.length = 0;
  const r1 = await analysis.save(A1);
  const P = G.get('doi:10.5555/abc');
  assert.deepEqual([r1.key, r1.created], ['doi:10.5555/abc', true]);
  assert.ok(r1.url.endsWith('/library?key=doi%3A10.5555%2Fabc'));
  assert.deepEqual([P.props.title, P.props.year, P.props.abstract, P.props.item_type], ['Private Payments at Scale', 2023, 'An abstract.', 'journalArticle'], 'source facts come from Crossref');
  assert.deepEqual([P.props.citation_count, P.props.open_access, P.props.language, P.props.openalex_id], [12, 'green', 'en', 'W123'], 'and OpenAlex');
  assert.equal(P.props.citation_count_at, new Date().toISOString().slice(0, 10));
  assert.deepEqual(P.out.filter((e) => e.rel === 'AUTHORED_BY').map((e) => e.to).sort(), ['person:ada-lovelace', 'person:jose-garcia'], 'authors through the name matcher');
  assert.ok(resolved.some(([l, n, o]) => l === 'Person' && n === 'José García' && o.by === 'source'));
  const venueEdge = P.out.find((e) => e.rel === 'PUBLISHED_IN');
  assert.equal(venueEdge.to, 'venue:journal-of-payments'); assert.equal(P.props.venue, 'Journal of Payments', 'the venue text stays for the CSL export');
  const prov1 = JSON.parse(P.props.provenance_json);
  assert.deepEqual([prov1.title.by, prov1.authors.by, prov1.citation_count.by, prov1.contribution_type.by, prov1.contribution_type.model, prov1.contribution_type.confidence, prov1.research_problem.confidence],
    ['source', 'source', 'source', 'claude', 'claude-test', 'medium', 'low']);
  assert.ok(!('visibility' in prov1));
  const sk1 = Object.fromEntries(r1.skipped.map((x) => [x.field, x.reason]));
  assert.deepEqual([sk1.authors, sk1.abstract, sk1.relevance, sk1.title], ['not a claude field', 'not a claude field', 'not a claude field', 'already filled'], 'Claude never writes source facts or the owner\'s appraisal');
  assert.ok(!('doi' in sk1), 'the identity is not a field write');
  assert.deepEqual(r1.filled.sort(), ['contribution_type', 'evidence', 'key_findings', 'research_problem']);
  // a single object keeps its parts as queryable properties, hidden from the item's fields
  assert.deepEqual([P.props.evidence__n, P.props.evidence__type, P.props.evidence__source, P.props.evidence__period], [1200, 'survey', null, '2020-2022'].map((x, i) => (i === 2 ? undefined : x)));
  const pe = await items.get('doi:10.5555/abc');
  assert.deepEqual(pe.fields.evidence, { type: 'survey', n: 1200, period: '2020-2022' }); assert.ok(!Object.keys(pe.extra).some((k) => k.startsWith('evidence__')));
  assert.ok((await items.update('doi:10.5555/abc', { evidence__n: 5 })).warnings.includes('ignored (reserved or not a valid field name): evidence__n'), 'parts are not written directly');
  assert.ok(!('evidence__n' in items.partValues('key_findings', S.fieldsOf('paper').key_findings, {})) && items.partNames('key_findings', S.fieldsOf('paper').key_findings).length === 0, 'lists of objects have no parts');
  assert.deepEqual(r1.flagged.map((f) => f.reason), ['ungrounded: no location', 'ungrounded: interpretive link without a location']);
  assert.deepEqual([r1.flagged[0].index, r1.flagged[0].text], [1, 'f2']);
  assert.deepEqual(r1.links, [{ rel: 'ABOUT', target: 'topic:zero-knowledge-proof' }, { rel: 'CRITIQUES', target: 'doi:10.1/other' }]);
  const lsk = r1.links_skipped.map((x) => x.reason);
  assert.ok(/no Method titled "Brand new method"/.test(lsk[0]), 'items are never created from a name');
  assert.ok(/CRITIQUES is interpretive: it needs the justifying passage/.test(lsk[1]));
  assert.ok(/ADDRESSES does not start at a Paper/.test(lsk[2]));
  assert.equal(G.get('topic:zero-knowledge-proof').props.by, 'claude'); assert.equal(G.get('topic:zero-knowledge-proof').props.model, 'claude-test');
  const crit = P.out.find((e) => e.rel === 'CRITIQUES');
  assert.deepEqual([crit.r.by, crit.r.model, crit.r.confidence, crit.r.status, crit.r.source, crit.r.evidence], ['claude', 'claude-test', 'low', 'auto', 'analysis', '"we disagree with X" (s. 4)']);
  assert.ok(r1.empty_core_standard.includes('tldr') && r1.empty_core_standard.includes('arxiv_id') && !r1.empty_core_standard.includes('contribution_type') && !r1.empty_core_standard.includes('rigor'), 'standard tier: Core and Standard only');
  assert.ok(!r1.empty_core_standard.includes('schema_version') && !r1.empty_core_standard.includes('record_status'));

  // the same request again: nothing changes
  const edges1 = P.out.length;
  const r2 = await analysis.save(A1);
  assert.equal(r2.created, false); assert.deepEqual(r2.filled, []); assert.deepEqual(r2.links, []);
  assert.ok(r2.links_skipped.filter((x) => x.reason === 'already linked').length === 2); assert.equal(P.out.length, edges1, 'no duplicate links');
  assert.deepEqual(r2.flagged, [], 'nothing new to flag');
  assert.ok((await analysis.save({ ...A1, tier: 'deep' })).empty_core_standard.includes('rigor'), 'deep tier lists Deep fields too');

  // owner edits win; force only replaces Claude's own values; reviewed Claude values are protected
  await items.update('doi:10.5555/abc', { contribution_type: 'theoretical' });
  const r3 = await analysis.save({ collection: 'paper', key: 'doi:10.5555/abc', model: 'claude-test', force: true, fields: { contribution_type: 'empirical', research_problem: 'rp v2' } });
  assert.deepEqual(r3.skipped, [{ field: 'contribution_type', reason: 'owner value' }]); assert.deepEqual(r3.filled, ['research_problem']);
  assert.equal(P.props.contribution_type, 'theoretical');
  await items.link('method:snowball-sampling', { rel: 'ADDRESSES', target: 'usecase:offline-payments' });
  const r4 = await analysis.save({ collection: 'method', key: 'method:snowball-sampling', model: 'm', force: true, links: [{ rel: 'ADDRESSES', target: 'usecase:offline-payments', confidence: 'high' }] });
  assert.equal(r4.links_skipped[0].reason, 'owner link'); assert.equal(G.get('method:snowball-sampling').out.find((e) => e.rel === 'ADDRESSES').r.by, 'owner');

  // sources down: the save goes on with warnings; a new DOI with no lookup and no title is a 422
  openalexDown = true;
  const r5 = await analysis.save({ collection: 'paper', key: 'doi:10.5555/abc', model: 'm', fields: {} });
  assert.ok(r5.warnings.includes('OpenAlex: HTTP 500')); openalexDown = false;
  crossrefDown = true;
  srcNet.length = 0;
  await assert.rejects(() => analysis.save({ collection: 'paper', doi: '10.9/none', model: 'm', fields: {} }), (e) => e.status === 422);
  assert.equal(srcNet.filter((u) => u.includes('crossref')).length, 1, 'Crossref is asked once');
  const r6 = await analysis.save({ collection: 'paper', doi: '10.9/none', model: 'm', fields: { title: 'Known only by title', tldr: 't' } });
  assert.ok(r6.created && r6.warnings.includes('Crossref did not return this DOI; created from the title given') && r6.warnings.includes('OpenAlex does not know this DOI'));
  assert.equal(JSON.parse(G.get('doi:10.9/none').props.provenance_json).title.by, 'source'); crossrefDown = false;
  const rh = await analysis.save({ collection: 'paper', doi: '10.9/hybrid', model: 'm', fields: { title: 'Hybrid OA' } });
  assert.equal(G.get(rh.key).props.open_access, undefined, 'an OpenAlex status with no equivalent is left empty'); assert.equal(G.get(rh.key).props.citation_count, 1);
  G.get('doi:10.5555/abc').props.openalex_id = 'Wkept';
  await analysis.save({ collection: 'paper', key: 'doi:10.5555/abc', model: 'm', fields: {} });
  assert.equal(G.get('doi:10.5555/abc').props.openalex_id, 'Wkept', 'an existing OpenAlex id is kept');
  G.set('doi:10.1/twin1', { labels: ['Artifact', 'Paper'], props: { key: 'doi:10.1/twin1', title: 'Twin', collection: 'paper' }, out: [] });
  G.set('doi:10.1/twin2', { labels: ['Artifact', 'Paper'], props: { key: 'doi:10.1/twin2', title: 'twin', collection: 'paper' }, out: [] });
  const rt = await analysis.save({ collection: 'paper', key: 'doi:10.5555/abc', model: 'm', links: [{ rel: 'BUILDS_ON', target: 'Twin', evidence: 'extends it' }, { rel: 'BUILDS_ON', target: 'The Other Paper', evidence: 'extends it', confidence: 'medium' }] });
  assert.ok(/matches more than one item; pass its key/.test(rt.links_skipped[0].reason), 'an ambiguous title is not guessed');
  // papers by URL
  await assert.rejects(() => analysis.save({ collection: 'paper', url: 'https://ex.org/p.pdf', model: 'm', fields: {} }), (e) => e.status === 400 && /needs a title/.test(e.message));
  const r7 = await analysis.save({ collection: 'paper', url: 'https://ex.org/p.pdf', model: 'm', fields: { title: 'A web paper' } });
  assert.equal((await analysis.save({ collection: 'paper', url: 'https://ex.org/p.pdf', model: 'm', fields: {} })).key, r7.key, 'found again by URL');

  // other collections: created by Claude from the title, re-analysis fills the gaps
  const r8 = await analysis.save({ collection: 'use_case', model: 'claude-test', fields: { title: 'Cross-border payments', goal: 'cheap transfers', status: 'idea', domain: ['payments'] },
    links: [{ rel: 'SUPPORTS', target: 'case:lisbon' }] });
  assert.deepEqual([r8.key, r8.created], ['usecase:cross-border-payments', true]);
  assert.deepEqual(r8.filled, ['title', 'goal', 'domain'], 'a new item is written once, by its creating write');
  const prov8 = JSON.parse(G.get('usecase:cross-border-payments').props.provenance_json);
  assert.deepEqual([prov8.title.by, prov8.goal.by], ['claude', 'claude'], 'on create Claude owns the fields it wrote');
  assert.equal(r8.skipped.find((x) => x.field === 'status').reason, 'not a claude field', 'status is the owner\'s');
  assert.equal(G.get('usecase:cross-border-payments').props.record_status, 'auto');
  assert.ok(/SUPPORTS does not start at a UseCase/.test(r8.links_skipped[0].reason));
  const r9 = await analysis.save({ collection: 'use_case', model: 'claude-test', fields: { title: 'Cross-border payments', goal: 'other', problem_context: 'fees' } });
  assert.deepEqual([r9.created, r9.filled, r9.skipped], [false, ['problem_context'], [{ field: 'title', reason: 'already filled' }, { field: 'goal', reason: 'already filled' }]]);
  const r10 = await analysis.save({ collection: 'case_study', key: 'case:lisbon', model: 'm', links: [{ rel: 'SUPPORTS', target: 'usecase:cross-border-payments', evidence: 'pilot results', location: 'p. 9' }, { rel: 'ABOUT', target: 'payments' }] });
  assert.deepEqual(r10.links, [{ rel: 'SUPPORTS', target: 'usecase:cross-border-payments' }]); assert.deepEqual(r10.flagged, []);
  assert.ok(/pass kind: one of Topic, Concept, Domain/.test(r10.links_skipped[0].reason), 'an ambiguous vocabulary target is not guessed');
  for (const [bad, re] of [[{ collection: 'paper', model: 'm' }, /needs key, doi or url/], [{ collection: 'use_case', model: 'm', fields: {} }, /needs a title/], [{ collection: 'note', model: 'm' }, /collection must be/],
    [{ collection: 'paper', doi: '10.5555/abc' }, /model is required/], [{ collection: 'paper', doi: '10.5555/abc', model: 'm', tier: 'max' }, /tier/], [{ collection: 'use_case', key: 'case:lisbon', model: 'm' }, /is a case_study, not a use_case/],
    [{ collection: 'paper', doi: '10.5555/abc', model: 'm', confidence: 'sure' }, /confidence/], [{ collection: 'paper', doi: '10.5555/abc', model: 'm', links: {} }, /links must be a list/]]) {
    await assert.rejects(() => analysis.save(bad), (e) => e.status === 400 && re.test(e.message), JSON.stringify(bad));
  }

  /* ------------------------------------------------------------ audit */
  G.get('case:lisbon').props.schema_version = 0;
  const au = await audit.report();
  assert.ok(au.low_confidence.some((x) => x.key === 'doi:10.5555/abc' && x.field === 'research_problem' && x.model === 'claude-test') === false, 'research_problem was re-written by force without low confidence');
  assert.ok(au.ungrounded.some((x) => x.key === 'doi:10.5555/abc' && x.index === 1 && x.text === 'f2'));
  assert.ok(au.low_confidence_links.some((x) => x.rel === 'CRITIQUES' && x.target === 'doi:10.1/other'));
  assert.ok(!au.low_confidence_links.some((x) => x.rel === 'SUPPORTS'), 'a located, medium-confidence link is fine');
  assert.ok(au.low_confidence_links.some((x) => x.rel === 'BUILDS_ON' && x.confidence === 'medium' && x.location === null), 'an interpretive link without a location is listed');
  const au1 = await audit.report({ limit: 1 });
  assert.ok(au1.counts.empty_fields > 1 && au1.empty_fields.length === 1 && au1.truncated === true, 'lists are capped, counts are not');
  assert.ok(au.vocab_by_claude.some((x) => x.key === 'topic:zero-knowledge-proof'));
  assert.ok(au.outdated.some((x) => x.key === 'case:lisbon' && x.current === 1));
  assert.ok(au.empty_fields.find((x) => x.key === 'doi:10.5555/abc').fields.some((f) => f.field === 'tldr' && f.tier === 'core'));
  assert.ok(au.unreviewed_items.some((x) => x.key === 'usecase:cross-border-payments'));
  for (const [k, v] of Object.entries(au.counts)) assert.equal(v, au[k].length, k);
  await analysis.save({ collection: 'paper', key: 'doi:10.5555/abc', model: 'claude-test', confidence: 'low', fields: { paradigm: 'quantitative' } });
  assert.ok((await audit.report()).low_confidence.some((x) => x.field === 'paradigm'));
  assert.equal((await audit.report({ limit: 1 })).low_confidence.length, 1);
  // accept: reviewed values are protected like the owner's
  const ac = await audit.accept({ key: 'doi:10.5555/abc', fields: ['paradigm', 'nope'], links: [{ rel: 'CRITIQUES', target: 'doi:10.1/other' }] });
  assert.deepEqual([ac.accepted, ac.not_found, ac.links, ac.record_status], [['paradigm'], ['nope'], 1, 'auto']);
  assert.equal((await analysis.save({ collection: 'paper', key: 'doi:10.5555/abc', model: 'm', force: true, fields: { paradigm: 'mixed' } })).skipped[0].reason, 'owner value');
  assert.ok(!(await audit.report()).low_confidence.some((x) => x.field === 'paradigm'), 'an accepted low-confidence field leaves the audit');
  assert.ok(!(await audit.report()).low_confidence_links.some((x) => x.rel === 'CRITIQUES'), 'an accepted link leaves the audit');
  const acAll = await audit.accept({ key: 'usecase:cross-border-payments' });
  assert.equal(acAll.record_status, 'reviewed'); assert.equal(G.get('usecase:cross-border-payments').props.record_status, 'reviewed');
  assert.ok(!(await audit.report()).unreviewed_items.some((x) => x.key === 'usecase:cross-border-payments'));
  assert.deepEqual(await audit.accept({ vocab: 'topic:zero-knowledge-proof' }), { vocab: 'topic:zero-knowledge-proof', record_status: 'reviewed' });
  assert.ok(!(await audit.report()).vocab_by_claude.some((x) => x.key === 'topic:zero-knowledge-proof'));
  // only Claude values need review: a paper whose remaining auto values come from Crossref is not listed, and accepting
  // its one Claude field makes it reviewed
  G.get('doi:10.9/hybrid').props.record_status = 'auto';
  assert.ok(!(await audit.report()).unreviewed_items.some((x) => x.key === 'doi:10.9/hybrid'), 'source values do not need review');
  assert.equal((await audit.accept({ key: 'doi:10.9/none', fields: ['tldr'] })).record_status, 'reviewed', 'source auto values do not hold an item back');
  await assert.rejects(() => audit.accept({}), (e) => e.status === 400);
  await assert.rejects(() => audit.accept({ vocab: 'method:snowball-sampling' }), (e) => e.status === 404);
  await assert.rejects(() => audit.accept({ key: 'doi:10.5555/abc', fields: 'all' }), (e) => e.status === 400);

  /* ------------------------------------------------------------ analysis and audit over HTTP, and through MCP */
  const appA = require('express')();
  appA.use(require('express').json());
  require('../features/analysis').mount(appA); require('../features/mcp').mount(appA);
  appA.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const srvA = await new Promise((ok) => { const x = appA.listen(0, '127.0.0.1', () => ok(x)); });
  const aBase = `http://127.0.0.1:${srvA.address().port}`;
  try {
    for (const [m, u] of [['POST', '/api/analysis'], ['GET', '/api/audit'], ['POST', '/api/audit/accept'], ['POST', '/mcp']]) {
      assert.equal((await fetch(aBase + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'GET' ? undefined : '{}' })).status, 401, `${m} ${u} is owner only`);
    }
    const h1 = await fetch(aBase + '/api/analysis', { method: 'POST', headers: H, body: JSON.stringify({ collection: 'method', model: 'm', fields: { title: 'Via HTTP method', purpose: 'p' } }) });
    assert.equal(h1.status, 201);
    const h2 = await fetch(aBase + '/api/analysis', { method: 'POST', headers: H, body: JSON.stringify({ collection: 'method', model: 'm', fields: { title: 'Via HTTP method', purpose: 'p' } }) });
    assert.equal(h2.status, 200, 're-analysis is 200');
    assert.ok((await (await fetch(aBase + '/api/audit', { headers: H })).json()).counts);
    assert.equal((await (await fetch(aBase + '/api/audit/accept', { method: 'POST', headers: H, body: JSON.stringify({ key: 'method:via-http-method' }) })).json()).record_status, 'reviewed');

    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(aBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer abc' } } }));
    const toolNames = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ['get_schema', 'save_analysis', 'search_items', 'get_item', 'describe_graph']) assert.ok(toolNames.includes(t), t);
    for (const t of ['propose_changes', 'apply_plan', 'revert_plan', 'list_plans']) assert.ok(toolNames.includes(t), t);
    assert.match(client.getInstructions(), /call apply_plan only after the owner says yes/);
    const badOp = await client.callTool({ name: 'propose_changes', arguments: { ops: [{ op: 'explode', key: 'x' }], reason: 'r' } });
    assert.ok(badOp.isError, 'an unknown op is refused before anything runs');
    assert.equal(client.getServerVersion().version, require('../package.json').version);
    assert.match(client.getInstructions(), /call get_schema for its collection, then save_analysis once/);
    const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, `${name}: ${r.content[0].text}`); return JSON.parse(r.content[0].text); };
    const gs = await call('get_schema', { collection: 'paper' });
    assert.ok(gs.fields.contribution_type.enum.includes('empirical') && gs.fields.key_findings.props.location === 'text');
    assert.ok(!gs.fields.authors && !gs.fields.relevance && gs.filled_by_the_hub.includes('authors') && gs.filled_by_the_hub.includes('abstract'), 'only fields Claude may fill; source fields listed apart');
    assert.ok(gs.rules.some((x) => /empty beats wrong/.test(x)) && gs.rules.some((x) => /location/.test(x)));
    assert.ok(gs.relations.some((r) => r.rel === 'CRITIQUES' && r.interpretive) && gs.relations.some((r) => r.rel === 'INTRODUCES' && !r.interpretive));
    const sv = await call('save_analysis', { collection: 'case_study', model: 'claude-mcp', fields: { title: 'MCP case', case_type: 'pilot' }, confidence: { case_type: 'high' } });
    assert.deepEqual([sv.key, sv.created], ['case:mcp-case', true]);
    const gi = await call('get_item', { key: 'case:mcp-case' });
    assert.deepEqual([gi.fields.case_type, gi.provenance.case_type.by, gi.provenance.case_type.model, gi.provenance.case_type.confidence], ['pilot', 'claude', 'claude-mcp', 'high']);
    let mcpListParams = null;
    runImpl = async (q, p) => (q.includes('ORDER BY s') ? (mcpListParams = p, [{ key: 'case:mcp-case', s: 'x', labels: ['Artifact', 'CaseStudy'], props: { key: 'case:mcp-case', title: 'MCP case', case_type: 'pilot' } }]) : q.includes('count(n)') ? [{ total: 1 }] : aRun(q, p));
    const si = await call('search_items', { collection: 'case_study', filters: { case_type: 'pilot' }, limit: 5 });
    assert.deepEqual(si.items.map((x) => x.key), ['case:mcp-case']);
    assert.deepEqual([mcpListParams.f_case_type, mcpListParams.limit.toNumber()], [['pilot'], 6], 'filters and limit reach the query');
    const bad = await client.callTool({ name: 'save_analysis', arguments: { collection: 'paper', model: 'm', fields: {} } });
    assert.ok(bad.isError && /needs key, doi or url/.test(bad.content[0].text), 'errors come back as tool errors');
    runImpl = aRun;
    await client.close();
  } finally { srvA.close(); }
  vocab.resolve = realResolve; runImpl = async () => []; txImpl = null;
  crossref.setHttp((url, opts) => fetch(url, opts)); openalex.setHttp((url, opts) => fetch(url, opts));

  /* ------------------------------------------------------------ record_status from provenance, migration 010 */
  assert.equal(items.needsReview({ a: { by: 'claude', status: 'auto' } }), true);
  assert.equal(items.needsReview({ a: { by: 'claude', status: 'reviewed' }, b: { by: 'source', status: 'auto' }, c: { by: 'owner', status: 'reviewed' } }), false, 'only unaccepted Claude values need review');
  assert.equal(items.needsReview(undefined), false);
  const m010 = require('../migrations/010_record_status_from_provenance');
  const m10 = [];
  await m010.up({ run: async (q, p) => { m10.push([q, p]); return q.startsWith('MATCH (n:Method) RETURN') ? [
    { key: 'method:legacy', p: null, rs: 'auto' }, { key: 'method:claude', p: '{"x":{"by":"claude","status":"auto"}}', rs: 'auto' },
    { key: 'method:accepted', p: '{"x":{"by":"claude","status":"reviewed"}}', rs: 'auto' }, { key: 'method:broken', p: '{nope', rs: null }] : []; } });
  assert.deepEqual(m10.find(([q]) => q.startsWith('UNWIND') && q.includes('Method'))[1].rows,
    [{ key: 'method:legacy', rs: 'reviewed' }, { key: 'method:accepted', rs: 'reviewed' }, { key: 'method:broken', rs: 'reviewed' }], 'only changed items are written; legacy owner data is reviewed');

  /* ------------------------------------------------------------ migration 009: object parts */
  const m009 = require('../migrations/009_object_parts');
  const m9 = [];
  await m009.up({ run: async (q, p) => { m9.push([q, p]); return q.includes('n.`period_json` IS NOT NULL') ? [{ key: 'case:x', json: '{"from":"2023-01","to":"2024"}' }] : q.includes('n.`evidence_json` IS NOT NULL') ? [{ key: 'p:1', json: 'not json' }] : []; } });
  const m9p = m9.find(([q]) => q.startsWith('UNWIND') && q.includes('CaseStudy'))[1].rows[0];
  assert.deepEqual(m9p, { key: 'case:x', props: { period__from: '2023-01', period__to: '2024' } });
  assert.deepEqual(m9.find(([q]) => q.startsWith('UNWIND') && q.includes('Paper'))[1].rows[0].props, { evidence__type: null, evidence__source: null, evidence__n: null, evidence__period: null }, 'broken JSON clears the parts');
  assert.ok(!m9.some(([q]) => q.includes('`key_findings_json`') || q.includes('`provenance_json`')), 'lists of objects and hub fields are skipped');

  /* ------------------------------------------------------------ items: schema checks, migration 007 */
  assert.match(broken((c) => { c.types.method.fields.topics2 = { ...c.common_fields.topics }; }), /types\.method: topics and topics2 both link ABOUT->Topic/);
  assert.match(broken((c) => { c.types.use_case.fields.venue = { type: 'ref', ref: 'Venue', rel: 'PUBLISHED_IN', by: ['Y'], tier: 'deep' }; }), /use_case\.venue: relation_types\.PUBLISHED_IN does not allow UseCase -> Venue/);
  const m007 = require('../migrations/007_items_json_fields');
  assert.equal(m007.toJson(['{"role":"payer"}', 'plain text'], true), '[{"role":"payer"},"plain text"]');
  assert.equal(m007.toJson('{"from":"2023"}', false), '{"from":"2023"}'); assert.equal(m007.toJson('{"a":1}', true), '[{"a":1}]', 'a single object in a list field becomes a list');
  const m7 = [];
  await m007.up({ run: async (q, p) => { m7.push([q, p]); return q.includes('n.`actors` IS NOT NULL') ? [{ key: 'usecase:x', value: ['{"role":"payer"}'] }] : []; } });
  const m7w = m7.find(([q]) => q.startsWith('UNWIND') && q.includes('actors'));
  assert.ok(m7w[0].includes('SET n.`actors_json` = r.json REMOVE n.`actors`'), 'copy, then remove, in one statement'); assert.deepEqual(m7w[1].rows, [{ key: 'usecase:x', json: '[{"role":"payer"}]' }]);
  assert.ok(m7.some(([q]) => q.includes('MATCH (n:CaseStudy) WHERE n.`outcomes` IS NOT NULL AND n.`outcomes_json` IS NULL')), 'only nodes not migrated yet');
  assert.ok(!m7.some(([q]) => q.includes('`provenance`')), 'hub-set objects are not fields to migrate');

  {
  /* ------------------------------------------------------------ Library UI logic (apps/library/model.js, no DOM) */
  // model.js is a browser ES module with no imports; load its source as one (the package itself is CommonJS)
  const M = await import('data:text/javascript,' + encodeURIComponent(fs.readFileSync(path.join(__dirname, '..', 'apps', 'library', 'model.js'), 'utf8')));
  const pubView = publicView();
  const colls = pubView.collections;
  assert.deepEqual(colls.map((c) => [c.name, c.slug, c.plural]), [['paper', 'papers', 'Papers'], ['method', 'methods', 'Methods'], ['use_case', 'use-cases', 'Use cases'], ['case_study', 'case-studies', 'Case studies'],
    ['framework', 'frameworks', 'Frameworks'], ['research_question', 'research-questions', 'Research questions'], ['hypothesis', 'hypotheses', 'Hypotheses'], ['ontology', 'ontologies-and-standards', 'Ontologies and standards']]);
  const pc = colls.find((c) => c.name === 'paper');
  assert.ok(pc.fields.contribution_type.enum.includes('empirical') && pc.fields.authors.ref === 'Person' && !pc.fields.provenance && !pc.fields.key, 'hub-set fields are not offered to the UI');
  assert.ok(pc.relations.some((r) => r.rel === 'CRITIQUES' && r.interpretive) && !pc.relations.some((r) => r.rel === 'ADDRESSES'));
  assert.ok(pubView.entities.some((e) => e.label === 'Domain' && e.key_prefix === 'domain:'));
  assert.deepEqual([pc.list_columns, pc.filters.slice(0, 2), pc.detail_groups.length], [schema.types.paper.list_columns, ['item_type', 'contribution_type'], 4], 'layout hints reach the UI');
  assert.equal(pubView.labels.find((l) => l.label === 'CaseStudy').plural, 'Case studies');
  const Q = (s) => new URLSearchParams(s);
  assert.deepEqual(M.parseRoute(['use-cases'], Q('key=usecase:x&edit=1'), colls), { section: 'use_case', key: 'usecase:x', edit: true });
  assert.deepEqual(M.parseRoute([], Q(''), colls), { section: 'paper', key: null, edit: false }, 'the Library opens on Papers');
  assert.deepEqual(M.parseRoute([], Q('key=doi:1'), colls), { section: 'all', key: 'doi:1', edit: false }, 'older links resolve through All');
  assert.deepEqual(M.parseRoute([], Q('view=graph&key=method:x'), colls).section, 'graph');
  assert.deepEqual(M.parseRoute(['audit'], Q(''), colls), { section: 'review', key: null, edit: false, tab: 'check' }, 'the old Audit address opens Review');
  assert.deepEqual(M.parseRoute(['curation'], Q(''), colls).tab, 'fixes', 'the old Curation address opens its tab');
  assert.deepEqual([M.parseRoute(['review'], Q('tab=fixes'), colls).tab, M.parseRoute(['review'], Q('tab=nonsense'), colls).tab], ['fixes', 'check']);
  assert.equal(M.routePath({ section: 'review', tab: 'fixes' }, colls), '/library/review?tab=fixes');
  assert.deepEqual(M.parseRoute(['nonsense'], Q(''), colls).section, 'all');
  assert.equal(M.routePath({ section: 'case_study', key: 'case:a/b', edit: true }, colls), '/library/case-studies?key=case%3Aa%2Fb&edit=1');
  assert.equal(M.routePath({ section: 'graph' }, colls), '/library/graph');
  for (const r of [{ section: 'method', key: 'method:x', edit: false }, { section: 'review', key: null, edit: false, tab: 'check' }, { section: 'review', key: null, edit: false, tab: 'fixes' }]) {
    const [p0, qs] = M.routePath(r, colls).split('?');
    assert.deepEqual(M.parseRoute(p0.split('/').slice(2), Q(qs || ''), colls), r, 'routes round-trip');
  }
  assert.equal(M.collectionOf(['Artifact', 'UseCase'], colls).name, 'use_case'); assert.equal(M.collectionOf(['Artifact', 'Note'], colls), null);
  assert.deepEqual(M.provenanceLabel({ by: 'claude', model: 'm1', confidence: 'low', status: 'auto', at: '2026-01-02T03:04:05Z' }), { text: 'Claude', kind: 'claude', low: true, reviewed: false, title: 'm1 · low confidence · 2026-01-02' });
  assert.equal(M.provenanceLabel({ by: 'claude', confidence: 'low', status: 'reviewed' }).low, false, 'a reviewed value is not flagged');
  assert.deepEqual([M.provenanceLabel({ by: 'owner' }).text, M.provenanceLabel({ by: 'source' }).kind, M.provenanceLabel(null)], ['you', 'source', null]);
  assert.deepEqual(M.ungrounded([{ text: 'a', location: 'p. 1' }, { text: 'b' }, { text: 'c', location: '  ' }, null]), [1, 2, 3]);
  const groups = M.fieldGroups(pc);
  assert.deepEqual(groups.map((g) => g.label), ['General', 'Bibliographic', 'Classification', 'Content', 'Appraisal']);
  assert.ok(groups[0].fields.includes('title') && !groups.flatMap((g) => g.fields).includes('record_status'));
  assert.equal(new Set(groups.flatMap((g) => g.fields)).size, groups.flatMap((g) => g.fields).length, 'every field once');
  const F = pc.fields;
  assert.deepEqual([M.fromForm(F.year, ' 2024 '), M.fromForm(F.year, ''), M.fromForm(F.year, 'abc'), M.fromForm(F.title, '  T  ')], [2024, null, 'abc', 'T']);
  assert.deepEqual(M.fromForm(F.limitations_stated, ['a', ' ', '', 'b ']), ['a', 'b']); assert.equal(M.fromForm(F.limitations_stated, ['']), null);
  assert.deepEqual(M.fromForm(F.evidence, { type: 'survey', n: '120', source: '', period: '' }), { type: 'survey', n: 120 });
  assert.equal(M.fromForm(F.evidence, { type: ' ', n: '' }), null, 'an empty object is no value');
  assert.deepEqual(M.fromForm(F.key_findings, [{ text: 'f', location: '' }, { text: '', location: '' }]), [{ text: 'f' }]);
  assert.deepEqual(M.fromForm(colls.find((c) => c.name === 'case_study').fields.outcomes, [{ measure: 'm', expected: true }]), [{ measure: 'm', expected: true }]);
  assert.deepEqual(M.fromForm(F.topics, [{ key: 'topic:a', name: 'A' }, { key: null, name: ' New ' }]), ['topic:a', 'New'], 'known vocabulary by key, new by name');
  assert.equal(M.fromForm(F.venue, [{ key: 'venue:v', name: 'V' }]), 'venue:v'); assert.equal(M.fromForm(F.venue, []), null);
  assert.deepEqual(M.toForm(F.topics, [{ key: 'topic:a', name: 'A' }]), [{ key: 'topic:a', name: 'A' }]); assert.deepEqual(M.toForm(F.venue, { key: null, name: 'Text venue' }), [{ key: null, name: 'Text venue' }]);
  assert.deepEqual([M.toForm(F.evidence, null), M.toForm(F.limitations_stated, null), M.toForm(F.title, null)], [{}, [], '']);
  const before = { title: 'T', topics: [{ key: 'topic:a', name: 'A' }], venue: { key: null, name: 'Old text' }, evidence: { n: 5, type: 'x' }, year: 2020 };
  const unchanged = { title: 'T', topics: ['topic:a'], venue: 'Old text', evidence: { type: 'x', n: 5 }, year: 2020 };
  assert.deepEqual(M.changedFields(F, before, unchanged), {}, 'refs by key, older text by name, objects regardless of key order');
  assert.deepEqual(M.changedFields(F, before, { ...unchanged, title: 'T2', topics: ['topic:a', 'New'], year: null }), { title: 'T2', topics: ['topic:a', 'New'], year: null });
  assert.deepEqual(M.changedFields(F, { tldr: null }, { tldr: null, nope: 1 }), {}, 'unknown names are never sent');
  assert.deepEqual([M.safeHref('https://x.org/a'), M.safeHref('javascript:alert(1)'), M.safeHref('data:text/html,x'), M.safeHref(null)], ['https://x.org/a', null, null, null]);
  assert.ok(M.isEmpty({ a: '', b: null }) && M.isEmpty([]) && !M.isEmpty({ a: 0 }) && !M.isEmpty(0));
  assert.deepEqual(['CaseStudy', 'UseCase', 'Paper'].map(M.noun), ['case study', 'use case', 'paper']);

  /* ------------------------------------------------------------ /api/schema collections, /api/vocab */
  const appS = require('express')();
  require('../features/graph').mount(appS); require('../features/vocab').mount(appS);
  appS.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const srvS = await new Promise((ok) => { const x = appS.listen(0, '127.0.0.1', () => ok(x)); });
  const sBase = `http://127.0.0.1:${srvS.address().port}`;
  try {
    const sch = await (await fetch(sBase + '/api/schema')).json();
    assert.deepEqual(sch.collections.find((c) => c.name === 'paper').locked, ['doi', 'authors', 'venue'], 'the UI learns which fields it may not edit');
    assert.deepEqual(sch.collections.find((c) => c.name === 'method').locked, []);
    assert.equal((await fetch(sBase + '/api/vocab?kind=Topic&q=x')).status, 401, 'vocabulary look-up is owner only');
    let vq;
    runImpl = async (q, p) => { vq = [q, p]; return [{ key: 'topic:zero-knowledge-proof', name: 'Zero-knowledge proof', aliases: ['ZKP'], uses: 3 }]; };
    const vr = await (await fetch(sBase + '/api/vocab?kind=topic&q=Zero-Knowledge%20Proofs&limit=500', { headers: { Authorization: 'Bearer abc' } })).json();
    assert.deepEqual([vr.kind, vr.items[0].key], ['Topic', 'topic:zero-knowledge-proof']);
    assert.equal(vq[1].q, 'zero knowledge proof', 'searched in the normalised form'); assert.ok(vq[0].includes('MATCH (n:Topic)') && /LIMIT 50$/.test(vq[0].trim()), 'limit capped');
    assert.equal((await fetch(sBase + '/api/vocab?kind=Paper&q=x', { headers: { Authorization: 'Bearer abc' } })).status, 400);
    assert.equal((await fetch(sBase + '/api/vocab?kind=Topic&q=' + 'x'.repeat(201), { headers: { Authorization: 'Bearer abc' } })).status, 400, 'look-up text is capped');
    runImpl = async (q) => { vq = [q]; return []; };
    await fetch(sBase + '/api/graph', { headers: { Authorization: 'Bearer abc' } });
    assert.ok(vq[0].includes('Topic') && vq[0].includes('Domain') && vq[0].includes('Organisation'), 'the graph includes every vocabulary label');
    runImpl = async () => [];
  } finally { srvS.close(); }
  }

  /* ------------------------------------------------------------ CLI (bin/hub as a child process, fake hub server) */
  {
    const http = require('http'); const os = require('os'); const { execFile } = require('child_process');
    const seen = []; let routes = {};
    const fake = http.createServer((req, res) => {
      let body = []; req.on('data', (d) => body.push(d)); req.on('end', () => {
        const raw = Buffer.concat(body);
        const rec = { method: req.method, url: req.url, type: req.headers['content-type'] || null, auth: req.headers.authorization, raw };
        try { rec.body = raw.length && /json/.test(rec.type) ? JSON.parse(raw) : null; } catch { rec.body = null; }
        seen.push(rec);
        const hit = Object.entries(routes).find(([k]) => `${req.method} ${req.url.split('?')[0]}` === k || `${req.method} ${req.url}` === k);
        const [status, out, hdrs = {}] = hit ? (typeof hit[1] === 'function' ? hit[1](rec) : hit[1]) : [404, { error: 'no route ' + req.url }];
        res.writeHead(status, { 'Content-Type': 'application/json', ...hdrs }); res.end(JSON.stringify(out));
      });
    });
    await new Promise((ok) => fake.listen(0, '127.0.0.1', ok));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-'));
    const env = { ...process.env, HUB_URL: `http://127.0.0.1:${fake.address().port}`, HUB_API_TOKEN: 'cli-token', HOME: home, HUB_MODEL: '' };
    const hub = (args, { input = '', extraEnv = {} } = {}) => new Promise((resolve) => {
      const child = execFile(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'hub'), ...args], { env: { ...env, ...extraEnv } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
      child.stdin.end(input);
    });
    const reset = (r) => { seen.length = 0; routes = r; };
    try {
      reset({ 'GET /api/items': [200, { items: [{ key: 'method:a', title: 'A', kind: 'technique', domain: [{ key: 'domain:x', name: 'X dom' }] }], total: 1, next_cursor: null }] });
      let r = await hub(['item', 'list', 'method', '--kind', 'technique', '--sort', '-title', '--limit', '2']);
      assert.equal(r.code, 0, r.stderr);
      const u = new URL('http://x' + seen[0].url);
      assert.deepEqual([seen[0].method, u.pathname, u.searchParams.get('collection'), u.searchParams.get('kind'), u.searchParams.get('sort'), u.searchParams.get('limit')], ['GET', '/api/items', 'method', 'technique', '-title', '2']);
      assert.equal(seen[0].auth, 'Bearer cli-token');
      assert.ok(r.stdout.includes('method:a') && r.stdout.includes('X dom') && !r.stdout.includes('domain:x'), 'links read as names');
      let page = 0;
      reset({ 'GET /api/items': () => (page++ === 0 ? [200, { items: [{ key: 'k1' }], total: 2, next_cursor: 'c1' }] : [200, { items: [{ key: 'k2' }], total: 2, next_cursor: null }]) });
      r = await hub(['item', 'list', 'paper', '--all', '--json']);
      assert.deepEqual(JSON.parse(r.stdout).items.map((x) => x.key), ['k1', 'k2']); assert.equal(new URL('http://x' + seen[1].url).searchParams.get('cursor'), 'c1', '--all follows the cursor');
      page = 0; r = await hub(['item', 'list', 'paper']);
      assert.equal(seen.length, 3, 'without --all only the first page'); assert.match(r.stderr, /--all for every page/);

      reset({ 'GET /api/items/doi%3A10.1%2Fx': [200, { key: 'doi:10.1/x', collection: 'paper', record_status: 'auto', fields: { title: 'T', year: 2020, tldr: null, authors: [{ key: 'person:a', name: 'Ada' }], evidence: { n: 5 } },
        provenance: { title: { by: 'source' }, year: { by: 'owner', status: 'reviewed' }, evidence: { by: 'claude', model: 'm1', confidence: 'low', status: 'auto' } }, links: { out: [{ rel: 'CITES', key: 'doi:2' }], in: [] } }] });
      r = await hub(['item', 'get', 'doi:10.1/x']);
      assert.ok(r.stdout.includes('title: T [source]') && r.stdout.includes('year: 2020 [you]') && r.stdout.includes('evidence: {"n":5} [claude, m1, low]') && r.stdout.includes('authors: Ada') && !r.stdout.includes('tldr') && r.stdout.includes('-> CITES doi:2'), r.stdout);

      reset({ 'POST /api/items': [201, { key: 'usecase:u' }] });
      r = await hub(['item', 'add', 'use_case', '-', '--set', 'status=idea', '--slug', 'u'], { input: '{"title":"U","actors":[{"role":"payer"}]}' });
      assert.deepEqual(seen[0].body, { collection: 'use_case', fields: { title: 'U', actors: [{ role: 'payer' }], status: 'idea' }, slug: 'u' });
      r = await hub(['item', 'add', 'use_case', '-'], { input: '[{"title":"U"}]' });
      assert.equal(r.code, 1); assert.match(r.stderr, /expected a JSON object/);
      r = await hub(['item', 'add', 'use_case', '-'], { input: '{not json' });
      assert.equal(r.code, 1); assert.match(r.stderr, /fields: /); assert.equal(seen.length, 1, 'bad JSON sends nothing');
      reset({ 'PATCH /api/items/method%3Aa': [200, { key: 'method:a', filled: ['year'] }] });
      r = await hub(['item', 'edit', 'method:a', '--set', 'year=2024', '--set', 'tags=["a","b"]', '--set', 'note=hello world', '--set', 'tldr=null']);
      assert.deepEqual(seen[0].body, { fields: { year: 2024, tags: ['a', 'b'], note: 'hello world', tldr: null } }, 'values are JSON when they parse, text otherwise');
      r = await hub(['item', 'edit', 'method:a']); assert.equal(r.code, 1); assert.match(r.stderr, /nothing to change/);
      r = await hub(['item', 'edit', 'method:a', '--set', 'oops']); assert.equal(r.code, 1); assert.match(r.stderr, /--set needs field=value/);
      reset({ 'DELETE /api/items/method%3Aa': [200, { deleted: 'method:a' }] });
      r = await hub(['item', 'rm', 'method:a']);
      assert.equal(r.code, 1); assert.match(r.stderr, /add --yes/); assert.equal(seen.length, 0, 'nothing deleted without --yes');
      r = await hub(['item', 'rm', 'method:a', '--yes']); assert.equal(seen[0].method, 'DELETE');
      reset({ 'PUT /api/items/method%3Aa/links': [200, { created: true }], 'DELETE /api/items/method%3Aa/links': [200, { deleted: 1 }] });
      await hub(['item', 'link', 'method:a', 'ADDRESSES', 'usecase:u', '--evidence', 'why', '--confidence', 'high']);
      assert.deepEqual(seen[0].body, { rel: 'ADDRESSES', target: 'usecase:u', evidence: 'why', confidence: 'high' });
      await hub(['item', 'unlink', 'method:a', 'ADDRESSES', 'usecase:u']);
      assert.equal(seen[1].url, '/api/items/method%3Aa/links?rel=ADDRESSES&target=usecase%3Au');
      r = await hub(['item', 'frobnicate']); assert.equal(r.code, 1); assert.match(r.stderr, /list \| get \| add/);
      reset({ 'PUT /api/items/doi%3A1/links': [200, { created: true }], 'PATCH /api/vocab': [200, { key: 'concept:x' }] });
      await hub(['item', 'link', 'doi:1', 'TESTS', 'hypothesis:h', '--result', 'mixed', '--evidence', 'e']);
      assert.deepEqual(seen[0].body, { rel: 'TESTS', target: 'hypothesis:h', evidence: 'e', result: 'mixed' });
      await hub(['vocab', 'iri', 'concept:x', 'https://example.org/onto#X', '--ontology', 'ontology:o']);
      assert.deepEqual([seen[1].url, seen[1].body], ['/api/vocab?key=concept%3Ax', { external_iri: 'https://example.org/onto#X', defined_in: 'ontology:o' }]);
      await hub(['vocab', 'iri', 'concept:x', 'none', '--ontology', 'none']);
      assert.deepEqual(seen[2].body, { external_iri: null, defined_in: null });
      r = await hub(['vocab', 'list']); assert.equal(r.code, 1); assert.match(r.stderr, /usage: hub vocab iri/);
      reset({ 'POST /api/ontologies/snapshot': [201, { key: 'ontology:o' }], 'DELETE /api/ontologies/snapshot': [200, { removed: true }] });
      const onto = path.join(home, 'fibo.ttl'); fs.writeFileSync(onto, '@prefix a: <b> .');
      await hub(['ontology', 'snapshot', 'ontology:o', onto]);
      assert.deepEqual([seen[0].url, seen[0].type, seen[0].raw.toString()], ['/api/ontologies/snapshot?key=ontology%3Ao&name=fibo.ttl', 'application/octet-stream', '@prefix a: <b> .']);
      await hub(['ontology', 'snapshot', 'ontology:o', 'https://spec.example.org/fibo.owl']);
      assert.deepEqual(seen[1].body, { url: 'https://spec.example.org/fibo.owl' });
      await hub(['ontology', 'snapshot', 'ontology:o', 'none']);
      assert.equal(seen[2].method, 'DELETE');
      r = await hub(['ontology', 'snapshot', 'ontology:o', path.join(home, 'missing.ttl')]); assert.equal(r.code, 1); assert.match(r.stderr, /file not found/);
      reset({ 'GET /api/oauth/grants': [200, { connections: [] }], 'DELETE /api/oauth/grants': [200, { revoked: 1 }] });
      await hub(['oauth']); await hub(['oauth', 'revoke', 'abc def']); await hub(['oauth', 'revoke-all']);
      assert.deepEqual(seen.map((x) => [x.method, x.url]), [['GET', '/api/oauth/grants'], ['DELETE', '/api/oauth/grants?id=abc%20def'], ['DELETE', '/api/oauth/grants?all=1']]);
      r = await hub(['oauth', 'revoke']); assert.equal(r.code, 1); assert.match(r.stderr, /usage: hub oauth/);

      // analyze: identity from the argument, everything else from stdin
      reset({ 'POST /api/analysis': (q) => [201, { key: q.body.doi ? 'doi:' + q.body.doi : q.body.key || 'paper:u', created: true }], 'POST /api/papers/file': [200, { file_url: 'https://drive' }] });
      const AJ = JSON.stringify({ fields: { tldr: 't' }, links: [{ rel: 'ABOUT', target: 'x', kind: 'Topic' }], confidence: { tldr: 'high' } });
      r = await hub(['analyze', 'https://doi.org/10.1/X', '--model', 'm1', '--deep', '--force'], { input: AJ });
      assert.deepEqual(seen[0].body, { collection: 'paper', model: 'm1', fields: { tldr: 't' }, links: [{ rel: 'ABOUT', target: 'x', kind: 'Topic' }], confidence: { tldr: 'high' }, tier: 'deep', force: true, doi: '10.1/X' });
      await hub(['analyze', 'https://example.org/p.html'], { input: '{}', extraEnv: { HUB_MODEL: 'env-model' } });
      assert.deepEqual([seen[1].body.url, seen[1].body.model, seen[1].body.collection], ['https://example.org/p.html', 'env-model', 'paper']);
      await hub(['analyze', 'usecase:offline'], { input: '{"model":"json-model","fields":{"goal":"g"}}' });
      assert.deepEqual([seen[2].body.key, seen[2].body.collection, seen[2].body.model], ['usecase:offline', 'use_case', 'json-model'], 'the collection follows the key');
      r = await hub(['analyze', '10.1/y'], { input: '{}' }); assert.equal(r.code, 1); assert.match(r.stderr, /which model/); assert.equal(seen.length, 3);
      r = await hub(['analyze', 'just words'], { input: '{}' }); assert.equal(r.code, 1); assert.match(r.stderr, /not a DOI, URL, key or PDF/);
      const pdf = path.join(home, 'paper.pdf'); fs.writeFileSync(pdf, '%PDF-1.4 test');
      r = await hub(['analyze', pdf, '--model', 'm'], { input: '{}' }); assert.equal(r.code, 1); assert.match(r.stderr, /needs the paper's "doi" or "url"/);
      reset({ 'POST /api/analysis': [201, { key: 'doi:10.2/p', created: true }], 'POST /api/papers/file': [200, { file_url: 'https://drive' }] });
      r = await hub(['analyze', pdf, '--model', 'm'], { input: '{"doi":"10.2/p","fields":{}}' });
      assert.equal(seen[0].body.doi, '10.2/p');
      assert.deepEqual([seen[1].url, seen[1].type, seen[1].raw.toString()], ['/api/papers/file?key=doi%3A10.2%2Fp', 'application/pdf', '%PDF-1.4 test'], 'the PDF is uploaded and linked');
      assert.deepEqual(JSON.parse(r.stdout).file, { file_url: 'https://drive' });

      // audit
      const prov = (o) => ({ fields: o.fields || {}, provenance: o.provenance });
      reset({
        'GET /api/audit': [200, { counts: { low_confidence: 1, unreviewed_items: 2 }, low_confidence: [{ key: 'a', title: 'Item A', field: 'f2' }], unreviewed_items: [{ key: 'a' }, { key: 'b' }] }],
        'GET /api/items/a': [200, prov({ provenance: { f1: { by: 'claude', status: 'auto', confidence: 'medium' }, f2: { by: 'claude', status: 'auto', confidence: 'low' }, f3: { by: 'owner', status: 'reviewed' }, f4: { by: 'claude', status: 'reviewed' } } })],
        'GET /api/items/b': [200, prov({ fields: { key_findings: [{ text: 'x' }] }, provenance: { key_findings: { by: 'claude', status: 'auto' }, f5: { by: 'claude', status: 'auto' } } })],
        'POST /api/audit/accept': [200, { record_status: 'auto' }],
      });
      r = await hub(['audit', '--accept-all-unchanged', '--dry-run']);
      assert.deepEqual(JSON.parse(r.stdout), { accepted: { a: ['f1'], b: ['f5'] }, skipped: { a: ['f2 (low confidence)'], b: ['key_findings (ungrounded)'] }, dry_run: true });
      assert.ok(!seen.some((x) => x.method === 'POST'), 'a dry run accepts nothing');
      seen.length = 0;
      r = await hub(['audit', '--accept-all-unchanged']);
      assert.deepEqual(seen.filter((x) => x.method === 'POST').map((x) => x.body), [{ key: 'a', fields: ['f1'] }, { key: 'b', fields: ['f5'] }]);
      assert.equal(new URL('http://x' + seen[0].url).searchParams.get('limit'), '1000');
      r = await hub(['audit']);
      assert.ok(r.stdout.includes('low confidence: 1') && r.stdout.includes('a  Item A  f2'), r.stdout);

      // rate limited: wait as told and retry; give up after HUB_MAX_RETRIES
      let tries = 0;
      reset({ 'GET /api/items/method%3Aa': () => (tries++ < 1 ? [429, { error: 'Too many heavy requests' }, { 'Retry-After': '2' }] : [200, { key: 'method:a', collection: 'method', fields: {}, provenance: {}, links: { out: [], in: [] } }]) });
      const t0 = Date.now();
      r = await hub(['item', 'get', 'method:a', '--json']);
      assert.equal(r.code, 0, r.stderr); assert.equal(seen.length, 2); assert.match(r.stderr, /rate limited; retrying in 2s/); assert.ok(Date.now() - t0 >= 1900, 'Retry-After is honoured');
      tries = 0;
      r = await hub(['item', 'get', 'method:a'], { extraEnv: { HUB_MAX_RETRIES: '0' } });
      assert.equal(r.code, 1); assert.match(r.stderr, /429 Too many heavy requests/);

      // schema of a collection
      reset({ 'GET /api/schema': [200, publicView()] });
      r = await hub(['schema', 'case-studies']);
      assert.ok(/case_type\s+enum\s+core\s+YC\s+deployment\|pilot/.test(r.stdout) && r.stdout.includes('organisations') && r.stdout.includes('Organisation'), r.stdout);
      r = await hub(['schema', 'gadgets']); assert.equal(r.code, 1); assert.match(r.stderr, /no collection "gadgets" \(paper, method, use_case, case_study, framework, research_question, hypothesis, ontology\)/);
    } finally { fake.close(); }

    // every command the CLI handles is in its help and in the README
    const hubSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'bin', 'hub'), 'utf8');
    const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
    const help = hubSrc.slice(hubSrc.indexOf('const HELP'), hubSrc.indexOf('`;', hubSrc.indexOf('const HELP')));
    const commands = [...hubSrc.matchAll(/cmd === '([a-z-]+)'/g)].map((m) => m[1]).filter((c) => c !== 'help');
    const subs = [...hubSrc.slice(hubSrc.indexOf('async function itemCommand')).matchAll(/sub === '([a-z]+)'/g)].map((m) => 'item ' + m[1]);
    assert.ok(commands.length > 15 && subs.length >= 7);
    for (const c of [...commands, ...subs]) {
      assert.ok(help.includes('hub ' + c), `help lists "hub ${c}"`);
      assert.ok(readme.includes('hub ' + c), `README mentions "hub ${c}"`);
    }
  }

  /* ------------------------------------------------------------ the API docs match the routes */
  {
    const openapi = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf8'));
    const routes = new Set();
    const toDoc = (p) => (p instanceof RegExp ? p.source.replace(/^\^\\\//, '/').replace(/\\\//g, '/').replace('(.+)', '{key}').replace(/\$$/, '') : String(p).replace(/:([a-z_]+)/gi, '{$1}'));
    const fakeApp = new Proxy({}, { get: (_t, m) => (m === 'use' ? () => {} : (p) => { if (['get', 'post', 'put', 'patch', 'delete'].includes(m) && toDoc(p).startsWith('/api/')) routes.add(`${m.toUpperCase()} ${toDoc(p)}`); }) });
    for (const d of fs.readdirSync(path.join(__dirname, '..', 'features'))) require(`../features/${d}`).mount(fakeApp);
    // /api/ routes only: /healthz, /readyz and /mcp are documented too but mounted outside the feature API
    const documented = new Set(Object.entries(openapi.paths).filter(([p]) => p.startsWith('/api/')).flatMap(([p, ops]) => Object.keys(ops).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map((m) => `${m.toUpperCase()} ${p}`)));
    assert.ok(routes.has('PATCH /api/items/{key}') && routes.has('PUT /api/items/{key}/links') && routes.has('GET /api/vocab'), [...routes].join(', '));
    assert.deepEqual([...routes].filter((r) => !documented.has(r)).sort(), [], 'every route is in web/openapi.json');
    assert.deepEqual([...documented].filter((r) => !routes.has(r)).sort(), [], 'openapi.json documents no route that does not exist');
  }

  /* ------------------------------------------------------------ hardening (Task 7) */
  {
    const config = require('../core/config');
    const G0 = { HUB_API_TOKEN: 'x'.repeat(32), NEO4J_PASSWORD: 'a-long-enough-password' };
    // TRUST_PROXY
    assert.deepEqual(['', '2', 'true', 'false', '10.0.0.0/8'].map((v) => config.get({ TRUST_PROXY: v }).trustProxy), ['loopback', 2, true, false, '10.0.0.0/8']);
    assert.strictEqual(config.get({ TRUST_PROXY: '2' }).trustProxy, 2, 'a hop count is a number (a string would be read as an address)');
    assert.equal(config.get({ NODE_ENV: 'production' }).trustProxy, 1, 'production believes one proxy by default (Cloud Run), never every client-written entry');
    const prodWarn = (extra) => config.problems(config.get({ NODE_ENV: 'production', ...G0, OPENALEX_EMAIL: 'me@x.org', ...extra })).warnings.join(' | ');
    assert.ok(/TRUST_PROXY=true/.test(prodWarn({ TRUST_PROXY: 'true' })) && !/TRUST_PROXY/.test(prodWarn({})));
    assert.ok(/NEO4J_PASSWORD is shorter than 12/.test(prodWarn({ NEO4J_PASSWORD: 'short-pw' })));
    assert.ok(/OPENALEX_EMAIL is not set/.test(prodWarn({ OPENALEX_EMAIL: '' })) && !/OPENALEX_EMAIL/.test(prodWarn({})));
    assert.ok(/MAX_UPLOAD_MB is above 32/.test(prodWarn({ MAX_UPLOAD_MB: '50' })) && !/MAX_UPLOAD/.test(prodWarn({ MAX_UPLOAD_MB: '30' })));
    assert.deepEqual(config.problems(config.get({ NODE_ENV: 'production', ...G0 })).errors, [], 'warnings, not errors: an upgrade must not stop a running deployment');
    assert.deepEqual(config.get({ PDF_FETCH_ALLOWED_HOSTS: ' A.org, b.org ,' }).pdfFetchAllowedHosts, ['a.org', 'b.org']);
    assert.equal(config.get({}).skin, 'paper');
    // what trust proxy does to the client IP
    const appT = require('express')();
    let tp = 1;
    appT.get('/ip', (req, res) => { appT.set('trust proxy', tp); res.json({ ip: req.ip }); });
    const srvT = await new Promise((ok) => { const x = appT.listen(0, '127.0.0.1', () => ok(x)); });
    const ipOf = async (v, xff) => { tp = v; await fetch(`http://127.0.0.1:${srvT.address().port}/ip`); return (await (await fetch(`http://127.0.0.1:${srvT.address().port}/ip`, { headers: { 'X-Forwarded-For': xff } })).json()).ip; };
    try {
      assert.equal(await ipOf(1, 'spoofed-by-client, 203.0.113.9'), '203.0.113.9', 'one hop: the entry the proxy appended');
      assert.equal(await ipOf(true, 'spoofed-by-client, 203.0.113.9'), 'spoofed-by-client', 'why true is dangerous');
    } finally { srvT.close(); }
    // heavy budget and login budget are wired in server.js
    const { HEAVY } = require('../core/ratelimit');
    for (const p of ['/api/query', '/mcp', '/api/analysis', '/api/audit', '/api/backup', '/api/restore', '/api/import', '/api/export', '/api/enrich', '/api/notes/sync']) assert.ok(HEAVY.includes(p), p);
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(serverSrc.includes('root.use(HEAVY, limiter({ max: cfg.heavyRateLimitPerMin') && serverSrc.includes("app.set('trust proxy', cfg.trustProxy)"));
    assert.ok(!/process\.env\./.test(serverSrc));
    // no module reads the environment except config.js and env.js (CLAUDE.md, rule 8)
    const readsEnv = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith('.js') && /process\.env\b/.test(fs.readFileSync(f, 'utf8'))) readsEnv.push(path.relative(path.join(__dirname, '..'), f)); } };
    for (const d of ['core', 'features', 'migrations']) walk(path.join(__dirname, '..', d));
    assert.deepEqual(readsEnv.sort(), ['core/config.js', 'core/env.js']);
    // OPENALEX_EMAIL reaches Crossref through config
    const crossref = require('../features/papers/crossref');
    let ua = null;
    crossref.setHttp(async (_u, o) => { ua = o.headers['User-Agent']; return { ok: false, status: 404, json: async () => ({}) }; });
    process.env.OPENALEX_EMAIL = 'owner@example.org';
    await crossref.resolveDoi('10.1/x');
    delete process.env.OPENALEX_EMAIL;
    assert.match(ua, /mailto:owner@example\.org/);
    crossref.setHttp((u, o) => fetch(u, o));
    // MCP: our errors reach the client; anything else is masked in production
    const mcp = require('../features/mcp');
    const { HttpError } = require('../core/errors');
    const silence = console.error; console.error = () => {};
    try {
      assert.equal(mcp.toolError(new HttpError(400, 'title is required')).content[0].text, 'title is required');
      assert.equal(mcp.toolError(new Error('connection to 10.0.0.5:7687 refused')).content[0].text, 'connection to 10.0.0.5:7687 refused', 'locally the detail helps');
      process.env.NODE_ENV = 'production';
      assert.equal(mcp.toolError(new Error('connection to 10.0.0.5:7687 refused')).content[0].text, 'Internal error (see the server log)');
      assert.equal(mcp.toolError(new HttpError(404, 'No such item')).content[0].text, 'No such item');
    } finally { delete process.env.NODE_ENV; console.error = silence; }
    // size caps
    const analysisMod = require('../core/analysis');
    await assert.rejects(() => analysisMod.save({ collection: 'paper', doi: '10.1/x', model: 'm', links: Array(201).fill({ rel: 'ABOUT', target: 'x' }) }), (e) => e.status === 400 && /at most 200 links/.test(e.message));
    await assert.rejects(() => analysisMod.save({ collection: 'paper', doi: '10.1/x', model: 'm', fields: Object.fromEntries(Array.from({ length: 301 }, (_, i) => ['f' + i, 1])) }), (e) => e.status === 400 && /at most 300 fields/.test(e.message));
    runImpl = async (q) => (q.includes('AS inc') ? [{ labels: ['Artifact', 'Method'], props: { key: 'method:cap', title: 'Cap' }, out: [], inc: [] }] : []);
    await assert.rejects(() => items.update('method:cap', { domain: Array.from({ length: 101 }, (_, i) => 'd' + i) }), (e) => e.status === 400 && /at most 100 values/.test(e.message));
    await assert.rejects(() => items.list({ collection: 'method', q: 'x'.repeat(501) }), (e) => e.status === 400 && /q is limited to 500/.test(e.message));
    runImpl = async () => [];
    // the public preview skips case studies marked confidential, and their edges (internal ones follow their visibility)
    let pubQ = [];
    runImpl = async (q) => { pubQ.push(q); return []; };
    pubExport.invalidate(); await pubExport.read(); pubExport.invalidate();
    pubQ = pubQ.filter((q) => q.includes(':Artifact'));
    assert.equal(pubQ.length, 3);
    for (const q of pubQ) assert.ok(q.includes("coalesce(a.sensitivity, 'public') <> 'confidential'"), q);
    assert.ok(pubQ[2].includes("coalesce(b.sensitivity, 'public') <> 'confidential'"), 'and items linked from public ones');
    runImpl = async () => [];
  }

  /* ------------------------------------------------------------ publishing: default visibility, basic or full public detail */
  {
    const publishing = require('../core/publishing');
    const pubExport = require('../core/public-export');
    const fakeDb = require.cache[dbPath].exports;
    const realExec = fakeDb.exec;
    let setting = null; // what (:HubSetting {id:'publishing'}) holds
    const fresh = () => { publishing.forget(); pubExport.invalidate(); };
    try {
      // the setting: defaults until the owner chooses, bad stored values ignored
      runImpl = async (q) => (q.includes('HubSetting') ? (setting ? [setting] : []) : []);
      fresh(); assert.deepEqual(await publishing.get(), { default_visibility: 'private', public_detail: 'basic' });
      setting = { default_visibility: 'public', public_detail: 'full' }; fresh();
      assert.deepEqual(await publishing.get(), setting);
      setting = { default_visibility: 'everyone', public_detail: 'full' }; fresh();
      assert.equal((await publishing.get()).default_visibility, 'private', 'an unknown stored value falls back to the default');
      const writes = [];
      fakeDb.exec = async (q, p) => { writes.push([q, p]); return q.includes('count(a)') ? [{ changed: 7 }] : []; };
      setting = null; fresh();
      await publishing.set({ public_detail: 'full' });
      assert.ok(writes[0][0].includes("MERGE (s:HubSetting {id:'publishing'}) SET s += $changes") && writes[0][1].changes.public_detail === 'full');
      for (const bad of [{ shown: 'all' }, { public_detail: 'everything' }, { default_visibility: 'hidden' }, {}, null]) await assert.rejects(() => publishing.set(bad), (e) => e.status === 400, JSON.stringify(bad));
      assert.deepEqual(await publishing.applyToAll('public'), { visibility: 'public', changed: 7 });
      assert.ok(writes.at(-1)[0].includes('SET a.visibility = $v') && writes.at(-1)[1].v === 'public');
      await assert.rejects(() => publishing.applyToAll('hidden'), (e) => e.status === 400);

      // never shown: Drive ids, local paths, links into Drive; everything else is
      assert.deepEqual(publishing.fullProps({ title: 'T', abstract: 'A', url: 'https://arxiv.org/abs/1', file_url: 'https://drive.google.com/file/d/ABCDEFGHIJKL/view',
        drive_file_id: 'ABCDEFGHIJKL', source_path: '/Users/me/x.md', path: 'notes/x.md', snapshot__file_url: 'https://docs.google.com/document/d/1/edit', provenance_json: '{}' }),
      { title: 'T', abstract: 'A', url: 'https://arxiv.org/abs/1', provenance_json: '{}' });
      assert.ok(publishing.isDriveLink('https://drive.google.com/drive/folders/X') && !publishing.isDriveLink('https://arxiv.org/pdf/1') && !publishing.isDriveLink('drive.google.com'));

      // the public export follows the setting
      const node = { key: 'note:n', labels: ['Artifact', 'Note'], props: { key: 'note:n', title: 'N', summary: 'S', abstract: 'A', body: '# Hello', visibility: 'public',
        drive_file_id: 'ABCDEFGHIJKL', file_url: 'https://drive.google.com/file/d/ABCDEFGHIJKL/view', url: 'https://arxiv.org/abs/1' } };
      runImpl = async (q) => (q.includes('HubSetting') ? (setting ? [setting] : []) : q.includes('RETURN a.key AS key') ? [node] : []);
      setting = null; fresh();
      let out = await pubExport.build();
      assert.equal(out.detail, 'basic');
      assert.deepEqual(out.nodes[0].props, { key: 'note:n', title: 'N', summary: 'S', url: 'https://arxiv.org/abs/1' }, 'basic: the whitelist only');
      assert.ok(!('html' in out.nodes[0]));
      setting = { public_detail: 'full' }; fresh();
      out = await pubExport.build();
      assert.equal(out.detail, 'full');
      assert.equal(out.nodes[0].props.abstract, 'A'); assert.equal(out.nodes[0].props.body, '# Hello');
      assert.ok(!('drive_file_id' in out.nodes[0].props) && !('file_url' in out.nodes[0].props), 'full: still no Drive copies');
      assert.match(out.nodes[0].html, /<h1[^>]*>Hello<\/h1>/, 'full: the note text as HTML');

      // new items get the default; an explicit visibility wins; existing items are not touched
      runImpl = async (q) => (q.includes('HubSetting') ? (setting ? [setting] : []) : []);
      setting = { default_visibility: 'public' }; fresh(); calls.length = 0;
      await artifacts.add('use_case', { title: 'Default public' });
      let [w] = calls.filter(([q]) => q.includes('n += $onCreate'));
      assert.equal(w[1].onCreate.visibility, 'public'); assert.ok(!('visibility' in w[1].props));
      calls.length = 0;
      await artifacts.add('use_case', { title: 'Said private', visibility: 'private' });
      [w] = calls.filter(([q]) => q.includes('n += $onCreate'));
      assert.equal(w[1].onCreate.visibility, 'private'); assert.equal(w[1].props.visibility, 'private');
      await assert.rejects(() => artifacts.add('use_case', { title: 'Bad', visibility: 'secret' }), (e) => e.status === 400);
      // papers: a public or private tag decides, no tag leaves it to the default; Markdown notes without a visibility line follow it
      const pItem = require('../features/papers/item');
      const base = { itemType: 'journalArticle', title: 'T', creators: [], date: '2020' };
      assert.equal(pItem.nodeFields(pItem.normalizeItem({ ...base, tags: ['private'] })).visibility, 'private');
      assert.equal(pItem.nodeFields(pItem.normalizeItem({ ...base, tags: ['public'] })).visibility, 'public');
      assert.equal(pItem.nodeFields(pItem.normalizeItem({ ...base, tags: [] })).visibility, null);
      assert.equal(notes.toItem({ path: 'notes/a.md', meta: {}, body: '' }, 'public').item.props.visibility, 'public');
      assert.equal(notes.toItem({ path: 'notes/a.md', meta: { visibility: 'private' }, body: '' }, 'public').item.props.visibility, 'private');

      // an item for visitors: refs to private items, Drive links and bookkeeping are left out
      const { publicItem } = require('../features/publishing');
      const vis = publicItem({ key: 'method:pub', collection: 'method', record_status: 'auto', created_at: null, updated_at: null, provenance: { summary: { by: 'claude' } },
        fields: { summary: 'S', used_in: [{ key: 'usecase:secret', name: 'Secret' }, { key: 'usecase:open', name: 'Open' }, { key: null, name: 'free text' }],
          urls: [{ url: 'https://drive.google.com/file/d/ABCDEFGHIJKL/view', role: 'copy' }, { url: 'https://arxiv.org/abs/1', role: 'paper' }] },
        meta: { file_url: 'https://drive.google.com/file/d/ABCDEFGHIJKL/view', drive_file_id: 'ABCDEFGHIJKL', source_path: '/Users/me' },
        extra: { custom: 'ok', source_path: '/Users/me' }, links: { out: [{ key: 'usecase:secret' }], in: [] } }, new Set(['method:pub', 'usecase:open']));
      assert.deepEqual(vis.fields.used_in, [{ key: 'usecase:open', name: 'Open' }, { key: null, name: 'free text' }]);
      assert.deepEqual(vis.fields.urls, [{ role: 'copy' }, { url: 'https://arxiv.org/abs/1', role: 'paper' }]);
      assert.deepEqual(vis.meta, {}); assert.deepEqual(vis.extra, { custom: 'ok' }); assert.deepEqual(vis.links, { out: [], in: [] });
      assert.deepEqual(vis.provenance, { summary: { by: 'claude' } });

      // the routes: settings are owner only; the public item exists only in full mode, and only for public items.
      // PUBLIC_ACCESS off (the default): nothing is public and the settings cannot be changed.
      const appP = require('express')();
      require('../features/publishing').mount(appP); require('../features/session').mount(appP); require('../features/graph').mount(appP);
      appP.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
      const srvP = await new Promise((ok) => { const x = appP.listen(0, '127.0.0.1', () => ok(x)); });
      const pBase = `http://127.0.0.1:${srvP.address().port}`;
      const OWN = { Authorization: 'Bearer abc', 'Content-Type': 'application/json' };
      try {
        for (const [m, u] of [['GET', '/api/settings/publishing'], ['PUT', '/api/settings/publishing'], ['POST', '/api/settings/publishing/apply']]) {
          assert.equal((await fetch(pBase + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'GET' ? undefined : '{}' })).status, 401, `${m} ${u} is owner only`);
        }
        setting = null; fresh();
        delete process.env.PUBLIC_ACCESS;
        assert.deepEqual(await (await fetch(pBase + '/api/settings/publishing', { headers: OWN })).json(), { default_visibility: 'private', public_detail: 'basic', public_access: false });
        assert.equal((await (await fetch(pBase + '/api/me')).json()).public_access, false);
        for (const [m, u, b] of [['PUT', '/api/settings/publishing', '{"public_detail":"full"}'], ['POST', '/api/settings/publishing/apply', '{"visibility":"public"}']]) {
          const r = await fetch(pBase + u, { method: m, headers: OWN, body: b });
          assert.equal(r.status, 409, `${m} ${u}: refused while public access is off`); assert.match((await r.json()).error, /PUBLIC_ACCESS/);
        }
        setting = { public_detail: 'full' };
        const pubRow = { key: 'method:pub', labels: ['Artifact', 'Method'], props: { key: 'method:pub', title: 'Pub', visibility: 'public' } };
        runImpl = async (q) => (q.includes('HubSetting') ? [setting] : q.includes('RETURN a.key AS key') ? [pubRow] : q.includes('AS inc') ? [{ labels: pubRow.labels, props: pubRow.props, out: [], inc: [] }] : []);
        fresh();
        assert.equal((await fetch(pBase + '/api/public')).status, 401, 'no public preview without the token');
        assert.equal((await fetch(pBase + '/api/public/items/method%3Apub')).status, 401, 'no public item without the token, even in full mode');
        const ownPub = await fetch(pBase + '/api/public', { headers: OWN });
        assert.equal(ownPub.status, 200); assert.match(ownPub.headers.get('cache-control'), /^private/, 'owner-only: never in a shared cache');
        process.env.PUBLIC_ACCESS = '1';
        setting = null; fresh();
        assert.equal((await (await fetch(pBase + '/api/me')).json()).public_access, true);
        const anonPub = await fetch(pBase + '/api/public');
        assert.equal(anonPub.status, 200); assert.match(anonPub.headers.get('cache-control'), /^public/);
        assert.equal((await fetch(pBase + '/api/settings/publishing', { method: 'PUT', headers: OWN, body: '{"public_detail":"loud"}' })).status, 400);
        const methodRow = { labels: ['Artifact', 'Method'], props: { key: 'method:pub', title: 'Pub', collection: 'method', visibility: 'public', summary: 'S', source_path: '/Users/me' }, out: [], inc: [] };
        runImpl = async (q) => (q.includes('HubSetting') ? (setting ? [setting] : []) : q.includes('RETURN a.key AS key') ? [{ key: 'method:pub', labels: ['Artifact', 'Method'], props: methodRow.props }] : q.includes('AS inc') ? [methodRow] : []);
        fresh();
        assert.equal((await fetch(pBase + '/api/public/items/method%3Apub')).status, 404, 'basic mode: no full items');
        setting = { public_detail: 'full' }; fresh();
        const got = await fetch(pBase + '/api/public/items/method%3Apub');
        assert.equal(got.status, 200);
        const gotItem = await got.json();
        assert.equal(gotItem.fields.summary, 'S'); assert.ok(!JSON.stringify(gotItem).includes('/Users/me'), 'no local paths');
        assert.equal((await fetch(pBase + '/api/public/items/method%3Aprivate')).status, 404, 'only items in the public export');
      } finally { await new Promise((ok) => srvP.close(ok)); delete process.env.PUBLIC_ACCESS; }
    } finally { fakeDb.exec = realExec; setting = null; fresh(); runImpl = async () => []; }
  }

  /* ------------------------------------------------------------ Task 10: curation operations (pure) and routes */
  {
    const cops = require('../core/curation-ops');
    const curation = require('../core/curation');
    const neo4jDriver = require('neo4j-driver');
    const now = { $datetime: '2026-11-01T12:00:00Z' };
    const fixture = () => ({
      nodes: {
        'doi:1': { labels: ['Artifact', 'Paper'], props: { key: 'doi:1', title: 'Zero knowledge payments', year: { $int: '2024' }, summary: 'mine', record_status: 'reviewed',
          provenance_json: JSON.stringify({ summary: { by: 'owner', status: 'reviewed' } }), updated_at: { $datetime: '2026-01-01T00:00:00Z' } } },
        'paper:x': { labels: ['Artifact', 'Paper'], props: { key: 'paper:x', title: 'Zero-knowledge payments', year: { $int: '2023' }, summary: 'theirs', abstract: 'A',
          key_findings_json: '[{"text":"f"}]', provenance_json: JSON.stringify({ key_findings: { by: 'claude', status: 'auto' }, summary: { by: 'claude', status: 'auto' } }),
          file_url: 'https://drive.google.com/file/d/AAAAAAAAAAAA/view', drive_file_id: 'AAAAAAAAAAAA', merged_from: ['paper:old'] } },
        'concept:zk': { labels: ['Concept'], props: { key: 'concept:zk', name: 'zero knowledge', aliases: [] } },
        'concept:zkp': { labels: ['Concept'], props: { key: 'concept:zkp', name: 'ZKP', aliases: ['zk proofs'] } },
        'personal:paper:x': { labels: ['Personal'], props: { key: 'personal:paper:x', status: 'reading' } },
      },
      rels: [
        { type: 'ABOUT', from: 'doi:1', to: 'concept:zk', props: { source: 'hub' } },
        { type: 'ABOUT', from: 'paper:x', to: 'concept:zk', props: { source: 'other' } },
        { type: 'ABOUT', from: 'paper:x', to: 'concept:zkp', props: {} },
        { type: 'CITES', from: 'paper:x', to: 'doi:1', props: {} },
        { type: 'ANNOTATES', from: 'note:n', to: 'paper:x', props: { location: 'p. 2' } },
        { type: 'FOR', from: 'personal:paper:x', to: 'paper:x', props: {} },
      ],
      ends: { 'doi:1': 'Artifact', 'paper:x': 'Artifact', 'concept:zk': 'Concept', 'concept:zkp': 'Concept', 'personal:paper:x': 'Personal', 'note:n': 'Artifact' },
    });
    const rels = (st) => st.rels.map((r) => `${r.from} ${r.type} ${r.to}`).sort();

    // merge two papers
    const st0 = fixture();
    const before = JSON.stringify(st0);
    let { after, changes, trash } = cops.applyOps(st0, [{ op: 'merge', keep: 'doi:1', drop: 'paper:x' }], { now });
    assert.equal(JSON.stringify(st0), before, 'the input snapshot is never changed');
    const K = after.nodes['doi:1'].props;
    assert.ok(!after.nodes['paper:x'], 'drop is gone');
    assert.equal(K.abstract, 'A'); assert.equal(K.key_findings_json, '[{"text":"f"}]'); assert.equal(K.summary, 'mine'); assert.deepEqual(K.year, { $int: '2024' });
    assert.deepEqual(JSON.parse(K.provenance_json), { summary: { by: 'owner', status: 'reviewed' }, key_findings: { by: 'claude', status: 'auto' } }, 'copied fields bring their provenance');
    assert.equal(K.record_status, 'auto', 'unreviewed Claude values came along: needs review again');
    assert.deepEqual(K.merged_from, ['paper:x', 'paper:old']);
    assert.equal(K.file_url, 'https://drive.google.com/file/d/AAAAAAAAAAAA/view'); assert.equal(K.drive_file_id, 'AAAAAAAAAAAA');
    assert.deepEqual(trash, [], 'a moved file is never trashed');
    assert.deepEqual(K.updated_at, now);
    assert.deepEqual(rels(after), ['doi:1 ABOUT concept:zk', 'doi:1 ABOUT concept:zkp', 'note:n ANNOTATES doi:1', 'personal:doi:1 FOR doi:1'].sort());
    assert.deepEqual(after.rels.find((r) => r.type === 'ABOUT' && r.to === 'concept:zk').props, { source: 'hub' }, "keep's own link keeps its properties");
    assert.deepEqual(after.nodes['personal:doi:1'].props, { key: 'personal:doi:1', status: 'reading' }, 'the status moves');
    const [mc] = changes;
    assert.deepEqual(mc.moved_links, { ABOUT: 1, ANNOTATES: 1 }); assert.equal(mc.dropped_links, 2, 'the duplicate ABOUT and the self-citation');
    assert.deepEqual(mc.conflicts.map((c) => c.field).sort(), ['summary', 'title', 'year']);
    assert.deepEqual(mc.copied.sort(), ['abstract', 'key_findings']);
    // take: drop's value wins for that field; keep has its own file: drop's Drive copy goes to the trash
    const st1 = fixture(); st1.nodes['doi:1'].props.file_url = 'https://arxiv.org/pdf/1';
    st1.nodes['personal:doi:1'] = { labels: ['Personal'], props: { key: 'personal:doi:1', status: 'read' } };
    st1.rels.push({ type: 'FOR', from: 'personal:doi:1', to: 'doi:1', props: {} });
    ({ after, changes, trash } = cops.applyOps(st1, [{ op: 'merge', keep: 'doi:1', drop: 'paper:x', take: ['summary'] }], { now }));
    assert.equal(after.nodes['doi:1'].props.summary, 'theirs'); assert.deepEqual(changes[0].taken, ['summary']);
    assert.deepEqual(JSON.parse(after.nodes['doi:1'].props.provenance_json).summary, { by: 'claude', status: 'auto' });
    assert.equal(after.nodes['doi:1'].props.file_url, 'https://arxiv.org/pdf/1'); assert.deepEqual(trash, ['AAAAAAAAAAAA']);
    assert.equal(after.nodes['personal:doi:1'].props.status, 'read', "keep's own status stays"); assert.ok(!after.nodes['personal:paper:x']);
    // refusals
    const refused = (ops, status, re) => assert.throws(() => cops.applyOps(fixture(), ops, { now }), (e) => e.status === status && re.test(e.message), JSON.stringify(ops));
    refused([{ op: 'merge', keep: 'doi:1', drop: 'concept:zk' }], 400, /different kinds/);
    refused([{ op: 'merge', keep: 'doi:1', drop: 'doi:1' }], 400, /the same item/);
    refused([{ op: 'merge', keep: 'doi:1', drop: 'paper:nope' }], 404, /No such item: paper:nope/);
    refused([{ op: 'merge', keep: 'doi:1', drop: 'paper:x', take: ['venue'] }], 400, /venue is not set/);
    refused([{ op: 'merge', keep: 'doi:1', drop: 'paper:x' }, { op: 'delete', key: 'paper:x' }], 400, /^step 2 \(delete\): paper:x is removed by an earlier step/);
    refused([{ op: 'explode' }], 400, /op must be one of/);
    refused([], 400, /non-empty/);
    refused(Array(51).fill({ op: 'delete', key: 'doi:1' }), 400, /At most 50/);

    // vocabulary: drop's name and aliases become keep's aliases, with the matcher's fields
    ({ after, changes } = cops.applyOps(fixture(), [{ op: 'merge', keep: 'concept:zk', drop: 'concept:zkp' }], { now }));
    const Z = after.nodes['concept:zk'].props;
    assert.deepEqual(Z.aliases, ['ZKP', 'zk proofs']); assert.deepEqual(changes[0].aliases_added, ['ZKP', 'zk proofs']);
    assert.ok(Z.aliases_norm.length === 2 && Z.aliases_text.includes('zkp'), JSON.stringify(Z));
    assert.deepEqual(rels(after).filter((r) => r.includes('concept')), ['doi:1 ABOUT concept:zk', 'paper:x ABOUT concept:zk'], 'the duplicate ABOUT from paper:x collapses');

    // across vocabulary kinds: a Concept into a Topic when the schema allows every link that moves; its own fields stay behind
    const vx = () => {
      const st = fixture();
      st.nodes['topic:zk'] = { labels: ['Topic'], props: { key: 'topic:zk', name: 'zero-knowledge proof', aliases: [] } };
      st.nodes['concept:zkp'].props.external_iri = 'https://example.org/zkp';
      st.rels.push({ type: 'ABOUT', from: 'doi:1', to: 'topic:zk', props: {} });
      st.labels = { 'doi:1': ['Artifact', 'Paper'], 'paper:x': ['Artifact', 'Paper'], 'concept:zkp': ['Concept'], 'topic:zk': ['Topic'], 'ontology:o': ['Artifact', 'Ontology'] };
      return st;
    };
    ({ after, changes } = cops.applyOps(vx(), [{ op: 'merge', keep: 'topic:zk', drop: 'concept:zkp' }], { now }));
    assert.ok(!after.nodes['concept:zkp']);
    assert.ok(rels(after).includes('paper:x ABOUT topic:zk'), 'the link moves to the Topic');
    assert.deepEqual(after.nodes['topic:zk'].props.aliases, ['ZKP', 'zk proofs']);
    assert.ok(!('external_iri' in after.nodes['topic:zk'].props), 'a Concept-only field is not carried to a Topic');
    assert.deepEqual({ from: changes[0].from_kind, to: changes[0].to_kind, not: changes[0].not_copied }, { from: 'Concept', to: 'Topic', not: ['external_iri'] });
    const bound = vx(); bound.rels.push({ type: 'DEFINED_IN', from: 'concept:zkp', to: 'ontology:o', props: {} });
    assert.throws(() => cops.applyOps(bound, [{ op: 'merge', keep: 'topic:zk', drop: 'concept:zkp' }]), (e) => e.status === 400 && /cannot become a Topic: the schema does not allow Topic -DEFINED_IN-> ontology:o/.test(e.message));
    assert.throws(() => cops.applyOps(vx(), [{ op: 'merge', keep: 'topic:zk', drop: 'concept:zkp', take: ['external_iri'] }]), (e) => e.status === 400 && /cannot be carried/.test(e.message));
    ({ after } = cops.applyOps(vx(), [{ op: 'merge', keep: 'concept:zkp', drop: 'topic:zk' }], { now }));
    assert.ok(rels(after).includes('doi:1 ABOUT concept:zkp'), 'and the other way round');

    // unlink, delete (with the concept only it used, its status and its Drive file), rename
    ({ after, changes } = cops.applyOps(fixture(), [{ op: 'unlink', from: 'paper:x', rel: 'about', to: 'concept:zkp' }]));
    assert.ok(!rels(after).includes('paper:x ABOUT concept:zkp')); assert.equal(changes[0].removed, 1);
    refused([{ op: 'unlink', from: 'paper:x', rel: 'LIKES', to: 'concept:zk' }], 400, /Unknown relation/);
    refused([{ op: 'unlink', from: 'doi:1', rel: 'CITES', to: 'paper:x' }], 404, /No CITES link/);
    ({ after, changes, trash } = cops.applyOps(fixture(), [{ op: 'delete', key: 'paper:x' }]));
    assert.ok(!after.nodes['paper:x'] && !after.nodes['personal:paper:x'] && !after.nodes['concept:zkp'] && after.nodes['concept:zk']);
    assert.deepEqual(changes[0].orphans, ['concept:zkp']); assert.deepEqual(trash, ['AAAAAAAAAAAA']);
    assert.deepEqual(rels(after), ['doi:1 ABOUT concept:zk']);
    refused([{ op: 'delete', key: 'personal:paper:x' }], 400, /Only library items and vocabulary/);
    ({ after, changes } = cops.applyOps(fixture(), [{ op: 'rename', key: 'concept:zk', name: 'Zero-knowledge proofs' }]));
    assert.equal(after.nodes['concept:zk'].props.name, 'Zero-knowledge proofs'); assert.deepEqual(after.nodes['concept:zk'].props.aliases, ['zero knowledge']);
    assert.equal(after.nodes['concept:zk'].props.norm, cops.normOf('Concept', 'Zero-knowledge proofs'));
    refused([{ op: 'rename', key: 'doi:1', name: 'x' }], 400, /Only vocabulary/);
    refused([{ op: 'rename', key: 'concept:zk', name: 'zero knowledge' }], 400, /already called/);

    // papers: "topic:" tags become ABOUT links to Topic nodes (the key the matcher found, which keeps its own name)
    const paperType = types.get('paper');
    const tagged = (extra) => paperType.parse({ itemType: 'journalArticle', title: 'Tags', creators: [], date: '2024', tags: ['topic:zk-proofs'], ...extra }).links.filter((l) => l.rel === 'ABOUT');
    assert.deepEqual(tagged({ _topic_keys: { 'zk proofs': 'topic:zero-knowledge-proof' } }), [{ rel: 'ABOUT', merge: { label: 'Topic', key: 'topic:zero-knowledge-proof', props: {} } }]);
    assert.deepEqual(tagged({}), [{ rel: 'ABOUT', merge: { label: 'Topic', key: 'topic:zk-proofs', props: { name: 'zk proofs' } } }], 'without the matcher: a new Topic');

    // fingerprints: any change shows, property order does not
    const f0 = cops.fingerprint(fixture());
    const reordered = fixture(); reordered.nodes['doi:1'].props = Object.fromEntries(Object.entries(reordered.nodes['doi:1'].props).reverse()); reordered.rels.reverse();
    assert.equal(cops.fingerprint(reordered), f0);
    const touched = fixture(); touched.rels[0].props.source = 'x';
    assert.notEqual(cops.fingerprint(touched), f0);
    // Neo4j types survive the JSON round trip
    const dt = new neo4jDriver.types.DateTime(2026, 11, 1, 21, 8, 13, 123000000, 0);
    const back = curation.dec(JSON.parse(JSON.stringify(curation.enc({ n: neo4jDriver.int(2024), d: dt, f: 1.5, l: [neo4jDriver.int(1)] }))));
    assert.ok(neo4jDriver.isInt(back.n) && back.n.toNumber() === 2024 && neo4jDriver.isInt(back.l[0]) && back.f === 1.5);
    assert.ok(neo4jDriver.isDateTime(back.d) && back.d.toString() === dt.toString(), back.d.toString());

    // routes: owner only
    const appC = require('express')();
    require('../features/curation').mount(appC);
    appC.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    const srvC = await new Promise((ok) => { const x = appC.listen(0, '127.0.0.1', () => ok(x)); });
    const cBase = `http://127.0.0.1:${srvC.address().port}`;
    try {
      for (const [m, u] of [['GET', '/api/curation/plans'], ['POST', '/api/curation/plans'], ['GET', '/api/curation/plans/plan:x'], ['POST', '/api/curation/plans/plan:x/apply'],
        ['POST', '/api/curation/plans/plan:x/reject'], ['POST', '/api/curation/plans/plan:x/revert']]) {
        assert.equal((await fetch(cBase + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'POST' ? '{}' : undefined })).status, 401, `${m} ${u} is owner only`);
      }
      const r = await fetch(cBase + '/api/curation/plans', { method: 'POST', headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' }, body: '{"ops":[]}' });
      assert.equal(r.status, 400);
      assert.equal((await fetch(cBase + '/api/curation/plans?status=maybe', { headers: { Authorization: 'Bearer abc' } })).status, 400);
    } finally { await new Promise((ok) => srvC.close(ok)); }
  }

  /* ------------------------------------------------------------ Task 8: frameworks, questions, hypotheses, ontologies */
  {
    const S8 = require('../core/schema');
    const hyps = require('../core/hypotheses');
    // schema: the new types, relation pairs and props, https and iri rules, layout hints
    assert.deepEqual(S8.check(schema), []);
    const bad8 = (mutate) => { const c = JSON.parse(JSON.stringify(schema)); mutate(c); return S8.check(c).join('\n'); };
    assert.match(bad8((c) => { c.relation_types.PART_OF.pairs.Ontology.push('Gadget'); }), /PART_OF.pairs.Ontology: Gadget is not in to/);
    assert.match(bad8((c) => { c.relation_types.PART_OF.pairs.Paper = ['Project']; }), /PART_OF.pairs: Paper is not in from/);
    assert.match(bad8((c) => { c.relation_types.TESTS.props.result.enum = []; }), /TESTS.props.result: enum needs values/);
    assert.match(bad8((c) => { c.relation_types.TESTS.props.score = { type: 'float' }; }), /TESTS.props.score: type must be text, enum or integer/);
    assert.match(bad8((c) => { c.types.ontology.fields.acronym.https = true; }), /acronym: https applies to url fields only/);
    assert.match(bad8((c) => { c.types.ontology.fields.urls.props.role.enum = []; }), /urls.role: enum needs values/);
    assert.match(bad8((c) => { c.types.ontology.fields.urls.props.role.https = true; }), /urls.role: https applies to url parts only/);
    assert.match(bad8((c) => { c.types.ontology.fields.version.normalize = 'iri'; c.types.ontology.fields.version.type = 'date'; }), /version: normalize "iri" applies to text fields only/);
    assert.match(bad8((c) => { c.types.hypothesis.title_from = 'direction'; }), /hypothesis: title_from must name a text field/);
    assert.match(bad8((c) => { c.types.hypothesis.ui_section = 'gadgets'; }), /hypothesis: ui_section must be one of reading, knowledge, inquiry/);
    assert.match(bad8((c) => { delete c.types.paper.ui_section; }), /paper: ui_section must be one of/, 'every collection names its sidebar group');
    assert.match(bad8((c) => { c.ui_sections.push({ id: 'reading', label: 'Again' }); }), /ui_sections: ids must be unique/);
    assert.match(bad8((c) => { c.ui_sections = []; }), /ui_sections: a list of \{id, label\}/);
    assert.match(bad8((c) => { c.types.ontology.fields.parent.rel = 'USED_BY'; }), /ontology.parent: relation_types.USED_BY does not allow Ontology -> Ontology/);
    assert.deepEqual([S8.relTargets('PART_OF', 'Ontology'), S8.relTargets('PART_OF', 'ResearchQuestion'), S8.relTargets('PART_OF', 'Paper')], [['Ontology'], ['Project'], []]);
    assert.equal(S8.relAllows('PART_OF', 'ResearchQuestion', ['Artifact', 'Ontology']), false, 'pairs keep a question out of an ontology');
    assert.ok(S8.relAllows('EXTENDS', 'Paper', ['Method']) && !S8.relAllows('EXTENDS', 'Paper', ['Ontology']) && S8.relAllows('EXTENDS', 'Ontology', ['Ontology']), 'EXTENDS keeps its old combinations and adds ontology to ontology only');
    assert.ok(S8.relAllows('BUILDS_ON', 'Framework', ['Framework']) && !S8.relAllows('BUILDS_ON', 'Paper', ['Framework']));
    const paperRels = S8.relationsFrom('Paper');
    assert.deepEqual(paperRels.find((r) => r.rel === 'TESTS'), { rel: 'TESTS', to: ['Hypothesis'], interpretive: true, props: { result: { type: 'enum', enum: ['supported', 'refuted', 'mixed', 'inconclusive'], required: true } } });
    const pv8 = S8.publicView().collections;
    assert.deepEqual(Object.fromEntries(pv8.map((c) => [c.name, c.ui_section])), { paper: 'reading', method: 'knowledge', use_case: 'knowledge', case_study: 'knowledge', framework: 'knowledge', research_question: 'inquiry', hypothesis: 'inquiry', ontology: 'knowledge' });
    assert.deepEqual(S8.publicView().sections, [{ id: 'reading', label: 'Reading' }, { id: 'knowledge', label: 'Knowledge' }, { id: 'inquiry', label: 'Inquiry' }]);
    assert.equal(pv8.find((c) => c.name === 'hypothesis').title_from, 'statement');
    assert.deepEqual(S8.validate('ontology', { title: 'X', urls: [{ role: 'docs', url: 'http://x.org/d' }] }).errors, ['urls: url: must be an https link'], 'http links are refused for ontologies');
    assert.ok(S8.validate('ontology', { title: 'X', urls: [{ role: 'manual', url: 'https://x.org' }] }).warnings.includes('urls: role: expected one of docs, spec, download, repository, other'));
    assert.deepEqual(S8.validate('ontology', { title: 'X', urls: [{ role: 'spec', url: 'https://x.org' }] }).errors, []);

    // hypothesis status from TESTS results
    const D = hyps.deriveStatus;
    assert.deepEqual([D([]), D(['supported']), D(['refuted', 'refuted']), D(['supported', 'refuted']), D(['supported', 'mixed']), D(['inconclusive']), D(['supported', 'inconclusive']), D(['refuted', 'inconclusive', null])],
      ['untested', 'supported', 'refuted', 'mixed', 'mixed', 'inconclusive', 'supported', 'refuted']);
    assert.ok(hyps.overridden({ status: { by: 'owner' } }, 'supported') && !hyps.overridden({ status: { by: 'owner' } }, null) && !hyps.overridden({ status: { by: 'derived' } }, 'supported'));

    // items: derived titles, defaults, IRIs, relation props
    assert.equal(items.deriveTitle('hypothesis', { statement: '  Adoption   requires both sides ' }).title, 'Adoption requires both sides');
    const longT = items.deriveTitle('research_question', { text: 'word '.repeat(60) }).title;
    assert.ok(longT.length <= 120 && longT.endsWith('…') && !/\s…$/.test(longT), longT);
    assert.equal(items.deriveTitle('hypothesis', { title: 'Own title', statement: 'x' }).title, 'Own title');
    assert.equal(items.deriveTitle('method', { purpose: 'x' }).title, undefined, 'only types with title_from');
    assert.deepEqual([items.normalizeIri(' <HTTPS://Spec.EDMCouncil.org/fibo/ontology/FND/> '), items.normalizeIri('urn:iso:std:20022'), items.normalizeIri(5)], ['https://spec.edmcouncil.org/fibo/ontology/FND/', 'urn:iso:std:20022', 5]);
    assert.equal(items.slugify('x'.repeat(200)).length, 80);
    assert.match(items.relationProps('TESTS', {}).error, /TESTS needs result \(supported, refuted, mixed, inconclusive\)/);
    assert.match(items.relationProps('TESTS', { result: 'proven' }).error, /result must be one of/);
    assert.deepEqual(items.relationProps('TESTS', { result: 'refuted' }), { props: { result: 'refuted' } });
    assert.deepEqual(items.relationProps('ADDRESSES', { result: 'x' }), { props: {} }, 'only the relation\'s own properties');

    // the in-memory graph learns the new queries
    const t8Run = async (q, p) => {
      if (q.includes('OPTIONAL MATCH (:Paper)-[t:TESTS]->(h)')) {
        const hn = G.get(p.key); if (!hn || !hn.labels.includes('Hypothesis')) return [];
        const results = [...G.values()].filter((n) => n.labels.includes('Paper')).flatMap((n) => n.out.filter((e) => e.rel === 'TESTS' && e.to === p.key).map((e) => e.r.result));
        return [{ status: hn.props.status ?? null, p: hn.props.provenance_json ?? null, results }];
      }
      if (q.includes('-[:TESTS]->(h:Hypothesis) RETURN h.key')) return (G.get(p.key) || { out: [] }).out.filter((e) => e.rel === 'TESTS').map((e) => ({ key: e.to }));
      if (q.includes('toLower(trim(n.title)) = toLower(trim($name))')) {
        const lab = q.match(/MATCH \(n:(\w+)\)/)[1]; const nm = String(p.name).trim().toLowerCase();
        const names = (n) => [n.props.title, ...(q.includes('n.acronym') ? [n.props.acronym] : []), ...(q.includes('n.aliases') ? n.props.aliases || [] : [])]; // honour what the query asks
        return [...G.values()].filter((n) => n.labels.includes(lab) && names(n).some((x) => x != null && String(x).trim().toLowerCase() === nm)).slice(0, 2).map((n) => ({ key: n.props.key }));
      }
      return aRun(q, p);
    };
    const t8Tx = async (q, p) => {
      if (q.startsWith('MATCH (h:Hypothesis {key:$key}) SET h.status = $status')) { calls.push([q, p]); const n = G.get(p.key); n.props.status = p.status; n.props.provenance_json = p.prov; return gRecs([]); }
      return aTx(q, p);
    };
    runImpl = t8Run; txImpl = t8Tx; vocab.resolve = stubResolve;
    G.set('doi:10.8/p1', { labels: ['Artifact', 'Paper'], props: { key: 'doi:10.8/p1', title: 'Paper one', collection: 'paper' }, out: [] });
    G.set('doi:10.8/p2', { labels: ['Artifact', 'Paper'], props: { key: 'doi:10.8/p2', title: 'Paper two', collection: 'paper' }, out: [] });
    G.set('project:hub', { labels: ['Artifact', 'Project'], props: { key: 'project:hub', title: 'Hub' }, out: [] });

    // create all four
    const fw = await items.create({ collection: 'framework', fields: { title: 'Two-sided market theory', framework_kind: 'theoretical', aliases: ['two-sided markets'] } });
    const rq = await items.create({ collection: 'research_question', fields: { text: 'Why do stablecoins struggle to replace card payments?', kind: 'explanatory' } });
    const hy = await items.create({ collection: 'hypothesis', fields: { statement: 'Adoption requires simultaneous merchant and consumer growth', direction: 'positive' } });
    const fibo = await items.create({ collection: 'ontology', fields: { title: 'Financial Industry Business Ontology', acronym: 'FIBO', kind: 'ontology', iri: '<HTTPS://Spec.EDMCouncil.org/fibo/ontology/>', publisher: 'EDM Council',
      urls: [{ role: 'docs', url: 'https://spec.edmcouncil.org/fibo/' }] } });
    const fnd = await items.create({ collection: 'ontology', fields: { title: 'FIBO Foundations', kind: 'ontology', parent: 'FIBO' } });
    assert.deepEqual([fw.key, rq.key, hy.key, fibo.key], ['framework:two-sided-market-theory', 'question:why-do-stablecoins-struggle-to-replace-card-payments', 'hypothesis:adoption-requires-simultaneous-merchant-and-consumer-growth', 'ontology:financial-industry-business-ontology']);
    const H = () => G.get(hy.key).props;
    assert.deepEqual([H().status, H().origin, G.get(rq.key).props.origin, G.get(rq.key).props.title], ['untested', 'own', 'own', 'Why do stablecoins struggle to replace card payments?'], 'defaults and a title from the text');
    assert.equal(G.get(fibo.key).props.iri, 'https://spec.edmcouncil.org/fibo/ontology/', 'IRIs are normalised');
    assert.ok(G.get(fibo.key).out.some((e) => e.rel === 'PUBLISHED_BY' && e.to === 'org:edm-council'), 'the publisher is an Organisation');
    assert.ok(G.get(fnd.key).out.some((e) => e.rel === 'PART_OF' && e.to === fibo.key), 'a parent named by its acronym is linked, not created');
    assert.ok((await items.create({ collection: 'ontology', fields: { title: 'Orphan module', parent: 'NOPE' } })).warnings.some((w) => /Ontology "NOPE": not found \(items are linked, never created, from a name\)/.test(w)));
    await assert.rejects(() => items.create({ collection: 'ontology', fields: { title: 'Bad', urls: [{ role: 'docs', url: 'http://insecure.example' }] } }), (e) => e.status === 400 && /https link/.test(e.message));
    await assert.rejects(() => items.create({ collection: 'hypothesis', fields: { direction: 'positive' } }), (e) => e.status === 400 && /title is required/.test(e.message));

    // TESTS results derive the status; a second paper refuting makes it mixed
    await assert.rejects(() => items.link('doi:10.8/p1', { rel: 'TESTS', target: hy.key }), (e) => e.status === 400 && /TESTS needs result/.test(e.message));
    await items.link('doi:10.8/p1', { rel: 'TESTS', target: hy.key, result: 'supported', evidence: 'table 2', location: 'p. 7' });
    assert.equal(H().status, 'supported'); assert.equal(JSON.parse(H().provenance_json).status.by, 'derived');
    assert.equal(G.get('doi:10.8/p1').out.find((e) => e.rel === 'TESTS').r.result, 'supported');
    await items.link('doi:10.8/p2', { rel: 'TESTS', target: hy.key, result: 'refuted', evidence: 'no effect found' });
    assert.equal(H().status, 'mixed', 'supported by one paper, refuted by another');
    const hGot = await items.get(hy.key);
    assert.deepEqual(hGot.links.in.filter((l) => l.rel === 'TESTS').map((l) => [l.key, l.result]).sort(), [['doi:10.8/p1', 'supported'], ['doi:10.8/p2', 'refuted']]);
    await items.unlink('doi:10.8/p2', { rel: 'TESTS', target: hy.key });
    assert.equal(H().status, 'supported', 'removing a test recomputes');
    // the owner's status stands until cleared
    await items.update(hy.key, { status: 'refuted' });
    await items.link('doi:10.8/p2', { rel: 'TESTS', target: hy.key, result: 'supported', evidence: 'x' });
    assert.equal(H().status, 'refuted', 'an owner override is never recomputed');
    await items.update(hy.key, { status: null });
    await hyps.recompute([hy.key]);
    assert.equal(H().status, 'supported', 'clearing it hands it back to the derivation');
    // deleting a paper recomputes what it tested
    await items.remove('doi:10.8/p2');
    await items.link('doi:10.8/p1', { rel: 'TESTS', target: hy.key, result: 'refuted', evidence: 'y' });
    assert.equal(H().status, 'refuted');
    await items.remove('doi:10.8/p1');
    assert.equal(H().status, 'untested', 'the paper and its test are gone');
    // relation endpoints, by pairs
    await assert.rejects(() => items.link(rq.key, { rel: 'PART_OF', target: fibo.key }), (e) => e.status === 400 && /not ResearchQuestion to Ontology/.test(e.message));
    assert.equal((await items.link(rq.key, { rel: 'PART_OF', target: 'project:hub' })).created, true);
    assert.equal((await items.link(hy.key, { rel: 'DERIVED_FROM', target: fw.key })).created, true);
    assert.equal((await items.link(hy.key, { rel: 'ANSWERS', target: rq.key })).created, true);

    // a paper analysis extracts frameworks, questions and tested hypotheses
    G.set('doi:10.8/p3', { labels: ['Artifact', 'Paper'], props: { key: 'doi:10.8/p3', title: 'Paper three', collection: 'paper', schema_version: 1 }, out: [] });
    const ex = await analysis.save({ collection: 'paper', key: 'doi:10.8/p3', model: 'claude-x', extract: {
      frameworks: [{ name: 'two-sided markets' }, { name: 'Path dependence', framework_kind: 'theoretical', evidence: 'the lock-in argument', location: 's. 2' }],
      research_questions: [{ text: 'Why do stablecoins struggle to replace card payments?' }, { text: 'Do merchants accept stablecoins?', kind: 'descriptive' }],
      hypotheses: [{ statement: 'Adoption requires simultaneous merchant and consumer growth', result: 'refuted', evidence: 'adoption grew one-sided', location: 'table 4' },
        { statement: 'Redemption risk reduces trust in stablecoins', direction: 'negative', result: 'supported', evidence: 'survey' },
        { statement: 'No result given', evidence: 'x' }, { statement: 'No passage', result: 'supported' }, { kind: 'no statement' }],
    } });
    const E = ex.extracted;
    assert.deepEqual(E.frameworks.map((x) => [x.key, x.created, x.linked]), [[fw.key, false, true], ['framework:path-dependence', true, true]], 'found by an alias, or created from a full entry');
    assert.deepEqual(E.research_questions.map((x) => [x.key, x.created]), [[rq.key, false], ['question:do-merchants-accept-stablecoins', true]]);
    assert.deepEqual(E.hypotheses.map((x) => [x.key, x.created]), [[hy.key, false], ['hypothesis:redemption-risk-reduces-trust-in-stablecoins', true]]);
    assert.deepEqual(E.skipped.map((x) => x.extract), ['extract.hypotheses[2]', 'extract.hypotheses[3]', 'extract.hypotheses[4]'], 'no result, no passage, no statement: nothing created');
    assert.ok(!G.has('hypothesis:no-result-given') && !G.has('hypothesis:no-passage'));
    assert.equal(G.get('question:do-merchants-accept-stablecoins').props.origin, 'extracted');
    assert.equal(G.get('hypothesis:redemption-risk-reduces-trust-in-stablecoins').props.origin, 'extracted');
    assert.equal(G.get(rq.key).props.origin, 'own', 'an existing own question stays own');
    assert.ok(G.get('question:do-merchants-accept-stablecoins').out.some((e) => e.rel === 'ASKED_IN' && e.to === 'doi:10.8/p3'), 'the question is ASKED_IN the paper');
    const p3 = G.get('doi:10.8/p3').out;
    assert.ok(p3.some((e) => e.rel === 'FRAMED_BY' && e.to === 'framework:path-dependence' && e.r.location === 's. 2'));
    assert.deepEqual(p3.filter((e) => e.rel === 'TESTS').map((e) => [e.to, e.r.result, e.r.by]).sort(), [[hy.key, 'refuted', 'claude'], ['hypothesis:redemption-risk-reduces-trust-in-stablecoins', 'supported', 'claude']]);
    assert.deepEqual([H().status, G.get('hypothesis:redemption-risk-reduces-trust-in-stablecoins').props.status], ['refuted', 'supported'], 'statuses derived from the new tests');
    assert.ok(ex.flagged.some((f) => f.rel === 'TESTS' && f.target === 'hypothesis:redemption-risk-reduces-trust-in-stablecoins'), 'a test without a location is flagged');
    const again = await analysis.save({ collection: 'paper', key: 'doi:10.8/p3', model: 'claude-x', extract: { hypotheses: [{ statement: 'Adoption requires simultaneous merchant and consumer growth', result: 'refuted', evidence: 'e' }] } });
    assert.equal(again.extracted.hypotheses[0].created, false); assert.match(again.extracted.skipped[0].reason, /already linked/);
    for (const [badBody, re] of [[{ collection: 'method', key: 'method:x', model: 'm', extract: {} }, /extract is for paper analyses/], [{ collection: 'paper', key: 'doi:10.8/p3', model: 'm', extract: { claims: [] } }, /extract.claims is not one of/],
      [{ collection: 'paper', key: 'doi:10.8/p3', model: 'm', extract: { hypotheses: {} } }, /extract.hypotheses must be a list/], [{ collection: 'paper', key: 'doi:10.8/p3', model: 'm', extract: { frameworks: Array(51).fill({}) } }, /at most 50/]]) {
      await assert.rejects(() => analysis.save(badBody), (e) => e.status === 400 && re.test(e.message), JSON.stringify(badBody).slice(0, 80));
    }
    const viaLinks = await analysis.save({ collection: 'paper', key: 'doi:10.8/p3', model: 'claude-x', links: [{ rel: 'TESTS', target: 'hypothesis:redemption-risk-reduces-trust-in-stablecoins', evidence: 'e' }] });
    assert.match(viaLinks.links_skipped[0].reason, /TESTS needs result/, 'a TESTS link in links needs its result too');
    await items.create({ collection: 'framework', fields: { title: 'Dup A', aliases: ['dup'] } });
    await items.create({ collection: 'framework', fields: { title: 'Dup B', aliases: ['dup'] } });
    const amb = await analysis.save({ collection: 'paper', key: 'doi:10.8/p3', model: 'claude-x', extract: { frameworks: [{ name: 'dup' }] } });
    assert.deepEqual([amb.extracted.frameworks, amb.extracted.skipped[0].reason], [[], '"dup" matches more than one framework'], 'an ambiguous name is not guessed');
    const newQ = await analysis.save({ collection: 'research_question', model: 'claude-x', fields: { text: 'Is interchange the main switching cost?', kind: 'explanatory' } });
    assert.deepEqual([newQ.key, newQ.created], ['question:is-interchange-the-main-switching-cost', true], 'a question analysed on its own takes its title from its text');

    // the Library sidebar: the schema's sections in order, each with its collections in schema order
    const M8 = await import('data:text/javascript,' + encodeURIComponent(fs.readFileSync(path.join(__dirname, '..', 'apps', 'library', 'model.js'), 'utf8')));
    const side = M8.sidebarGroups(pv8, S8.publicView().sections);
    assert.deepEqual(side.map((g) => [g.label, g.items.map((i) => i.id)]), [['Reading', ['paper']], ['Knowledge', ['method', 'use_case', 'case_study', 'framework', 'ontology']], ['Inquiry', ['research_question', 'hypothesis']]]);
    assert.deepEqual(side[2].items.map((i) => i.label), ['Research questions', 'Hypotheses']);
    const side2 = M8.sidebarGroups([...pv8, { name: 'book', plural: 'Books', ui_section: 'reading' }, { name: 'gadget', plural: 'Gadgets', ui_section: 'nowhere' }], S8.publicView().sections);
    assert.deepEqual([side2[0].items.map((i) => i.id), side2.at(-1).label, side2.at(-1).items.map((i) => i.id)], [['paper', 'book'], 'Other', ['gadget']], 'a new type lands in its group; an unknown group goes to Other');
    assert.deepEqual(M8.sidebarGroups(pv8, []).map((g) => g.label), ['Other'], 'no sections: everything is still listed');
    assert.deepEqual(M8.collectionCounts([{ labels: ['Artifact', 'Method'] }, { labels: ['Artifact', 'Method'] }, { labels: ['Artifact', 'Paper'] }, { labels: ['Concept'] }], pv8.filter((c) => ['paper', 'method', 'ontology'].includes(c.name)), [{}, {}, {}]),
      { paper: 3, method: 2, ontology: 0 }, 'counts per collection; papers from their own list');
    // the graph filter: sidebar groups, then Vocabulary, then other types; large vocabularies off by default
    const pubLabels = S8.publicView().labels;
    const fg = M8.graphFilterGroups(pubLabels, pv8, S8.publicView().sections, S8.publicView().entities.map((e) => e.label));
    assert.deepEqual(fg.map((g) => [g.id, g.items.map((l) => l.label)]), [['reading', ['Paper']], ['knowledge', ['Method', 'UseCase', 'CaseStudy', 'Framework', 'Ontology']], ['inquiry', ['ResearchQuestion', 'Hypothesis']],
      ['vocabulary', ['Person', 'Concept', 'Topic', 'Domain', 'Venue', 'Organisation', 'Dataset']], ['other', ['Note', 'Project']]]);
    assert.deepEqual(M8.GRAPH_OFF_BY_DEFAULT, ['Concept', 'Person', 'Organisation', 'Venue']);
    assert.ok(M8.GRAPH_OFF_BY_DEFAULT.every((l) => pubLabels.some((x) => x.label === l)), 'every default-off type exists');
    // Connections: an item's links grouped by the other node's type (sidebar order, then vocabulary), read from here
    const ctxC = { collections: pv8, sections: S8.publicView().sections, labels: pubLabels, entityLabels: S8.publicView().entities.map((e) => e.label) };
    const hItem = { key: 'hypothesis:h', links: {
      out: [{ rel: 'ANSWERS', key: 'question:q', name: 'Q', labels: ['ResearchQuestion'] }, { rel: 'ABOUT', key: 'topic:t', name: 'CBDC', labels: ['Topic'], field: 'topics' }],
      in: [{ rel: 'TESTS', key: 'doi:1', name: 'P1', labels: ['Paper'], result: 'refuted', evidence: 'e', location: 'p. 3' },
        { rel: 'TESTS', key: 'doi:2', name: 'P2', labels: ['Paper'], result: 'supported', by: 'claude', confidence: 'low', status: 'auto' },
        { rel: 'AUTHORED_BY', key: 'person:x', name: 'X', labels: ['Person'] }] } };
    const cg = M8.connectionGroups(hItem, ctxC);
    assert.deepEqual(cg.map((g) => [g.id, g.label, g.rows.map((r) => [r.role, r.tone, r.suggested])]), [
      ['Paper', 'Papers', [['Tested by: refuted', 'disagree', false], ['Tested by: supported', 'agree', true]]],
      ['ResearchQuestion', 'Research questions', [['Answers', 'neutral', false]]],
      ['Topic', 'Topics', [['About', 'neutral', false]]]], 'grouped, ordered, bibliographic links left out, an unsure Claude link is a suggestion');
    assert.deepEqual([cg[0].rows[0].source, cg[0].rows[0].target, cg[0].rows[0].note, cg[2].rows[0].field], ['doi:1', 'hypothesis:h', 'e', 'topics'], 'source and target for unlinking');
    assert.deepEqual([{ by: 'claude', status: 'auto', confidence: 'high' }, { by: 'claude', status: 'reviewed', confidence: 'low' }, { by: 'owner', confidence: 'low' }].map(M8.isSuggestion), [false, false, false],
      'only unreviewed, unsure Claude links are suggestions');
    const hyp = pv8.find((c) => c.name === 'hypothesis'), paperC = pv8.find((c) => c.name === 'paper');
    const fromHyp = M8.linkOptions(hyp, ['Artifact', 'Paper'], pv8);
    assert.deepEqual(fromHyp.filter((o) => o.rel === 'TESTS').map((o) => [o.dir, o.label, o.props.result]), [['in', 'Tested by: supported', 'supported'], ['in', 'Tested by: refuted', 'refuted'], ['in', 'Tested by: mixed', 'mixed'], ['in', 'Tested by: inconclusive', 'inconclusive']],
      'a paper tests a hypothesis: offered from the hypothesis, one option per result');
    assert.ok(M8.linkOptions(paperC, ['Artifact', 'Hypothesis'], pv8).some((o) => o.dir === 'out' && o.rel === 'TESTS'), 'and from the paper');
    assert.ok(!M8.linkOptions(paperC, ['Person'], pv8).some((o) => o.rel === 'AUTHORED_BY'), 'authors stay in the bibliographic fields');
    assert.deepEqual(M8.linkOptions(hyp, ['Venue'], pv8), [], 'nothing the schema does not allow');
    const kinds = M8.linkableLabels(hyp, pv8);
    assert.ok(kinds.includes('Paper') && kinds.includes('ResearchQuestion') && kinds.includes('Framework') && !kinds.includes('Venue'), kinds.join(','));
    // list entries are plain text: linked names joined, enum words, a count for tables
    assert.deepEqual([M8.plainValue({ type: 'ref', list: true }, [{ key: 'topic:a', name: 'CBDC' }, { name: 'Privacy' }]), M8.plainValue({ type: 'enum' }, 'partly_answered'),
      M8.plainValue({ type: 'object', list: true, label: 'Outcomes' }, [{}, {}]), M8.plainValue({ type: 'text' }, null), M8.plainValue({ type: 'integer' }, 0)],
    ['CBDC, Privacy', 'partly answered', '2 outcomes', '', '0']);
    const hf = pv8.find((c) => c.name === 'hypothesis').fields;
    assert.deepEqual(M8.createFields(hf, { statement: 'S', status: 'untested', origin: 'own', direction: null, title: null }), { statement: 'S' }, 'hub-managed defaults are not sent as owner values');
    assert.deepEqual(M8.createFields(hf, { statement: 'S', status: 'refuted', origin: 'extracted' }), { statement: 'S', status: 'refuted', origin: 'extracted' }, 'a changed one is the owner\'s choice');

    // migration 011
    const m011 = require('../migrations/011_frameworks_questions_ontologies');
    const m11 = []; let ft11 = { labelsOrTypes: S8.typeLabels, properties: ['title', 'tldr', 'abstract', 'summary', 'authors', 'venue', 'body'] };
    const db11 = { run: async (q, p) => { m11.push(q); return q.startsWith('SHOW FULLTEXT') ? (ft11 ? [ft11] : []) : []; } };
    await m011.up(db11);
    assert.ok(m11.some((q) => q === 'DROP INDEX artifact_text IF EXISTS') && m11.some((q) => q.includes('ON EACH [n.title, n.tldr, n.abstract, n.summary, n.authors, n.venue, n.body, n.text, n.statement, n.acronym]') && q.includes('Hypothesis')), 'rebuilt with the new text fields');
    assert.ok(m11.some((q) => q.includes('CREATE INDEX hypothesis_status IF NOT EXISTS')));
    m11.length = 0; ft11 = { labelsOrTypes: S8.typeLabels, properties: m011.FULLTEXT_PROPS };
    await m011.up(db11);
    assert.ok(!m11.some((q) => /DROP INDEX|CREATE FULLTEXT/.test(q)), 'an up-to-date index is left alone');

    vocab.resolve = realResolve; runImpl = async () => []; txImpl = null;

    // a concept points at a term in an ontology (external_iri and DEFINED_IN); nothing is imported
    const appV = require('express')();
    require('../features/vocab').mount(appV);
    appV.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    const srvV = await new Promise((ok) => { const x = appV.listen(0, '127.0.0.1', () => ok(x)); });
    const vBase = `http://127.0.0.1:${srvV.address().port}`;
    const VH = { Authorization: 'Bearer abc', 'Content-Type': 'application/json' };
    const vtx8 = [];
    txImpl = async (q, p) => {
      vtx8.push([q, p]);
      if (q.startsWith('MATCH (c:Concept {key:$key}) RETURN c.external_iri')) return gRecs(p.key === 'concept:missing' ? [] : [{ iri: 'https://old' }]);
      if (q.includes('MATCH (o:Ontology {key:$o})')) return gRecs(p.o === 'ontology:fibo' ? [{ k: p.o }] : []);
      return gRecs([]);
    };
    const patch = (key, body) => fetch(`${vBase}/api/vocab?key=${encodeURIComponent(key)}`, { method: 'PATCH', headers: VH, body: JSON.stringify(body) });
    try {
      assert.equal((await fetch(`${vBase}/api/vocab?key=concept:x`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
      assert.equal((await patch('topic:x', { external_iri: 'https://x' })).status, 400, 'only concepts');
      assert.equal((await patch('concept:x', { external_iri: 'not an iri' })).status, 400);
      assert.equal((await patch('concept:x', {})).status, 400);
      assert.equal((await patch('concept:missing', { external_iri: 'https://x' })).status, 404);
      vtx8.length = 0;
      const okV = await (await patch('concept:legal-entity', { external_iri: 'https://spec.edmcouncil.org/fibo/ontology/BE/LegalEntities/LegalPersons/LegalEntity', defined_in: 'ontology:fibo' })).json();
      assert.deepEqual(okV, { key: 'concept:legal-entity', external_iri: 'https://spec.edmcouncil.org/fibo/ontology/BE/LegalEntities/LegalPersons/LegalEntity', defined_in: 'ontology:fibo' });
      const merge = vtx8.find(([q]) => q.includes('MERGE (c)-[r:DEFINED_IN]->(o)'));
      assert.equal(merge[1].iri, okV.external_iri, 'the link carries the IRI too');
      assert.ok(vtx8.some(([q]) => q.startsWith('MATCH (:Concept {key:$key})-[r:DEFINED_IN]->() DELETE r')), 'one DEFINED_IN at a time');
      assert.equal((await patch('concept:legal-entity', { defined_in: 'ontology:nope' })).status, 404);
      vtx8.length = 0;
      assert.deepEqual(await (await patch('concept:legal-entity', { external_iri: null })).json(), { key: 'concept:legal-entity', external_iri: null });
      assert.ok(vtx8.some(([q]) => q.includes('-[r:DEFINED_IN]->() SET r.external_iri = $iri')), 'clearing the IRI clears it on the link');
    } finally { srvV.close(); txImpl = null; }

    // MCP get_schema tells Claude about extract and TESTS results
    const mcp8 = require('../features/mcp');
    assert.ok(typeof mcp8.toolError === 'function');
    const mcpSrc = fs.readFileSync(path.join(__dirname, '..', 'features', 'mcp', 'index.js'), 'utf8');
    assert.ok(mcpSrc.includes("rules: collection === 'paper' ? [...ANALYSIS_RULES, PAPER_EXTRACT] : ANALYSIS_RULES") && mcpSrc.includes('extract: z.object('));
  }

  /* ------------------------------------------------------------ Task 8b: uploads beyond PDFs, ontology snapshots */
  {
    const crypto = require('crypto');
    const net8 = []; let snapN = 0;
    const J8 = (obj, status = 200, headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => obj, clone() { return this; } });
    drive._reset();
    drive.setHttp(async (url, opts = {}) => {
      net8.push([opts.method || 'GET', url, opts]);
      if (url.startsWith('https://oauth2.googleapis.com/token')) return J8({ access_token: 'AT', expires_in: 3600 });
      if (url.includes('/drive/v3/files?q=')) return J8({ files: [{ id: 'FOLDER1' }] });
      if (url.includes('uploadType=resumable')) { snapN++; return J8({}, 200, { location: `https://upload.example/snap${snapN}` }); }
      if (url.startsWith('https://upload.example/snap')) return J8({ id: 'SNAP' + url.split('snap')[1] });
      if (url.includes('/permissions')) return J8({ id: 'perm' });
      if (url.includes('/drive/v3/files/') && opts.method === 'PATCH') return J8({});
      throw new Error('unexpected request ' + url);
    });
    // the type allow-list and the size cap
    await assert.rejects(() => drive.upload('x', Buffer.from('MZ'), { ext: 'exe' }), (e) => e.status === 400 && /Only these file types/.test(e.message));
    await assert.rejects(() => drive.upload('x', Buffer.alloc(0), { ext: 'ttl' }), (e) => e.status === 400);
    const ttl = await drive.upload('FIBO 2024Q4', Buffer.from('@prefix fibo: <https://spec.edmcouncil.org/fibo/> .'), { ext: 'ttl' });
    const start8 = net8.find((c) => c[1].includes('uploadType=resumable'));
    assert.deepEqual([JSON.parse(start8[2].body).name, JSON.parse(start8[2].body).mimeType, start8[2].headers['X-Upload-Content-Type'], ttl.mime], ['FIBO 2024Q4.ttl', 'text/turtle', 'text/turtle', 'text/turtle']);
    assert.equal(net8.find((c) => c[1].startsWith('https://upload.example/'))[2].headers['Content-Type'], 'text/turtle');
    process.env.MAX_UPLOAD_MB = '0.00002'; // about 20 bytes
    await assert.rejects(() => drive.upload('big', Buffer.alloc(100, 1), { ext: 'zip' }), (e) => e.status === 413 && /upload limit \(MAX_UPLOAD_MB\)\. Store a link/.test(e.message));
    delete process.env.MAX_UPLOAD_MB;
    assert.deepEqual(Object.keys(drive.FILE_TYPES).sort(), ['csv', 'json', 'jsonld', 'owl', 'pdf', 'rdf', 'ttl', 'txt', 'xml', 'xsd', 'zip']);

    // snapshots over HTTP, against the in-memory graph
    runImpl = aRun; txImpl = aTx;
    G.set('ontology:fibo', { labels: ['Artifact', 'Ontology'], props: { key: 'ontology:fibo', title: 'FIBO', collection: 'ontology', version: '2024Q4' }, out: [] });
    G.set('method:not-onto', { labels: ['Artifact', 'Method'], props: { key: 'method:not-onto', title: 'M', collection: 'method' }, out: [] });
    const appO = require('express')();
    require('../features/ontologies').mount(appO);
    appO.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    const srvO = await new Promise((ok) => { const x = appO.listen(0, '127.0.0.1', () => ok(x)); });
    const oBase = `http://127.0.0.1:${srvO.address().port}`;
    const OH = { Authorization: 'Bearer abc' };
    const post = (key, name, body, type = 'application/octet-stream') => fetch(`${oBase}/api/ontologies/snapshot?key=${encodeURIComponent(key)}${name ? '&name=' + encodeURIComponent(name) : ''}`, { method: 'POST', headers: { ...OH, 'Content-Type': type }, body });
    const fileBody = Buffer.from('<rdf:RDF>fibo</rdf:RDF>');
    try {
      assert.equal((await fetch(`${oBase}/api/ontologies/snapshot?key=ontology:fibo`, { method: 'POST' })).status, 401);
      net8.length = 0;
      const r1 = await post('ontology:fibo', 'fibo.rdf', fileBody);
      assert.equal(r1.status, 201);
      const s1 = (await r1.json()).snapshot;
      assert.deepEqual({ ...s1, retrieved_at: 0 }, { file_url: 'https://drive.google.com/file/d/SNAP2/view', drive_file_id: 'SNAP2', retrieved_at: 0, version: '2024Q4',
        sha256: crypto.createHash('sha256').update(fileBody).digest('hex'), size_bytes: fileBody.length, mime: 'application/rdf+xml' });
      assert.ok(!Number.isNaN(Date.parse(s1.retrieved_at)));
      const oNode = G.get('ontology:fibo').props;
      assert.deepEqual(JSON.parse(oNode.snapshot_json), s1); assert.equal(oNode.snapshot__sha256, s1.sha256, 'the checksum is queryable');
      assert.equal(JSON.parse(oNode.provenance_json).snapshot.by, 'owner');
      const r2 = await (await post('ontology:fibo', 'fibo-v2.ttl', Buffer.from('@prefix x: <y> .'))).json();
      assert.equal(r2.replaced_drive_file, 'SNAP2', 'a new snapshot replaces the previous one');
      assert.ok(net8.some((c) => c[0] === 'PATCH' && c[1].includes('/files/SNAP2')), 'and trashes it');
      assert.equal((await post('ontology:fibo', 'fibo.exe', fileBody)).status, 400);
      assert.match((await (await post('ontology:fibo', null, fileBody)).json()).error, /Name the file with one of these extensions/);
      assert.match((await (await post('ontology:fibo', 'x.pdf', fileBody)).json()).error, /File is not a PDF/);
      assert.match((await (await post('method:not-onto', 'x.ttl', fileBody)).json()).error, /is a method, not an ontology/);
      const byUrl = await fetch(`${oBase}/api/ontologies/snapshot?key=ontology:fibo`, { method: 'POST', headers: { ...OH, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://evil.example/fibo.owl' }) });
      assert.equal(byUrl.status, 400); assert.match((await byUrl.json()).error, /url host not allowed .*SNAPSHOT_FETCH_ALLOWED_HOSTS/);
      delete process.env.GOOGLE_REFRESH_TOKEN;
      assert.equal((await post('ontology:fibo', 'fibo.ttl', fileBody)).status, 503, 'Drive not set up: a clear 503');
      process.env.GOOGLE_REFRESH_TOKEN = 'rt';
      const realWrite = items.write; items.write = async () => { throw new Error('db down'); };
      net8.length = 0;
      try { assert.equal((await post('ontology:fibo', 'fibo.ttl', fileBody)).status, 500); } finally { items.write = realWrite; }
      assert.ok(net8.some((c) => c[0] === 'PATCH' && /\/files\/SNAP\d+/.test(c[1])), 'a failed write trashes the upload: no public file the graph does not know');
      // remove, and deleting the ontology trashes its snapshot
      const del = await (await fetch(`${oBase}/api/ontologies/snapshot?key=ontology:fibo`, { method: 'DELETE', headers: OH })).json();
      assert.deepEqual(del, { key: 'ontology:fibo', removed: true, trashed_drive_file: r2.snapshot.drive_file_id });
      assert.equal(G.get('ontology:fibo').props.snapshot_json, undefined);
      assert.equal((await fetch(`${oBase}/api/ontologies/snapshot?key=ontology:fibo`, { method: 'DELETE', headers: OH })).status, 404);
      const r3 = await (await post('ontology:fibo', 'fibo.ttl', fileBody)).json();
      net8.length = 0;
      await items.remove('ontology:fibo');
      assert.ok(net8.some((c) => c[0] === 'PATCH' && c[1].includes('/files/' + r3.snapshot.drive_file_id)), 'deleting the ontology trashes its snapshot');
    } finally { srvO.close(); runImpl = async () => []; txImpl = null; }
  }

  /* ------------------------------------------------------------ deploy: budget guard (soft stop) */
  {
    const bg = require('../../deploy/budget-guard');
    const ev = (o) => ({ data: { message: { data: Buffer.from(JSON.stringify(o)).toString('base64') } } });
    assert.deepEqual(bg.parse(ev({ costAmount: 1.2, budgetAmount: 5 })), { cost: 1.2, budget: 5 });
    assert.equal(bg.parse({ data: { message: { data: 'bm90IGpzb24=' } } }), null);
    assert.deepEqual(bg.parse({ data: Buffer.from('{"costAmount":5,"budgetAmount":5}').toString('base64') }), { cost: 5, budget: 5 }, 'the Pub/Sub message as a plain function receives it');
    assert.equal(bg.parse(ev({ budgetAmount: 5 })), null);
    assert.equal(bg.overBudget({ cost: 4.99, budget: 5 }), false); assert.equal(bg.overBudget({ cost: 5, budget: 5 }), true);
    assert.equal(bg.overBudget({ cost: 1, budget: 0 }), false, 'a zero budget never stops anything');
    const calls = [];
    const http = async (url, o = {}) => { calls.push([o.method || 'GET', url, o.body]); return { ok: true, status: 200, json: async () => ({ access_token: 'T' }) }; };
    const env = { PROJECT: 'p', ZONE: 'us-central1-a', VM: 'neo4j-hub', REGION: 'us-central1', SERVICE: 'research-hub' };
    assert.deepEqual(await bg.guard(ev({ costAmount: 2, budgetAmount: 5 }), { env, http, log() {} }), []);
    assert.equal(calls.length, 0, 'under budget: nothing is touched');
    await bg.guard(ev({ costAmount: 5.3, budgetAmount: 5 }), { env, http, log() {} });
    assert.deepEqual(calls.slice(1).map((c) => c.slice(0, 2)), [
      ['POST', 'https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances/neo4j-hub/stop'],
      ['PATCH', 'https://run.googleapis.com/v2/projects/p/locations/us-central1/services/research-hub?updateMask=ingress']]);
    assert.deepEqual(JSON.parse(calls[2][2]), { ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY' });
    assert.ok(!calls.some((c) => /delete|billingInfo/i.test(c[1])), 'a soft stop: nothing deleted, billing untouched');
    const failing = async (url, o = {}) => (url.includes('run.googleapis') ? { ok: false, status: 403 } : http(url, o));
    await assert.rejects(() => bg.guard(ev({ costAmount: 6, budgetAmount: 5 }), { env, http: failing, log() {} }), /close research-hub to public traffic: 403/);
  }

  /* ------------------------------------------------------------ Task 9: OAuth for MCP, the upload link */
  {
    const oauth = require('../core/oauth');
    const crypto = require('crypto');
    const mem = oauth.memoryStore(); oauth.useStore(mem);
    const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
    // registration: the allow-list
    const reg = oauth.registerClient({ redirect_uris: [CLAUDE], client_name: 'Claude' });
    assert.ok(reg.client_id.startsWith('hub_c.') && reg.token_endpoint_auth_method === 'none');
    assert.equal(oauth.registerClient({ redirect_uris: ['https://evil.example/cb'] }).error, 'invalid_redirect_uri');
    assert.equal(oauth.registerClient({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback/../x'] }).error, 'invalid_redirect_uri');
    assert.ok(oauth.registerClient({ redirect_uris: ['http://127.0.0.1:33418/callback'] }).client_id, 'loopback, any port');
    assert.equal(oauth.registerClient({ redirect_uris: ['http://127.0.0.1:33418/callback#frag'] }).error, 'invalid_redirect_uri', 'no fragments');
    assert.equal(oauth.registerClient({ redirect_uris: [] }).error, 'invalid_redirect_uri');
    assert.equal(oauth.registerClient({ redirect_uris: Array(6).fill(CLAUDE) }).error, 'invalid_redirect_uri');
    assert.deepEqual(oauth.client(reg.client_id), { redirect_uris: [CLAUDE], client_name: 'Claude' });
    const [cp, cm] = reg.client_id.slice(6).split('.');
    const forged = 'hub_c.' + Buffer.from(JSON.stringify({ r: ['https://evil.example/cb'], n: 'x', t: 1 })).toString('base64url') + '.' + cm;
    assert.equal(oauth.client(forged), null, 'a client id cannot be altered'); assert.ok(cp);
    const verifier = crypto.randomBytes(40).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    assert.ok(oauth.pkceOk(verifier, challenge)); assert.ok(!oauth.pkceOk(verifier + 'x', challenge)); assert.ok(!oauth.pkceOk('short', oauth.sha('short')));

    // over HTTP: discovery, the approval page, the token endpoint, /mcp
    const express = require('express');
    const appO = express(); appO.set('trust proxy', 1);
    const oauthF = require('../features/oauth'); const mcpF = require('../features/mcp');
    const r9 = express.Router(); oauthF.mount(r9); mcpF.mount(r9); require('../features/papers').mount(r9); oauthF.mountRoot(appO); appO.use('/', r9);
    appO.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    const srv9 = await new Promise((ok) => { const x = appO.listen(0, '127.0.0.1', () => ok(x)); });
    const B9 = `http://127.0.0.1:${srv9.address().port}`;
    try {
      const prm = await (await fetch(B9 + '/.well-known/oauth-protected-resource/mcp')).json();
      assert.deepEqual([prm.resource, prm.authorization_servers], [B9 + '/mcp', [B9]]);
      const asm = await (await fetch(B9 + '/.well-known/oauth-authorization-server')).json();
      assert.deepEqual([asm.issuer, asm.authorization_endpoint, asm.token_endpoint, asm.registration_endpoint, asm.code_challenge_methods_supported],
        [B9, B9 + '/oauth/authorize', B9 + '/oauth/token', B9 + '/oauth/register', ['S256']]);
      const anon = await fetch(B9 + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(anon.status, 401);
      assert.equal(anon.headers.get('www-authenticate'), `Bearer resource_metadata="${B9}/.well-known/oauth-protected-resource/mcp"`, 'the 401 is how a client discovers OAuth');
      const rr = await fetch(B9 + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CLAUDE], client_name: 'Claude' }) });
      assert.equal(rr.status, 201); const cid = (await rr.json()).client_id;
      assert.equal((await fetch(B9 + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) })).status, 400);

      const az = (q) => fetch(B9 + '/oauth/authorize?' + new URLSearchParams(q), { redirect: 'manual' });
      const good = { response_type: 'code', client_id: cid, redirect_uri: CLAUDE, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', resource: B9 + '/mcp' };
      assert.equal((await az({ ...good, client_id: 'nope' })).status, 400);
      assert.equal((await az({ ...good, redirect_uri: 'https://claude.ai/other' })).status, 400, 'never redirects to an unregistered address');
      assert.equal((await az({ ...good, redirect_uri: 'http://127.0.0.1:9/cb' })).status, 400, 'allowed in general, but not registered by this client');
      const noPkce = await az({ ...good, code_challenge: '' });
      assert.equal(noPkce.status, 302); assert.match(noPkce.headers.get('location'), /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?error=invalid_request.*state=st8/);
      assert.match((await az({ ...good, resource: 'https://other.example/mcp' })).headers.get('location'), /error=invalid_target/);
      const pg = await az(good);
      assert.equal(pg.status, 200);
      assert.match(pg.headers.get('content-security-policy'), /form-action 'self' https:\/\/claude\.ai/, 'the redirect after approval is allowed by the CSP');
      const html = await pg.text();
      assert.match(html, /<strong>Claude<\/strong> wants to use your hub/); assert.ok(!/<script/i.test(html), 'no scripts on the approval page');
      const sealed = html.match(/name="req" value="([^"]+)"/)[1].replace(/&amp;/g, '&');
      const approve = (fields, headers = {}) => fetch(B9 + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields) });
      const wrong = await approve({ req: sealed, decision: 'allow', owner_token: 'nope' });
      assert.equal(wrong.status, 401); assert.match(await wrong.text(), /Wrong token/);
      assert.match((await approve({ req: sealed, decision: 'deny' })).headers.get('location'), /error=access_denied&state=st8/);
      assert.equal((await approve({ req: sealed.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), decision: 'allow', owner_token: 'abc' })).status, 400, 'a tampered request is refused');
      const ok = await approve({ req: sealed, decision: 'allow', owner_token: 'abc' });
      assert.equal(ok.status, 302);
      const back = new URL(ok.headers.get('location'));
      assert.deepEqual([back.origin + back.pathname, back.searchParams.get('state'), back.searchParams.get('iss')], [CLAUDE, 'st8', B9]);
      const code = back.searchParams.get('code');
      // signed in with the session cookie: no token needed
      const cookie = `__session=${encodeURIComponent(require('../core/auth').sign(Date.now() + 60000))}`;
      assert.match(await (await az(good).then(() => fetch(B9 + '/oauth/authorize?' + new URLSearchParams(good), { headers: { Cookie: cookie } }))).text(), /You are signed in as the owner/);
      assert.equal((await approve({ req: sealed, decision: 'allow' }, { Cookie: cookie })).status, 302);

      const tok = (fields) => fetch(B9 + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
      const code2 = new URL((await approve({ req: sealed, decision: 'allow', owner_token: 'abc' })).headers.get('location')).searchParams.get('code');
      const badPkce = await tok({ grant_type: 'authorization_code', code: code2, redirect_uri: CLAUDE, client_id: cid, code_verifier: crypto.randomBytes(40).toString('base64url') });
      assert.deepEqual([badPkce.status, (await badPkce.json()).error], [400, 'invalid_grant']);
      assert.equal((await tok({ grant_type: 'authorization_code', code: code2, redirect_uri: CLAUDE, client_id: cid, code_verifier: verifier })).status, 400, 'a code is tried once, even after a failure');
      assert.equal((await tok({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:1/x', client_id: cid, code_verifier: verifier })).status, 400);
      const code3 = new URL((await approve({ req: sealed, decision: 'allow', owner_token: 'abc' })).headers.get('location')).searchParams.get('code');
      const t1 = await tok({ grant_type: 'authorization_code', code: code3, redirect_uri: CLAUDE, client_id: cid, code_verifier: verifier });
      assert.equal(t1.status, 200); assert.equal(t1.headers.get('cache-control'), 'no-store');
      const T1 = await t1.json();
      assert.deepEqual([T1.token_type, T1.expires_in, T1.scope], ['Bearer', 3600, 'mcp']); assert.ok(T1.access_token.startsWith('hub_at.') && T1.refresh_token.startsWith('hub_rt.'));
      assert.equal((await tok({ grant_type: 'authorization_code', code: code3, redirect_uri: CLAUDE, client_id: cid, code_verifier: verifier })).status, 400, 'code reuse');
      const saved = [...mem.grants.values()][0];
      assert.ok(!JSON.stringify(saved).includes(T1.refresh_token.split('.')[2]), 'only a hash of the refresh token is stored');
      // expired code
      const codeOld = await oauth.issueCode({ client_id: cid, redirect_uri: CLAUDE, code_challenge: challenge });
      for (const v of mem.codes.values()) v.exp = Date.now() - 1;
      assert.equal((await tok({ grant_type: 'authorization_code', code: codeOld, redirect_uri: CLAUDE, client_id: cid, code_verifier: verifier })).status, 400, 'expired code');

      // the access token works on /mcp, and only there
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const mcpWith = async (bearerValue) => { const c = new Client({ name: 't9', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL(B9 + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + bearerValue } } })); return c; };
      const c1 = await mcpWith(T1.access_token);
      assert.ok((await c1.listTools()).tools.some((t) => t.name === 'request_upload'));
      assert.match(c1.getInstructions(), /give it to the owner so they can drop the PDF there/);
      assert.equal((await fetch(B9 + '/api/papers/file?key=x', { method: 'DELETE', headers: { Authorization: 'Bearer ' + T1.access_token } })).status, 401, 'an OAuth token is for /mcp only');
      const c0 = await mcpWith('abc'); assert.ok((await c0.listTools()).tools.length, 'the owner token still works');
      const tampered = T1.access_token.replace(/\.([^.]+)$/, (m, x) => '.' + (x[0] === 'A' ? 'B' : 'A') + x.slice(1));
      assert.equal((await fetch(B9 + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + tampered, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
      const realNow = Date.now;
      try { Date.now = () => realNow() + 3601 * 1000; assert.equal(await oauth.verifyAccess(T1.access_token), false, 'expires after an hour'); } finally { Date.now = realNow; }

      // request_upload and upload_url
      runImpl = async (q, p) => (q.includes('MATCH (p:Paper {key:$key}) RETURN p.file_url') ? (p.key === 'doi:10.1/none' ? [{ file: null }] : p.key === 'doi:10.1/has' ? [{ file: 'https://x/y.pdf' }] : []) : []);
      const ru = await c1.callTool({ name: 'request_upload', arguments: { key: 'doi:10.1/none' } });
      assert.deepEqual(JSON.parse(ru.content[0].text), { key: 'doi:10.1/none', upload_url: `${B9}/library/papers?key=doi%3A10.1%2Fnone&upload=1`, has_file: false });
      assert.match(JSON.parse((await c1.callTool({ name: 'request_upload', arguments: { key: 'doi:10.1/has' } })).content[0].text).note, /replaces it/);
      assert.ok((await c1.callTool({ name: 'request_upload', arguments: { key: 'doi:10.1/missing' } })).isError);
      const up = (k) => `https://hub.example/library/papers?key=${k}&upload=1`;
      const wu = await mcpF.withUpload({ key: 'doi:10.1/none', created: true }, up);
      assert.deepEqual([wu.upload_url, /attached the PDF in the chat/.test(wu.upload_hint), wu.created], [up('doi:10.1/none'), true, true], 'a paper saved without a file gets the upload link');
      assert.deepEqual(await mcpF.withUpload({ key: 'doi:10.1/has' }, up), { key: 'doi:10.1/has' }, 'not when it has a file');
      runImpl = async () => [];

      // refresh: rotated; reusing the old one revokes the connection
      const t2 = await (await tok({ grant_type: 'refresh_token', refresh_token: T1.refresh_token, client_id: cid })).json();
      assert.ok(t2.access_token && t2.refresh_token !== T1.refresh_token);
      assert.ok(await oauth.verifyAccess(t2.access_token));
      const reuse = await (await tok({ grant_type: 'refresh_token', refresh_token: T1.refresh_token, client_id: cid })).json();
      assert.match(reuse.error_description, /reused: the connection was revoked/);
      assert.equal(await oauth.verifyAccess(t2.access_token), false, 'revoked at once');
      assert.equal((await tok({ grant_type: 'password' })).status, 400);

      // listing and revoking connections (owner only)
      const code4 = new URL((await approve({ req: sealed, decision: 'allow', owner_token: 'abc' })).headers.get('location')).searchParams.get('code');
      const T4 = await (await tok({ grant_type: 'authorization_code', code: code4, redirect_uri: CLAUDE, client_id: cid, code_verifier: verifier })).json();
      const OH9 = { Authorization: 'Bearer abc' };
      assert.equal((await fetch(B9 + '/api/oauth/grants', { headers: { Authorization: 'Bearer ' + T4.access_token } })).status, 401);
      const conns = (await (await fetch(B9 + '/api/oauth/grants', { headers: OH9 })).json()).connections;
      assert.deepEqual(conns.map((x) => x.client_name), ['Claude']);
      assert.deepEqual(await (await fetch(B9 + '/api/oauth/grants?id=' + conns[0].id, { method: 'DELETE', headers: OH9 })).json(), { revoked: 1 });
      assert.equal(await oauth.verifyAccess(T4.access_token), false);
      assert.equal((await fetch(B9 + '/api/oauth/grants?id=nope', { method: 'DELETE', headers: OH9 })).status, 404);
      // a new owner token invalidates every client id and token
      process.env.HUB_API_TOKEN = 'rotated-token';
      assert.equal(oauth.client(cid), null);
      process.env.HUB_API_TOKEN = 'abc';
      assert.ok(oauth.client(cid));
    } finally { srv9.close(); oauth.useStore(null); runImpl = async () => []; }
  }

  /* ------------------------------------------------------------ search query building */
  assert.equal(q.luceneQuery('Blind sig+nature'), 'blind* AND sig* AND nature*');
  assert.equal(q.luceneQuery('  '), ''); assert.ok(!/["\\()]/.test(q.luceneQuery('a" (b) \\c')));
  // Neo4j 5 rejects a pattern comprehension over a lone node, e.g. [(s:Personal {...}) | s.status]; it needs a relationship.
  assert.ok(!/\[\s*\([^()]*\)\s*\|/.test(q.SEARCH_RETURN), 'pattern comprehensions in search include a relationship');
  assert.ok(q.SEARCH_RETURN.includes('(s:Personal)-[:FOR]->(p)'), 'status comes from the personal layer via FOR');
  let searchCall;
  runImpl = async (cy, p) => { searchCall = [cy, p]; return []; };
  await q.searchPapers('Digital-Cash');
  assert.equal(searchCall[1].topic, 'digital cash', 'a tag-style query matches concept names, which use spaces');
  assert.ok(searchCall[0].includes('toLower(c.name) CONTAINS $topic'));
  runImpl = async () => [];

  console.log('all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
