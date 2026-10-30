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
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { run: (q, p) => runImpl(q, p), exec: async () => [], writeTx: async (fn) => fn(fakeTx), driver: {} } };

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
  assert.deepEqual(migrate.available().map((m) => m.id), ['001_constraints', '002_papers_owned_by_hub', '003_files_are_links', '004_fulltext_search', 'personal_001_layer']);
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
  const tm = notes.toItem({ path: 'methods/snow.md', meta: {}, body: '' }).item;
  assert.equal(tm.key, 'method:snow'); assert.equal(tm.props.title, 'snow'); assert.equal(tm.props.level, null, 'fields removed from front matter are removed from the node'); assert.equal(tm.props.body, null);
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
    { path: 'methods/b.md', meta: {}, body: 'b' },
    { path: 'notes/a.md', meta: {}, body: 'dup' }, { path: 'bad/c.md', meta: {} },
  ]);
  assert.equal(res.upserted, 2); assert.equal(res.created, 2); assert.deepEqual(res.removed, ['note:gone']); assert.equal(res.edges, 2);
  assert.equal(res.skipped.length, 2); assert.ok(res.warnings.some((w) => /note:a ANNOTATES -> doi:10.9\/missing: target not found/.test(w)));
  const stm = txLog.map(([q]) => q).join('\n');
  assert.ok(stm.includes('SET n:Note') && stm.includes('SET n:Method') && stm.includes("n.source = 'markdown'") && stm.includes('MERGE (a)-[x:USES]->(b)') && !stm.includes('x:ANNOTATES'), 'one batched statement per label and relation, missing targets skipped');
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

  /* ------------------------------------------------------------ search query building */
  assert.equal(q.luceneQuery('Blind sig+nature'), 'blind* AND sig* AND nature*');
  assert.equal(q.luceneQuery('  '), ''); assert.ok(!/["\\()]/.test(q.luceneQuery('a" (b) \\c')));

  console.log('all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
