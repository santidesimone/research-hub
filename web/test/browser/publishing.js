// Browser check (see README.md here): the owner's Settings, then what a visitor sees. Run after seed.js, owner.js and
// public-mobile.js: it makes every item public (single use, like the seed) and then puts the settings back to the defaults.
const { chromium } = require('playwright-core');
const U = process.env.HUB_URL || 'http://127.0.0.1:18082', TOK = process.env.HUB_API_TOKEN;
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); } };
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const watch = (page, problems) => {
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(U, '')}`); });
};
const titles = (page) => page.$$eval('.list .item .t', (e) => e.map((x) => x.textContent));
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const owner = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const p1 = [];
  watch(owner, p1);

  await step('owner: Settings shows the defaults', async () => {
    await owner.goto(U + '/library');
    await owner.click('button:has-text("Sign in")');
    await owner.fill('input[type=password]', TOK);
    await owner.click('form.modal button[type=submit]');
    await owner.waitForSelector('.topbar button:has-text("Sign out")');
    await owner.goto(U + '/settings');
    await owner.waitForSelector('[data-setting="public_detail"]');
    const on = await owner.$$eval('.seg button.on', (b) => b.map((x) => `${x.dataset.setting}=${x.dataset.value}`).sort());
    expect(JSON.stringify(on) === JSON.stringify(['default_visibility=private', 'public_detail=basic']), on.join('|'));
  });
  await step('owner: switch to public by default and full detail', async () => {
    await owner.click('[data-setting="default_visibility"][data-value="public"]');
    await owner.waitForSelector('[data-setting="default_visibility"][data-value="public"].on');
    await owner.click('[data-setting="public_detail"][data-value="full"]');
    await owner.waitForSelector('[data-setting="public_detail"][data-value="full"].on');
    await owner.reload();
    await owner.waitForSelector('[data-setting="public_detail"][data-value="full"].on', { timeout: 5000 });
  });

  const anon = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const p2 = [];
  watch(anon, p2);
  await step('visitor, full detail: a public paper shows its abstract; private ones stay out', async () => {
    await anon.goto(U + '/library');
    await anon.waitForSelector('.list .item');
    const t = await titles(anon);
    expect(t.includes('A Public Preprint on Payments') && !t.includes('PRIVATE-PAPER-TITLE'), t.join('|'));
    await anon.click('.list .item:has-text("A Public Preprint on Payments")');
    await anon.waitForSelector('.abstract');
    expect((await anon.innerText('.abstract')).includes('SECRET-ABSTRACT-TEXT'), 'abstract');
  });
  await step('visitor, full detail: a public method shows every field', async () => {
    await anon.click('.sidebar .nav[data-section=method]');
    await anon.click('.list .item:has-text("Snowballing")');
    await anon.waitForSelector('.analysis .fieldgroup');
    const text = await anon.innerText('.analysis');
    expect(text.includes('Follow references and citations') && text.includes('Go backward'), text.slice(0, 200));
  });

  await step('owner: make every item public', async () => {
    const btn = '[data-apply="public"]';
    await owner.click(btn); await owner.click(btn); // the second click confirms
    await owner.waitForSelector('.toast:has-text("now public")');
  });
  // a new visitor: browsers may keep /api/public for PUBLIC_CACHE_SECONDS (60 by default), so this one has no cached copy
  const anon2 = await (await browser.newContext()).newPage({ viewport: { width: 1280, height: 860 } });
  watch(anon2, p2);
  await step('visitor: every item is public now', async () => {
    const anon = anon2;
    await anon.goto(U + '/library');
    await anon.waitForSelector('.list .item');
    const t = await titles(anon);
    expect(t.includes('PRIVATE-PAPER-TITLE'), t.join('|'));
    await anon.click('.sidebar .nav[data-section=case_study]');
    await anon.waitForSelector('.list .item:has-text("Lisbon CBDC pilot")');
  });
  await step('visitor: no reading status, no Settings', async () => {
    expect(!(await anon.$('.seg select, select.status')), 'no status control');
    const app = (await (await fetch(U + '/api/apps')).json()).apps.find((a) => a.id === 'settings');
    expect(app && app.auth === 'owner', 'the Settings app is owner only');
    const r = (await fetch(U + '/api/settings/publishing')).status;
    expect(r === 401, 'settings API is owner only: ' + r);
  });
  await step('owner: back to the defaults', async () => {
    await owner.click('[data-setting="default_visibility"][data-value="private"]');
    await owner.click('[data-setting="public_detail"][data-value="basic"]');
    await owner.waitForSelector('[data-setting="public_detail"][data-value="basic"].on');
  });

  const problems = [...p1, ...p2];
  await step('no console errors, CSP violations or failed requests', async () => expect(!problems.length, problems.join(' || ')));
  for (const r of results) console.log(r.join('  '));
  await browser.close();
  process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
})();
