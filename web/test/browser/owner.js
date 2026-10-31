// Browser check (see README.md here). playwright-core is not a project dependency: install it outside the repo and set NODE_PATH.
const { chromium } = require('playwright-core');
const fs = require('fs');
const U = process.env.HUB_URL || 'http://127.0.0.1:18082', TOK = process.env.HUB_API_TOKEN, OUT = process.env.OUT || require('os').tmpdir();
const results = []; const problems = [];
const step = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); } };
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
// the hub's CSP forbids eval, which page.waitForFunction needs: poll from Node instead
const until = async (check, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await check()) return; if (Date.now() > end) throw new Error('timed out: ' + check.toString().slice(0, 120)); await new Promise((r) => setTimeout(r, 150)); } };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(U, '')}`); });
  const api = (path, opts = {}) => page.evaluate(async ([p, o, t]) => (await fetch(p, { ...o, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' } })).json(), [U + path, opts, TOK]);

  await step('sign in through the UI', async () => {
    await page.goto(U + '/library');
    await page.click('button:has-text("Sign in")');
    await page.fill('input[type=password]', TOK);
    await page.click('form.modal button[type=submit]');
    await page.waitForSelector('.badge.ok:has-text("Owner")');
  });
  await step('collections bar from the schema', async () => {
    await page.waitForSelector('.collbar');
    const labels = await page.$$eval('.collbar button', (b) => b.map((x) => x.textContent.trim()));
    expect(JSON.stringify(labels) === JSON.stringify(['All', 'Papers', 'Methods', 'Use cases', 'Case studies', 'Graph', 'Audit']), labels.join('|'));
    expect(new URL(page.url()).pathname === '/library', page.url());
  });
  await step('papers list and Analysis tab with provenance, tiers and flags', async () => {
    await page.click('.item:has-text("Blind Signatures")');
    await page.waitForSelector('.tab[data-tab=analysis]');
    expect(page.url().includes('key=doi'), page.url());
    await page.click('.tab[data-tab=analysis]');
    await page.waitForSelector('.analysis .fieldgroup');
    const groups = await page.$$eval('.analysis .fieldgroup > .label', (e) => e.map((x) => x.textContent));
    expect(groups.includes('Bibliographic') && groups.includes('Content') && groups.includes('Classification'), groups.join('|'));
    expect(await page.$('.analysis [data-field=main_claim] .prov.prov-claude.low'), 'low-confidence Claude marker on main_claim');
    expect(await page.$('.analysis [data-field=year] .prov.prov-source'), 'source marker on year');
    expect(await page.$('.analysis [data-field=key_findings] .flag'), 'ungrounded flag');
    expect((await page.$$('.analysis [data-field=key_findings] tr.flagged')).length === 1, 'one flagged finding row');
    expect(await page.$('.analysis [data-field=research_problem] .tier.tier-core'), 'tier badge');
    expect(await page.$('.analysis .empties'), 'empty fields listed');
    await page.screenshot({ path: OUT + '/1-analysis.png', fullPage: false });
  });
  await step('paper Info tab still has status and file link', async () => {
    await page.click('.tab[data-tab=info]');
    expect(await page.$('select[aria-label="Your status"]'), 'status select');
    expect(await page.$('input[aria-label="File link"]'), 'file link editor');
  });
  await step('methods: list with columns and filter by kind', async () => {
    await page.click('.collbar button[data-section=method]');
    await page.waitForURL(/\/library\/methods/);
    await page.waitForSelector('.list .item');
    expect((await page.$$('.list .item')).length === 2, 'two methods');
    await page.selectOption('select[aria-label=Kind]', 'tool');
    await page.waitForSelector('.list .empty');
    await page.selectOption('select[aria-label=Kind]', 'technique');
    await until(async () => (await page.$$('.list .item')).length === 2);
  });
  await step('create a method from the generated form (list, enum, vocabulary picker)', async () => {
    await page.click('button:has-text("+ New")');
    await page.waitForSelector('form.itemform');
    expect(page.url().includes('edit=1'), page.url());
    await page.fill('#f-title', 'Systematic review');
    await page.selectOption('[data-field=kind] select', 'procedure');
    await page.fill('#f-purpose', 'Find and appraise all the evidence');
    const proc = '[data-field=procedure]';
    await page.click(`${proc} button:has-text("+ Add")`); await page.fill(`${proc} .listedit-row:nth-child(1) input`, 'Protocol');
    await page.click(`${proc} button:has-text("+ Add")`); await page.fill(`${proc} .listedit-row:nth-child(2) input`, 'Search');
    await page.click('[data-field=domain] .picker input'); await page.fill('[data-field=domain] .picker input', 'research');
    await page.waitForSelector('[data-field=domain] .suggest li button');
    await page.click('[data-field=domain] .suggest li button');
    await page.click('form.itemform button[type=submit]');
    await page.waitForSelector('article.doc h1:has-text("Systematic review")');
    expect(page.url().includes('key=method%3Asystematic-review') && !page.url().includes('edit=1'), page.url());
    const it = await api('/api/items/method%3Asystematic-review');
    expect(JSON.stringify(it.fields.procedure) === '["Protocol","Search"]' && it.fields.domain[0].key === 'domain:research-methodology' && it.fields.kind === 'procedure', JSON.stringify(it.fields));
    expect(it.provenance.kind.by === 'owner' && it.provenance.kind.status === 'reviewed', 'owner provenance');
    await page.screenshot({ path: OUT + '/2-method.png' });
  });
  await step('edit sends only changed fields', async () => {
    const before = await api('/api/items/method%3Asystematic-review');
    await page.click('article.doc button:has-text("Edit")');
    await page.waitForSelector('form.itemform');
    await page.fill('#f-purpose', 'Find, appraise and synthesise all the evidence');
    await page.click('form.itemform button[type=submit]');
    await page.waitForSelector('article.doc [data-field=purpose]:has-text("synthesise")');
    const after = await api('/api/items/method%3Asystematic-review');
    expect(after.provenance.purpose.at !== before.provenance.purpose.at, 'purpose re-stamped');
    expect(after.provenance.kind.at === before.provenance.kind.at && after.provenance.procedure.at === before.provenance.procedure.at, 'untouched fields keep their provenance');
  });
  await step('add a typed link with the relation picker, then remove it', async () => {
    await page.click('summary:has-text("Add a link")');
    await page.selectOption('.linkform select', 'ADDRESSES');
    await page.click('.linkform .picker input'); await page.fill('.linkform .picker input', 'offline');
    await page.waitForSelector('.linkform .suggest li button');
    await page.click('.linkform .suggest li button');
    await page.fill('.linkform input[placeholder^=Evidence]', 'A review of offline payment pilots');
    await page.click('.linkform button[type=submit]');
    await page.waitForSelector('.rel li:has-text("Offline retail payments")');
    await page.click('.rel li:has-text("Offline retail payments") button[aria-label="Remove link"]');
    await until(async () => !(await page.$$eval('.rel li', (ls) => ls.some((l) => l.textContent.includes('Offline retail payments')))));
  });
  await step('delete with confirmation', async () => {
    await page.click('article.doc .actions button:has-text("Delete")');
    await Promise.all([page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('systematic-review')), page.click('.confirm button:has-text("Delete")')]);
    await until(async () => !(await page.$$eval('.list .item', (bs) => bs.some((b) => b.textContent.includes('Systematic review')))));
    const r = (await fetch(U + '/api/items/method%3Asystematic-review', { headers: { Authorization: 'Bearer ' + TOK } })).status; // from Node, not the page
    expect(r === 404, 'gone from the database');
  });
  await step('case study: structured editor (list of objects) round-trips', async () => {
    await page.click('.collbar button[data-section=case_study]');
    await page.click('.item:has-text("Lisbon")');
    await page.waitForSelector('article.doc [data-field=outcomes] table');
    await page.click('article.doc button:has-text("Edit")');
    await page.waitForSelector('[data-field=outcomes] .listedit-row');
    await page.click('[data-field=outcomes] button:has-text("+ Add row")');
    await page.fill('[data-field=outcomes] .listedit-row:nth-child(2) input[aria-label=measure]', 'cost');
    await page.fill('[data-field=outcomes] .listedit-row:nth-child(2) input[aria-label=value]', '-30%');
    await page.click('form.itemform button[type=submit]');
    await page.waitForSelector('article.doc [data-field=outcomes] tbody tr:nth-child(2)');
    const it = await api('/api/items/case%3Alisbon-cbdc-pilot');
    expect(it.fields.outcomes.length === 2 && it.fields.outcomes[0].expected === true && it.fields.outcomes[1].measure === 'cost', JSON.stringify(it.fields.outcomes));
    expect(it.fields.organisations[0].name === 'Banco de Portugal', 'refs survive an edit of another field');
  });
  await step('audit: buckets and one-click accept', async () => {
    await page.click('.collbar button[data-section=audit]');
    await page.waitForURL(/\/library\/audit/);
    await page.waitForSelector('.auditbucket');
    const before = await api('/api/audit');
    expect(before.counts.low_confidence >= 1 && before.counts.ungrounded >= 1 && before.counts.vocab_by_claude >= 1, JSON.stringify(before.counts));
    await page.screenshot({ path: OUT + '/3-audit.png', fullPage: true });
    await page.click('#audit-low_confidence li button:has-text("Accept")');
    await until(async () => !(await page.$('#audit-low_confidence')));
    const after = await api('/api/audit');
    expect(after.counts.low_confidence === before.counts.low_confidence - 1, 'one fewer');
    await page.click('#audit-vocab_by_claude li button:has-text("Accept")');
    await until(async () => !(await page.$('#audit-vocab_by_claude')));
  });
  await step('audit Edit opens the form at the field', async () => {
    await page.click('#audit-ungrounded li button:has-text("Edit")');
    await page.waitForSelector('form.itemform [data-field=key_findings].focus');
    expect(page.url().includes('/library/papers') && page.url().includes('edit=1'), page.url());
    await page.click('form.itemform button:has-text("Cancel")');
  });
  await step('graph view renders with the new node types', async () => {
    await page.click('.collbar button[data-section=graph]');
    await page.waitForSelector('.legend button:has-text("UseCase")', { timeout: 15000 });
    await page.waitForSelector('#hub-graph canvas', { timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: OUT + '/4-graph.png' });
  });
  await step('older link /library?key= opens the item in its collection', async () => {
    await page.goto(U + '/library?key=' + encodeURIComponent('usecase:offline-retail-payments'));
    await page.waitForURL(/\/library\/use-cases\?key=/);
    await page.waitForSelector('article.doc h1:has-text("Offline retail payments")');
  });
  // Task 8: More menu, questions and hypotheses, derived status, TESTS from a paper, frameworks and ontologies
  await step('More lists frameworks, questions and hypotheses, ontologies', async () => {
    await page.goto(U + '/library/papers');
    await page.click('.moremenu summary');
    const entries = await page.$$eval('.moremenu .menu-list button', (b) => b.map((x) => x.textContent.trim()));
    expect(JSON.stringify(entries) === JSON.stringify(['Frameworks', 'Questions and hypotheses', 'Ontologies and standards']), entries.join('|'));
    await page.click('.moremenu .menu-list button:has-text("Frameworks")');
    await page.waitForURL(/\/library\/frameworks/);
    expect((await page.textContent('.moremenu summary')).includes('Frameworks'), 'the menu shows where you are');
  });
  await step('a framework page lists the papers and questions framed by it', async () => {
    await page.click('.item:has-text("Two-sided market theory")');
    await page.waitForSelector('section[data-rel="in:FRAMED_BY"]');
    const framed = await page.textContent('section[data-rel="in:FRAMED_BY"]');
    expect(framed.includes('Owner-Custodianship') && framed.includes('Why do stablecoins struggle'), framed);
    expect((await page.textContent('section[data-rel="in:DERIVED_FROM"]')).includes('Adoption requires'), 'hypotheses derived from it');
  });
  await step('questions and hypotheses switch; a hypothesis shows its tests and a derived, mixed status', async () => {
    await page.goto(U + '/library/research-questions');
    await page.waitForSelector('.groupswitch');
    await page.click('.groupswitch button[data-section=hypothesis]');
    await page.waitForURL(/\/library\/hypotheses/);
    await page.click('.item:has-text("Adoption requires")');
    await page.waitForSelector('section[data-rel="in:TESTS"] table');
    const head = await page.textContent('section[data-rel="in:TESTS"] .label');
    expect(/1 supported/.test(head) && /1 refuted/.test(head), head);
    expect((await page.$$('section[data-rel="in:TESTS"] .badge.res-supported')).length === 1 && (await page.$$('section[data-rel="in:TESTS"] .badge.res-refuted')).length === 1, 'result badges');
    expect((await page.textContent('[data-field=status] .field-value')).trim() === 'mixed', 'status');
    expect((await page.textContent('[data-field=status] .prov')).includes('derived'), 'marked as derived');
    await page.screenshot({ path: OUT + '/6-hypothesis.png' });
  });
  await step('create a hypothesis from the form: the title comes from the statement', async () => {
    await page.click('button:has-text("+ New")');
    await page.waitForSelector('form.itemform [data-field=statement] textarea');
    await page.fill('[data-field=statement] textarea', 'Redemption risk reduces trust in stablecoins');
    await page.selectOption('[data-field=direction] select', 'negative');
    await page.click('form.itemform button[type=submit]');
    await page.waitForSelector('article.doc h1:has-text("Redemption risk reduces trust in stablecoins")');
    const it = await api('/api/items/hypothesis%3Aredemption-risk-reduces-trust-in-stablecoins');
    expect(it.fields.status === 'untested' && it.fields.origin === 'own' && it.fields.direction === 'negative', JSON.stringify(it.fields));
  });
  await step('a paper adds a TESTS link with its result, and the hypothesis status follows', async () => {
    await page.goto(U + '/library/papers?key=' + encodeURIComponent('doi:10.1007/978-1-4757-0602-4_18'));
    await page.click('.tab[data-tab=analysis]');
    await page.waitForSelector('.analysis section[data-rel="out:TESTS"]');
    await page.click('.analysis summary:has-text("Add a link")');
    await page.selectOption('.analysis .linkform select >> nth=0', 'TESTS');
    await page.selectOption('.analysis .linkform select[aria-label=result]', 'refuted');
    await page.click('.analysis .linkform .picker input'); await page.fill('.analysis .linkform .picker input', 'Redemption');
    await page.waitForSelector('.analysis .linkform .suggest li button');
    await page.click('.analysis .linkform .suggest li button');
    await page.fill('.analysis .linkform input[placeholder^=Evidence]', 'trust held despite the risk');
    await page.click('.analysis .linkform button[type=submit]');
    await page.waitForSelector('.analysis section[data-rel="out:TESTS"] tr[data-key="hypothesis:redemption-risk-reduces-trust-in-stablecoins"]');
    const it = await api('/api/items/hypothesis%3Aredemption-risk-reduces-trust-in-stablecoins');
    expect(it.fields.status === 'refuted', it.fields.status);
  });
  await step('an ontology page shows its modules and users', async () => {
    await page.goto(U + '/library/ontologies-and-standards');
    await page.click('.item:has-text("Financial Industry Business Ontology")');
    await page.waitForSelector('section[data-rel="in:PART_OF"]');
    expect((await page.textContent('section[data-rel="in:PART_OF"]')).includes('FIBO Foundations'), 'modules');
    expect((await page.textContent('section[data-rel="out:USED_BY"]')).includes('Offline retail payments'), 'users');
    expect((await page.textContent('[data-field=urls]')).includes('https://spec.edmcouncil.org/fibo/'), 'links');
  });
  await step('an ontology snapshot: the license must be confirmed, and an old snapshot says so', async () => {
    const key = 'ontology%3Afinancial-industry-business-ontology';
    await api('/api/items/' + key, { method: 'PATCH', body: JSON.stringify({ fields: { version: '2024Q4', snapshot: { file_url: 'https://drive.google.com/file/d/X/view', drive_file_id: 'X', retrieved_at: '2024-01-05T00:00:00Z', version: '2023Q4', sha256: 'ab'.repeat(32), size_bytes: 4096, mime: 'text/turtle' } } }) });
    await page.reload();
    await page.waitForSelector('details.snapshot[open]');
    expect((await page.textContent('details.snapshot .flag.stale')).includes('version 2023Q4; the record now says 2024Q4'), 'stale note');
    expect(await page.isDisabled('details.snapshot .btn-primary'), 'upload disabled before a file and the license check');
    await page.setInputFiles('details.snapshot input[type=file]', { name: 'fibo.ttl', mimeType: 'text/turtle', buffer: Buffer.from('@prefix a: <b> .') });
    expect(await page.isDisabled('details.snapshot .btn-primary'), 'still disabled without the license check');
    await page.check('#snap-license');
    expect(!(await page.isDisabled('details.snapshot .btn-primary')), 'enabled once both are given');
    await page.screenshot({ path: OUT + '/9-ontology-snapshot.png', fullPage: true });
  });
  await step('the upload link opens a drop zone for the paper', async () => {
    await page.goto(U + '/library/papers?key=' + encodeURIComponent('doi:10.1007/978-1-4757-0602-4_18') + '&upload=1');
    await page.waitForSelector('.dropzone');
    expect((await page.textContent('.dropzone')).includes('Drop the PDF here'), 'drop zone text');
    await page.focus('.dropzone');
    expect(await page.evaluate(() => document.activeElement.classList.contains('dropzone')), 'keyboard reachable');
    await page.screenshot({ path: OUT + '/10-dropzone.png' });
    await page.goto(U + '/library/papers?key=' + encodeURIComponent('doi:10.1007/978-1-4757-0602-4_18'));
    await page.waitForSelector('.doc h1');
    expect(!(await page.$('.dropzone')), 'no drop zone without the link');
  });
  await step('OAuth approval page: Chrome follows the redirect back to the client (CSP form-action)', async () => {
    const reg = await page.evaluate(async (u) => (await fetch(u + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:18999/callback'], client_name: 'Browser check' }) })).json(), U);
    // a stand-in for the MCP client's callback (a redirect after a form post is not intercepted by page.route)
    const cb = require('http').createServer((_q, r) => r.end('client received the code')); await new Promise((ok) => cb.listen(18999, '127.0.0.1', ok));
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:18999/callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's1' });
    await page.goto(U + '/oauth/authorize?' + q);
    expect((await page.textContent('main')).includes('Browser check'), 'client name shown');
    expect((await page.textContent('main')).includes('signed in as the owner'), 'the session is recognised');
    await page.screenshot({ path: OUT + '/11-oauth-approve.png' });
    await Promise.all([page.waitForURL(/127\.0\.0\.1:18999\/callback/), page.click('button[value=allow]')]);
    const back = new URL(page.url());
    expect(back.searchParams.get('code') && back.searchParams.get('state') === 's1', page.url());
    cb.close();
  });
  await step('no console or CSP errors', async () => { expect(!problems.length, problems.slice(0, 5).join(' || ')); });
  for (const r of results) console.log(r.join(' | '));
  if (results.some((r) => r[0] !== 'PASS')) process.exitCode = 1; // CI needs a failing exit code
  await browser.close();
})();
