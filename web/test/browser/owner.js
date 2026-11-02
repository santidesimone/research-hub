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
    await page.waitForSelector('.topbar button:has-text("Sign out")');
  });
  await step('sidebar groups from the schema, with counts', async () => {
    await page.waitForSelector('.sidebar .nav[data-section=paper] .count');
    const groups = await page.$$eval('.sidebar .navlabel', (e) => e.map((x) => x.textContent));
    expect(JSON.stringify(groups) === JSON.stringify(['Reading', 'Knowledge', 'Inquiry']), groups.join('|'));
    const ids = await page.$$eval('.sidebar .nav', (b) => b.map((x) => x.dataset.section));
    expect(JSON.stringify(ids) === JSON.stringify(['paper', 'method', 'use_case', 'case_study', 'framework', 'ontology', 'research_question', 'hypothesis', 'graph', 'review']), ids.join('|'));
    expect((await page.textContent('.sidebar .nav[data-section=method] .count')) === '2', 'two methods counted');
    expect(await page.getAttribute('.sidebar .nav[data-section=paper]', 'aria-current') === 'page', 'papers marked as current');
    expect(!(await page.$('.topbar .badge')), 'no Owner badge in the top bar');
    expect(new URL(page.url()).pathname === '/library', page.url());
    await page.screenshot({ path: OUT + '/0-sidebar.png' });
  });
  await step('the sidebar collapses to a rail and remembers it', async () => {
    await page.click('.sidebar .collapse');
    await page.waitForSelector('.libwrap.collapsed .sidebar .expand');
    expect(!(await page.isVisible('.sidebar .nav[data-section=paper]')), 'the entries are hidden');
    await page.reload();
    await page.waitForSelector('.libwrap.collapsed');
    await page.click('.sidebar .expand');
    await page.waitForSelector('.sidebar .nav[data-section=paper]', { state: 'visible' });
  });
  await step('Search everything opens All with the query', async () => {
    await page.fill('.sidebar input[type=search]', 'Blind');
    await page.press('.sidebar input[type=search]', 'Enter');
    await page.waitForURL(/\/library\/all/);
    await page.waitForSelector('.list .item:has-text("Blind Signatures")');
    expect((await page.$$('.list .item')).length === 1, 'only the match');
    await page.click('.sidebar .nav[data-section=paper]');
    await page.waitForURL(/\/library\/papers/);
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
    await page.click('.sidebar .nav[data-section=method]');
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
  const UC = '.connrow[data-key="usecase:offline-retail-payments"]';
  await step('Connections: Link… finds anything, then asks how it relates', async () => {
    await page.click('article.doc .tab[data-tab=connections]');
    await page.click('.connections [data-action=link]');
    await page.waitForSelector('.linkpicker input[type=search]');
    await page.waitForSelector('.linkpicker .linkgroup[data-kind=Paper]'); // before typing: a few of each kind
    await page.fill('.linkpicker input[type=search]', 'offline');
    await page.waitForSelector('.linkpicker .linkgroup[data-kind=Paper]', { state: 'detached' }); // no paper matches
    await page.waitForSelector('.linkpicker .linkgroup[data-kind=UseCase] .opt[data-option="usecase:offline-retail-payments"]');
    await page.screenshot({ path: OUT + '/5a-link-picker.png' });
    await page.click('.linkpicker .opt[data-option="usecase:offline-retail-payments"]');
    await page.waitForSelector('.linkpicker .linkwhat:has-text("Offline retail payments")');
    await page.fill('.linkpicker input[aria-label=Note]', 'A review of offline payment pilots');
    await page.click('.linkpicker .opt[data-option="out:ADDRESSES:"]');
    await page.waitForSelector(`${UC}[data-rel=ADDRESSES] small:has-text("A review of offline payment pilots")`);
    expect((await page.textContent(`${UC} .role`)) === 'Addresses', 'the role, read from here');
    expect((await page.textContent('.tab[data-tab=connections]')).includes('Connections · '), 'the tab shows a count');
    await page.screenshot({ path: OUT + '/5b-connections.png' });
  });
  await step('Connections: ⋯ edits the note, closes on a tap outside, and unlinks', async () => {
    await page.click(`${UC} .dots`);
    await page.waitForSelector('.rowmenu .opt[data-option=unlink]');
    await page.mouse.click(5, 5); // outside
    await until(async () => !(await page.$('.rowmenu')));
    await page.click(`${UC} .dots`);
    await page.click('.rowmenu .opt[data-option=note]');
    await page.fill('.rowmenu textarea', 'Pilots in three countries');
    await page.fill('.rowmenu input[aria-label=Location]', 'section 2');
    await page.click('.rowmenu button[type=submit]');
    await page.waitForSelector(`${UC} small:has-text("Pilots in three countries · section 2")`);
    const it = await api('/api/items/method%3Asystematic-review');
    const l = it.links.out.find((x) => x.rel === 'ADDRESSES');
    expect(l.evidence === 'Pilots in three countries' && l.location === 'section 2' && l.by === 'owner', JSON.stringify(l));
    await page.click(`${UC} .dots`);
    await page.click('.rowmenu .opt[data-option=unlink]');
    await until(async () => !(await page.$(UC)));
    await page.click('article.doc .tab[data-tab=info]');
  });
  await step('delete with confirmation', async () => {
    await page.click('article.doc .actions button:has-text("Delete")');
    await Promise.all([page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('systematic-review')), page.click('.confirm button:has-text("Delete")')]);
    await until(async () => !(await page.$$eval('.list .item', (bs) => bs.some((b) => b.textContent.includes('Systematic review')))));
    const r = (await fetch(U + '/api/items/method%3Asystematic-review', { headers: { Authorization: 'Bearer ' + TOK } })).status; // from Node, not the page
    expect(r === 404, 'gone from the database');
  });
  await step('case study: structured editor (list of objects) round-trips', async () => {
    await page.click('.sidebar .nav[data-section=case_study]');
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
    await page.click('.sidebar .nav[data-section=review]');
    await page.waitForURL(/\/library\/review/);
    await page.waitForSelector('.review .tab.on[data-tab=check]');
    await page.waitForSelector('.auditbucket');
    expect(!(await page.$('.review .badge')), 'no pills in Review');
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
    await page.click('.sidebar .nav[data-section=graph]');
    await page.waitForSelector('#hub-graph canvas', { timeout: 15000 });
    expect(!(await page.$('.legend')), 'no chip legend');
    const shown = await page.textContent('.graphstats');
    expect(/^Showing \d+ of \d+ types/.test(shown), shown);
  });
  await step('graph filter: a popover of grouped checkboxes, remembered, closed by a tap outside', async () => {
    expect(!(await page.isVisible('.graphfilter')), 'closed until asked for');
    await page.click('.graphbar button:has-text("Filter")');
    await page.waitForSelector('.graphfilter:not(.hidden) input[data-label=UseCase]');
    const groups = await page.$$eval('.graphfilter .filtergroup', (e) => e.map((x) => x.dataset.group));
    expect(JSON.stringify(groups) === JSON.stringify(['reading', 'knowledge', 'inquiry', 'vocabulary', 'other']), groups.join('|'));
    expect(!(await page.isChecked('input[data-label=Concept]')) && !(await page.isChecked('input[data-label=Person]')) && await page.isChecked('input[data-label=Topic]'), 'large vocabularies off by default');
    await page.screenshot({ path: OUT + '/4b-filter.png' });
    await page.click('.graphfilter [data-group=vocabulary] .linkbtn:has-text("all")');
    expect(await page.isChecked('input[data-label=Person]'), 'all in a group');
    await page.click('.graphfilter button[data-all=off]');
    expect((await page.textContent('.graphstats')).startsWith('Showing 0 of'), 'None hides every type');
    await page.fill('.graphfilter input[type=search]', 'hypo');
    expect((await page.$$('.graphfilter .checkrow')).length === 1, 'type search');
    await page.uncheck('input[data-label=Hypothesis]').catch(() => {});
    await page.check('input[data-label=Hypothesis]');
    await page.mouse.click(700, 600); // outside the popover
    await page.waitForSelector('.graphfilter.hidden', { state: 'attached' });
    await page.reload();
    await page.waitForSelector('#hub-graph canvas', { timeout: 15000 });
    expect((await page.textContent('.graphstats')).startsWith('Showing 1 of'), 'the choice is remembered');
    await page.click('.graphbar button:has-text("Filter")');
    await page.click('.graphfilter button[data-all=on]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.graphfilter.hidden', { state: 'attached' });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: OUT + '/4-graph.png' });
  });
  await step('older link /library?key= opens the item in its collection', async () => {
    await page.goto(U + '/library?key=' + encodeURIComponent('usecase:offline-retail-payments'));
    await page.waitForURL(/\/library\/use-cases\?key=/);
    await page.waitForSelector('article.doc h1:has-text("Offline retail payments")');
  });
  // Task 8: questions and hypotheses, derived status, TESTS from a paper, frameworks and ontologies
  await step('frameworks open from the sidebar', async () => {
    await page.goto(U + '/library/papers');
    await page.click('.sidebar .nav[data-section=framework]');
    await page.waitForURL(/\/library\/frameworks/);
    expect(await page.getAttribute('.sidebar .nav[data-section=framework]', 'aria-current') === 'page', 'the sidebar shows where you are');
  });
  await step('a framework page lists the papers and questions framed by it', async () => {
    await page.click('.item:has-text("Two-sided market theory")');
    await page.click('article.doc .tab[data-tab=connections]');
    await page.waitForSelector('.conngroup[data-group=Paper]');
    expect((await page.textContent('.conngroup[data-group=Paper]')).includes('Owner-Custodianship'), 'papers framed by it');
    expect((await page.textContent('.conngroup[data-group=ResearchQuestion]')).includes('Why do stablecoins struggle'), 'questions framed by it');
    expect((await page.textContent('.conngroup[data-group=Hypothesis] .connrow[data-rel=DERIVED_FROM]')).includes('Adoption requires'), 'hypotheses derived from it');
  });
  await step('hypotheses have their own entry; a hypothesis shows its tests and a derived, mixed status', async () => {
    await page.goto(U + '/library/research-questions');
    await page.click('.sidebar .nav[data-section=hypothesis]');
    await page.waitForURL(/\/library\/hypotheses/);
    await page.click('.item:has-text("Adoption requires")');
    await page.click('article.doc .tab[data-tab=connections]');
    await page.waitForSelector('.conngroup[data-group=Paper] .connrow[data-rel=TESTS]');
    const roles = await page.$$eval('.conngroup[data-group=Paper] .connrow[data-rel=TESTS] .role', (e) => e.map((x) => `${x.textContent}|${x.className}`).sort());
    expect(JSON.stringify(roles) === JSON.stringify(['Tested by: refuted|role tone-disagree', 'Tested by: supported|role tone-agree']), roles.join(' / '));
    await page.screenshot({ path: OUT + '/6-hypothesis.png' });
    await page.click('article.doc .tab[data-tab=info]');
    expect((await page.textContent('[data-field=status] .field-value')).trim() === 'mixed', 'status');
    expect((await page.textContent('[data-field=status] .prov')).includes('derived'), 'marked as derived');
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
    await page.click('.tab[data-tab=connections]');
    await page.waitForSelector('.connpane .connrow[data-rel=TESTS]');
    await page.click('.connpane [data-action=link]');
    await page.fill('.linkpicker input[type=search]', 'Redemption');
    await page.waitForSelector('.linkpicker .linkgroup[data-kind=Paper]', { state: 'detached' });
    await page.click('.linkpicker .linkgroup[data-kind=Hypothesis] .opt[data-option="hypothesis:redemption-risk-reduces-trust-in-stablecoins"]');
    await page.fill('.linkpicker input[aria-label=Note]', 'trust held despite the risk');
    await page.click('.linkpicker .opt[data-option="out:TESTS:refuted"]');
    await page.waitForSelector('.connpane .connrow[data-key="hypothesis:redemption-risk-reduces-trust-in-stablecoins"] .role.tone-disagree:has-text("Tests: refuted")');
    const it = await api('/api/items/hypothesis%3Aredemption-risk-reduces-trust-in-stablecoins');
    expect(it.fields.status === 'refuted', it.fields.status);
  });
  await step('Connections: an unsure Claude link is a suggestion; Link accepts it', async () => {
    const pk = 'doi:10.1007/978-1-4757-0602-4_18';
    await api('/api/analysis', { method: 'POST', body: JSON.stringify({ collection: 'paper', key: pk, model: 'claude-test', links: [{ rel: 'FRAMED_BY', target: 'framework:two-sided-market-theory', confidence: 'low', evidence: 'a two-sided reading', location: 'p. 2' }] }) });
    await page.reload();
    await page.click('.tab[data-tab=connections]');
    const sug = '.connsuggest .suggestrow[data-key="framework:two-sided-market-theory"]';
    await page.waitForSelector(sug);
    expect(!(await page.$('.conntree .connrow[data-rel=FRAMED_BY]')), 'not in the diagram until accepted');
    await page.click(`${sug} button:has-text("Link")`);
    await page.waitForSelector('.conntree .connrow[data-rel=FRAMED_BY][data-key="framework:two-sided-market-theory"]');
    expect(!(await page.$(sug)), 'no longer a suggestion');
    const it = await api('/api/items/' + encodeURIComponent(pk));
    expect(it.links.out.find((l) => l.rel === 'FRAMED_BY').status === 'reviewed', 'accepted');
  });
  await step('an ontology page shows its modules and users', async () => {
    await page.goto(U + '/library/ontologies-and-standards');
    await page.click('.item:has-text("Financial Industry Business Ontology")');
    await page.click('article.doc .tab[data-tab=connections]');
    await page.waitForSelector('.connrow[data-rel=PART_OF][data-dir=in]');
    expect((await page.textContent('.connrow[data-rel=PART_OF][data-dir=in]')).includes('FIBO Foundations'), 'modules');
    expect((await page.textContent('.connrow[data-rel=USED_BY]')).includes('Offline retail payments'), 'users');
    await page.click('article.doc .tab[data-tab=info]');
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
