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
  assert.deepEqual(migrate.available().map((m) => m.id), ['001_constraints', '002_papers_owned_by_hub', '003_files_are_links', '004_fulltext_search', '005_collections', '006_vocab_matching', '007_items_json_fields', '008_vocab_letters_plain', 'personal_001_layer']);
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
  assert.deepEqual(up, { id: 'FILE1', url: 'https://drive.google.com/file/d/FILE1/view' });
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
  assert.deepEqual(Object.keys(schema.types).filter((t) => schema.types[t].collection).sort(), ['case_study', 'method', 'paper', 'use_case']);
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
  assert.deepEqual(ucWrite[1].onCreate, { record_status: 'auto' }); assert.ok(ucWrite[0].includes('ON CREATE SET n.created_at = datetime(), n += $onCreate'), 'record_status is only set on create');
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
  assert.ok(mq.includes('DROP INDEX artifact_text') && /FOR \(n:Paper\|Method\|UseCase\|CaseStudy\|Note\|Project\) ON EACH \[n\.title, n\.tldr/.test(mq), 'full-text index rebuilt over every type');
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
      for (const x of p.rows) { if (!G.has(x.key) || !G.get(x.key).labels.includes(mk[1])) continue; n.out = n.out.filter((e) => !(e.rel === mk[2] && e.to === x.key)); n.out.push({ rel: mk[2], to: x.key, r: { field: p.field, position: x.position, source: 'items', by: p.by, at: p.at } }); ok.push({ key: x.key }); }
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
  assert.deepEqual([mNode.props.collection, mNode.props.managed, mNode.props.record_status], ['method', 'db', 'auto']);
  assert.deepEqual(JSON.parse(mNode.props.provenance_json).kind, { by: 'owner', at: JSON.parse(mNode.props.provenance_json).kind.at, status: 'reviewed' });
  assert.deepEqual(mNode.out.find((e) => e.rel === 'ABOUT').r, { field: 'domain', position: 0, source: 'items', by: 'owner', at: mNode.out[0].r.at });
  assert.equal(resolved.at(-1)[2].by, 'owner', 'vocabulary created by an owner write is flagged by=owner');
  const mGot = await items.get('method:snowball-sampling');
  assert.deepEqual(mGot.fields.domain, [{ key: 'domain:research-methodology', name: 'Research methodology' }]);
  assert.deepEqual([mGot.fields.kind, mGot.fields.purpose, mGot.extra, mGot.record_status, mGot.collection], ['technique', null, { mood: 'kept' }, 'auto', 'method']);
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
