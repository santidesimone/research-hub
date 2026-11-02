// Browser check (see README.md here): the Library's Curation section. Proposes plans through the API (as Claude would
// through MCP), then reviews them in the UI: the changes are shown, Apply merges, Undo restores, Reject drops a plan.
// Run after seed.js; it leaves the data as it found it (only the plans stay, as the log).
const { chromium } = require('playwright-core');
const U = process.env.HUB_URL || 'http://127.0.0.1:18082', TOK = process.env.HUB_API_TOKEN, OUT = process.env.OUT || require('os').tmpdir();
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); } };
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const H = { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json' };
const api = async (path, opts = {}) => { const r = await fetch(U + path, { ...opts, headers: H }); const b = await r.json(); if (!r.ok) throw new Error(`${r.status} ${b.error}`); return b; };
const exists = async (key) => (await fetch(U + '/api/items/' + encodeURIComponent(key), { headers: H })).status === 200;
const A = 'method:snowballing', B = 'method:difference-in-differences';
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(U, '')}`); });

  let merge, junk;
  await step('plans proposed through the API change nothing yet', async () => {
    merge = await api('/api/curation/plans', { method: 'POST', body: JSON.stringify({ ops: [{ op: 'merge', keep: A, drop: B }], reason: 'Browser check: merge two methods' }) });
    junk = await api('/api/curation/plans', { method: 'POST', body: JSON.stringify({ ops: [{ op: 'delete', key: B }], reason: 'Browser check: to be rejected' }) });
    expect(await exists(B), 'still there');
  });
  await step('owner: Curation lists both plans with their changes', async () => {
    await page.goto(U + '/library');
    await page.click('button:has-text("Sign in")'); await page.fill('input[type=password]', TOK); await page.click('form.modal button[type=submit]');
    await page.waitForSelector('.topbar button:has-text("Sign out")');
    await page.click('.sidebar .nav[data-section=curation]');
    await page.waitForSelector(`[data-plan="${merge.id}"]`);
    expect(new URL(page.url()).pathname.endsWith('/library/curation'), page.url());
    const text = await page.innerText(`[data-plan="${merge.id}"]`);
    expect(text.includes('Merge') && text.includes(B) && text.includes('Browser check: merge two methods'), text.slice(0, 200));
    expect(await page.$(`[data-plan="${merge.id}"] table.conflicts`), 'conflicting fields are shown');
    expect(await page.$(`[data-plan="${junk.id}"]`), 'the second plan');
    await page.screenshot({ path: OUT + '/c1-curation.png', fullPage: true });
  });
  await step('owner: Reject drops a plan', async () => {
    await page.click(`[data-plan="${junk.id}"] [data-action="reject"]`);
    await page.waitForSelector(`[data-plan="${junk.id}"]`, { state: 'detached' });
    expect(await exists(B), 'nothing deleted');
  });
  await step('owner: Apply (with a confirm click) merges', async () => {
    const btn = `[data-plan="${merge.id}"] [data-action="apply"]`;
    await page.click(btn);
    expect((await page.textContent(btn)).includes('Click again'), 'asks to confirm');
    await page.click(btn);
    await page.waitForSelector(`[data-plan="${merge.id}"]`, { state: 'detached' });
    expect(!(await exists(B)) && await exists(A), 'B merged into A');
  });
  await step('owner: Undo restores', async () => {
    await page.click('.curation [data-filter="applied"]');
    const btn = `[data-plan="${merge.id}"] [data-action="revert"]`;
    await page.waitForSelector(btn);
    await page.click(btn); await page.click(btn);
    await page.waitForSelector(`[data-plan="${merge.id}"]`, { state: 'detached' });
    expect(await exists(B), 'B is back');
    await page.click('.curation [data-filter=""]');
    await page.waitForSelector(`[data-plan="${merge.id}"] .badge:has-text("reverted")`);
    await page.waitForSelector(`[data-plan="${junk.id}"] .badge:has-text("rejected")`);
  });
  await step('a key in a plan opens the item', async () => {
    await page.click(`[data-plan="${merge.id}"] .keylink:has-text("${A}")`);
    await page.waitForURL(/\/library\/methods\?key=/);
  });
  await step('no console errors, CSP violations or failed requests', async () => expect(!problems.length, problems.slice(0, 4).join(' || ')));
  for (const r of results) console.log(r.join(' | '));
  await browser.close();
  process.exit(results.some((r) => r[0] !== 'PASS') ? 1 : 0);
})();
