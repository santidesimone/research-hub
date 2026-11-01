// Offline tests for the relay: a fake hub on an ephemeral port, the relay in front of it with a stub token. Run: node test.js
const assert = require('assert');
const http = require('http');
const { createRelay, clientIp, allowed } = require('./relay');

const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
const close = (server) => new Promise((ok) => server.close(ok));

(async () => {
  assert.equal(clientIp('6.6.6.6, 1.2.3.4, 35.1.1.1', 2), '1.2.3.4');
  assert.equal(clientIp('1.2.3.4', 2), '');
  assert.ok(allowed('/research-hub', '/research-hub') && allowed('/research-hub/mcp', '/research-hub') && allowed('/research-hub?x=1', '/research-hub'));
  assert.ok(allowed('/.well-known/oauth-authorization-server/research-hub', '/research-hub'));
  assert.ok(!allowed('/research-hubx', '/research-hub') && !allowed('/', '/research-hub') && !allowed('/.well-known/other', '/research-hub'));

  const seen = [];
  const hub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url.startsWith('/research-hub/go')) { res.writeHead(302, { Location: '/research-hub/library', 'Set-Cookie': '__session=abc; HttpOnly' }).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' }).end('hub:' + req.url);
    });
  });
  const hubPort = await listen(hub);
  let tokenFails = false;
  const relay = createRelay({ hubUrl: `http://127.0.0.1:${hubPort}`, clientHops: 2, getToken: async () => { if (tokenFails) throw new Error('no'); return 'IDTOKEN'; } });
  const port = await listen(relay);
  const base = `http://127.0.0.1:${port}`;

  // path, query and headers: the hub's own Authorization passes through, the ID token goes in X-Serverless-Authorization
  let r = await fetch(base + '/research-hub/healthz?a=1&b=2', { headers: {
    Authorization: 'Bearer owner', Cookie: '__session=s', 'X-Forwarded-For': '6.6.6.6, 1.2.3.4, 35.1.1.1', 'X-Forwarded-Host': 'santidesimone.com',
    'X-Serverless-Authorization': 'Bearer forged' } });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'hub:/research-hub/healthz?a=1&b=2');
  let h = seen.at(-1).headers;
  assert.equal(h.authorization, 'Bearer owner');
  assert.equal(h['x-serverless-authorization'], 'Bearer IDTOKEN', 'a client cannot supply its own ID token');
  assert.equal(h.cookie, '__session=s');
  assert.equal(h['x-forwarded-for'], '1.2.3.4', 'only the visitor address the front proxies saw, not what the client wrote');
  assert.equal(h['x-forwarded-host'], 'santidesimone.com');
  assert.equal(h['x-forwarded-proto'], 'https');
  assert.equal(h.host, `127.0.0.1:${hubPort}`);

  // a body (an upload) arrives intact
  const body = Buffer.alloc(1024 * 1024 + 7, 0x25);
  r = await fetch(base + '/research-hub/api/papers/file?key=k', { method: 'POST', body, headers: { 'Content-Type': 'application/pdf' } });
  assert.equal(r.status, 200);
  assert.ok(seen.at(-1).body.equals(body));
  assert.equal(seen.at(-1).headers['content-type'], 'application/pdf');

  // redirects and cookies are passed back, not followed
  r = await fetch(base + '/research-hub/go', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/research-hub/library');
  assert.equal(r.headers.get('set-cookie'), '__session=abc; HttpOnly');

  // OAuth discovery at the domain root goes through; anything else is refused without reaching the hub
  r = await fetch(base + '/.well-known/oauth-protected-resource/research-hub/mcp');
  assert.equal(r.status, 200);
  const n = seen.length;
  for (const p of ['/', '/index.html', '/research-hubx', '/.well-known/acme']) assert.equal((await fetch(base + p)).status, 404, p);
  assert.equal(seen.length, n);
  assert.equal((await fetch(base + '/relay-healthz')).status, 200);

  // no token, or the hub unreachable: 502
  tokenFails = true;
  const quiet = console.error; console.error = () => {};
  assert.equal((await fetch(base + '/research-hub/x')).status, 502);
  tokenFails = false;
  await close(hub);
  assert.equal((await fetch(base + '/research-hub/x')).status, 502);
  console.error = quiet;

  await close(relay);
  console.log('site-relay: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
