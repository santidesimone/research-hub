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
  await step('no console or CSP errors', async () => { expect(!problems.length, problems.slice(0, 5).join(' || ')); });
  for (const r of results) console.log(r.join(' | '));
  if (results.some((r) => r[0] !== 'PASS')) process.exitCode = 1; // CI needs a failing exit code
  await browser.close();
})();
