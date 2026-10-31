// The real CLI (bin/hub) against a running hub on a THROWAWAY database: HUB_URL=... HUB_API_TOKEN=... node test/cli-e2e.js
// Creates its own items (unique names), checks every new command end to end, and removes what it created.
const assert = require('assert');
const path = require('path');
const { execFile } = require('child_process');

if (!process.env.HUB_URL || !process.env.HUB_API_TOKEN) { console.error('Set HUB_URL and HUB_API_TOKEN (a throwaway hub).'); process.exit(2); }
const HUB = path.join(__dirname, '..', '..', 'bin', 'hub');
const hub = (args, input = '') => new Promise((resolve) => {
  const child = execFile(process.execPath, [HUB, ...args], { env: { ...process.env, HUB_MODEL: '' } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  child.stdin.end(input);
});
const ok = async (args, input) => { const r = await hub(args, input); assert.equal(r.code, 0, `hub ${args.join(' ')}: ${r.stderr}`); return r; };
const json = async (args, input) => JSON.parse((await ok(args, input)).stdout);

(async () => {
  const tag = 'cli' + Date.now().toString(36);
  assert.ok((await ok(['schema', 'methods'])).stdout.includes('when_to_use'));

  const m = await json(['item', 'add', 'method', '-'], JSON.stringify({ title: `CLI method ${tag}`, kind: 'technique', domain: ['research methodology'] }));
  const u = await json(['item', 'add', 'use_case', '-', '--set', `title=CLI use case ${tag}`, '--set', 'status=idea']);
  assert.ok(m.created && u.created);
  const listed = await json(['item', 'list', 'method', '--q', tag, '--domain', 'research methodology', '--json']);
  assert.deepEqual(listed.items.map((x) => x.key), [m.key], 'listed with a full-text query and a vocabulary filter');
  assert.ok((await ok(['item', 'list', 'method', '--q', tag])).stdout.includes('research methodology'));

  await json(['item', 'edit', m.key, '--set', 'purpose=Find everything', '--set', 'level=intermediate']);
  let it = await json(['item', 'get', m.key, '--json']);
  assert.deepEqual([it.fields.purpose, it.fields.level, it.provenance.purpose.by], ['Find everything', 'intermediate', 'owner']);
  assert.ok((await ok(['item', 'get', m.key])).stdout.includes('purpose: Find everything [you]'));

  await json(['item', 'link', m.key, 'ADDRESSES', u.key, '--evidence', 'it does', '--confidence', 'high']);
  it = await json(['item', 'get', u.key, '--json']);
  assert.ok(it.links.in.some((l) => l.rel === 'ADDRESSES' && l.key === m.key && l.evidence === 'it does'));
  await json(['item', 'unlink', m.key, 'ADDRESSES', u.key]);

  // Claude's analysis through the CLI: the owner's purpose survives, empty fields fill, low confidence lands in the audit
  const an = await json(['analyze', m.key, '--model', 'cli-model'], JSON.stringify({ fields: { purpose: 'claude purpose', when_to_use: 'claude when', example: 'claude example' }, confidence: { when_to_use: 'low' } }));
  assert.deepEqual(an.skipped, [{ field: 'purpose', reason: 'owner value' }]); assert.deepEqual(an.filled.sort(), ['example', 'when_to_use']);
  const audit = await json(['audit', '--json']);
  assert.ok(audit.low_confidence.some((x) => x.key === m.key && x.field === 'when_to_use'));
  const dry = await json(['audit', '--accept-all-unchanged', '--dry-run']);
  assert.deepEqual([dry.accepted[m.key], dry.skipped[m.key]], [['example'], ['when_to_use (low confidence)']]);
  assert.equal((await json(['item', 'get', m.key, '--json'])).provenance.example.status, 'auto', 'a dry run accepts nothing');
  await json(['audit', '--accept-all-unchanged']);
  it = await json(['item', 'get', m.key, '--json']);
  assert.deepEqual([it.provenance.example.status, it.provenance.when_to_use.status], ['reviewed', 'auto']);

  assert.equal((await hub(['item', 'rm', m.key])).code, 1, 'rm refuses without --yes');
  for (const k of [m.key, u.key]) await json(['item', 'rm', k, '--yes']);
  assert.equal((await hub(['item', 'get', m.key])).code, 1);
  console.log('cli e2e passed');
})().catch((e) => { console.error(e); process.exit(1); });
