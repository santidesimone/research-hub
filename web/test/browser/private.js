// Browser check (see README.md here): a hub WITHOUT PUBLIC_ACCESS. Everything is behind the token: every page is the
// sign-in form, nothing is served to a visitor, and the publishing settings cannot be used. Run after seed.js; it only reads.
const { chromium } = require('playwright-core');
const U = process.env.HUB_PRIVATE_URL || 'http://127.0.0.1:18083', TOK = process.env.HUB_API_TOKEN, OUT = process.env.OUT || require('os').tmpdir();
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); } };
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const problems = [], apis = [];
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.url().includes('/api/')) apis.push(`${r.request().method()} ${new URL(r.url()).pathname}`); if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url().replace(U, '')}`); });

  await step('visitor: every page is the sign-in form, with no menu', async () => {
    for (const p of ['/', '/library', '/library/methods', '/console', '/settings', '/nonsense']) {
      await page.goto(U + p);
      await page.waitForSelector('form.login input[type=password]');
      expect(!(await page.$('.list, #menubtn, .topbar button:has-text("Sign in")')), 'nothing but the form on ' + p);
    }
    await page.screenshot({ path: OUT + '/p0-private-login.png' });
  });
  await step('visitor: the page asked only for the session, the apps and the schema (no data)', async () => {
    const used = [...new Set(apis)].sort();
    expect(used.every((u) => ['GET /api/apps', 'GET /api/me', 'GET /api/schema'].includes(u)), used.join(', '));
  });
  await step('visitor: the data endpoints refuse without the token', async () => {
    for (const p of ['/api/public', '/api/public/items/doi%3A10.3390%2Ffi13050130', '/api/graph', '/api/papers', '/api/items?collection=method']) {
      const s = (await fetch(U + p)).status;
      expect(s === 401, `${p}: ${s}`);
    }
  });
  await step('owner: sign in where you are, and land on that page', async () => {
    await page.goto(U + '/library/methods');
    await page.fill('form.login input[type=password]', TOK);
    await page.click('form.login button[type=submit]');
    await page.waitForSelector('.topbar button:has-text("Sign out")');
    await page.waitForSelector('.list .item');
    expect(new URL(page.url()).pathname.endsWith('/library/methods'), page.url());
    expect(!(await page.$('.seg button:has-text("Public preview")')), 'no public preview toggle');
  });
  await step('owner: Settings says public access is off, with no switches', async () => {
    await page.goto(U + '/settings');
    await page.waitForSelector('text=Public access is off');
    expect(!(await page.$('[data-setting], [data-apply]')), 'no switches or buttons');
  });
  await step('no console errors, CSP violations or failed requests', async () => expect(!problems.length, problems.slice(0, 4).join(' || ')));
  for (const r of results) console.log(r.join(' | '));
  await browser.close();
  process.exit(results.some((r) => r[0] !== 'PASS') ? 1 : 0);
})();
