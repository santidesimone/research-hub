// Browser check (see README.md here). playwright-core is not a project dependency: install it outside the repo and set NODE_PATH.
const { chromium } = require('playwright-core');
const U = process.env.HUB_URL || 'http://127.0.0.1:18082', TOK = process.env.HUB_API_TOKEN, OUT = process.env.OUT || require('os').tmpdir();
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); } };
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const until = async (check, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await check()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const watch = (page, problems, apis) => {
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.url().includes('/api/')) apis.push(`${r.status()} ${r.request().method()} ${r.url().replace(U, '').split('?')[0]}`); if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url().replace(U, '')}`); });
};
const noOverflow = async (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });

  /* anonymous visitor: public preview only */
  const anon = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const p1 = [], a1 = [];
  watch(anon, p1, a1);
  await step('anonymous: Library opens on the public preview', async () => {
    await anon.goto(U + '/library');
    await anon.waitForSelector('.list .item');
    expect(await anon.isVisible('.banner'), 'public preview banner');
    const titles = await anon.$$eval('.list .item .t', (e) => e.map((x) => x.textContent));
    expect(titles.length === 1 && titles[0] === 'A Public Preprint on Payments', titles.join('|'));
    const bar = await anon.$$eval('.sidebar .nav', (b) => b.map((x) => x.dataset.section));
    expect(!bar.includes('review'), 'no Review for visitors: ' + bar.join('|'));
    expect(!(await anon.$('button:has-text("+ New")')), 'no create button');
  });
  await step('anonymous: detail shows only whitelisted fields', async () => {
    await anon.click('.item:has-text("A Public Preprint")');
    await anon.waitForSelector('article.doc h1');
    const text = await anon.textContent('body');
    expect(!text.includes('SECRET-ABSTRACT-TEXT'), 'abstract is not public');
    expect(!(await anon.$('.tab[data-tab=analysis]')) && !(await anon.$('article.doc button:has-text("Edit")')), 'no analysis tab or edit');
  });
  await step('anonymous: other collections show only public items', async () => {
    await anon.click('.sidebar .nav[data-section=method]');
    await anon.waitForSelector('.list .item');
    const m = await anon.$$eval('.list .item .t', (e) => e.map((x) => x.textContent));
    expect(m.length === 1 && m[0] === 'Snowballing', m.join('|'));
    await anon.fill('.sidebar input[type=search]', '');
    await anon.press('.sidebar input[type=search]', 'Enter');
    await anon.waitForURL(/\/library\/all/);
    await anon.waitForSelector('.list .item');
    const all = await anon.textContent('.list');
    expect(!all.includes('PRIVATE-PAPER-TITLE') && !all.includes('Difference in differences') && !all.includes('Lisbon'), 'private items never listed');
  });
  await step('anonymous: the audit address falls back to papers', async () => {
    await anon.goto(U + '/library/audit');
    await anon.waitForSelector('.list .item');
    expect(!(await anon.$('.auditbucket')), 'no audit');
  });
  await step('anonymous: only public endpoints, no errors', async () => {
    const used = [...new Set(a1.map((x) => x.split(' ').slice(1).join(' ')))].sort();
    expect(used.every((u) => ['GET /api/apps', 'GET /api/me', 'GET /api/public', 'GET /api/schema'].includes(u)), used.join(', '));
    expect(!p1.length, p1.slice(0, 4).join(' || '));
  });

  /* the root: a login page for anyone not signed in (phone width) */
  const land = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  const p3 = [], a3 = [];
  watch(land, p3, a3);
  await step('anonymous: the root is a login page; signing in opens the Library', async () => {
    await land.goto(U + '/');
    await land.waitForSelector('form.login input[type=password]');
    expect(!(await land.$('.list')), 'no library at the root');
    expect(!(await land.$('.topbar button:has-text("Sign in")')), 'one sign-in form, not a second button in the top bar');
    expect(await noOverflow(land), 'the login page fits a phone');
    await land.screenshot({ path: OUT + '/m0-login.png' });
    await land.fill('form.login input[type=password]', 'wrong-token');
    await land.click('form.login button[type=submit]');
    await land.waitForSelector('form.login .alert:not(.hidden)');
    await land.fill('form.login input[type=password]', TOK);
    await land.click('form.login button[type=submit]');
    await land.waitForSelector('.topbar button:has-text("Sign out")');
    await land.waitForSelector('.list .item');
    expect(new URL(land.url()).pathname === new URL(U).pathname.replace(/\/$/, '') + '/library', land.url());
  });
  await step('login page: no errors besides the rejected token', async () => {
    const others = p3.filter((p) => !/HTTP 40[13] .*\/api\/login/.test(p) && !/status of 40[13]/.test(p)); // the wrong token above
    expect(!others.length, others.slice(0, 4).join(' || '));
  });

  /* mobile width, as the owner */
  const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p2 = [], a2 = [];
  watch(mob, p2, a2);
  await step('mobile: sign in, papers list fits the width', async () => {
    await mob.goto(U + '/library');
    await mob.click('button:has-text("Sign in")'); await mob.fill('input[type=password]', TOK); await mob.click('form.modal button[type=submit]');
    await mob.waitForSelector('.list .item');
    expect(await noOverflow(mob), 'page wider than the screen');
    const tb = await mob.$eval('.topbar', (e) => [...e.children].every((c) => { const r = c.getBoundingClientRect(); return r.right <= window.innerWidth + 1 && r.height <= 56; }));
    expect(tb, 'every top-bar control on screen, one line');
    expect(!(await mob.$eval('.pane-head', (e) => /(^|\s)0(\s|$)/.test(e.innerText))), 'no stray 0');
    await mob.waitForSelector('.list .item .t'); await mob.screenshot({ path: OUT + '/m1-list.png' });
  });
  await step('mobile: the sidebar is a drawer; a tap outside closes it', async () => {
    expect(!(await mob.isVisible('.sidebar .nav[data-section=paper]')), 'hidden until opened');
    await mob.click('.mobilebar button[aria-label="Open the library menu"]');
    await mob.waitForSelector('.libwrap.drawer-open .sidebar .nav[data-section=case_study]', { state: 'visible' });
    await mob.waitForTimeout(300);
    await mob.screenshot({ path: OUT + '/m0-drawer.png' });
    await mob.mouse.click(370, 400); // on the scrim, right of the drawer
    await mob.waitForSelector('.libwrap:not(.drawer-open)');
    await mob.click('.mobilebar button[aria-label="Open the library menu"]');
    await mob.waitForSelector('.libwrap.drawer-open');
    await mob.waitForTimeout(300);
    await mob.click('.sidebar .nav[data-section=case_study]');
    await mob.waitForURL(/case-studies/);
    await mob.waitForSelector('.libwrap:not(.drawer-open)');
    await mob.waitForSelector('.list .item');
    expect(await noOverflow(mob), 'case studies overflow');
  });
  await step('mobile: detail and the edit form are usable', async () => {
    await mob.click('.item:has-text("Lisbon")');
    await mob.waitForSelector('article.doc h1');
    await mob.click('article.doc button:has-text("Edit")');
    await mob.waitForSelector('form.itemform #f-title');
    const w = await mob.$eval('#f-title', (e) => e.getBoundingClientRect().right);
    expect(w <= 390, 'title input inside the screen: ' + w);
    expect(await noOverflow(mob), 'form overflow');
    expect((await mob.textContent('form.itemform h2')) === 'Edit case study', 'heading');
    await mob.screenshot({ path: OUT + '/m2-form.png' });
    await mob.click('form.itemform button:has-text("Cancel")');
  });
  await step('mobile: no console or CSP errors', async () => { expect(!p2.length, p2.slice(0, 4).join(' || ')); });
  for (const r of results) console.log(r.join(' | '));
  if (results.some((r) => r[0] !== 'PASS')) process.exitCode = 1; // CI needs a failing exit code
  await browser.close();
})();
