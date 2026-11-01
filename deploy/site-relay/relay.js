// Relay for santidesimone.com/research-hub. Firebase Hosting can only rewrite to a Cloud Run service in its own project,
// so this small service runs in the site's project and forwards each request, unchanged, to the hub's Cloud Run service
// in the hub's project. The hub is private (Cloud Run IAM): every request carries this service's ID token in
// X-Serverless-Authorization, which Cloud Run checks and strips, leaving the hub's own Authorization header untouched.
// No dependencies. Bodies and responses are streamed (PDF uploads, MCP streams).
const http = require('http');
const https = require('https');

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'x-serverless-authorization', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);

// Only the hub's own paths go through: the app under its base path, and the OAuth discovery documents at the domain root.
const allowed = (path, base) => [base, `/.well-known/oauth-protected-resource${base}`, `/.well-known/oauth-authorization-server${base}`]
  .some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'));

// The visitor's address, `hops` entries from the right of the X-Forwarded-For this service received (what the proxies
// in front added; anything further left could be written by the client). The hub then sees "<visitor>, <this relay>".
function clientIp(xff, hops) {
  const parts = String(xff || '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length >= hops ? parts[parts.length - hops] : '';
}

// ID token for the hub (audience = its URL) from the metadata server, cached until shortly before it expires.
function metadataToken(audience) {
  let cached = { value: '', exp: 0 };
  return async () => {
    if (cached.value && Date.now() < cached.exp) return cached.value;
    const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience='
      + encodeURIComponent(audience), { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) throw new Error(`metadata server: HTTP ${res.status}`);
    cached = { value: await res.text(), exp: Date.now() + 45 * 60 * 1000 }; // tokens last 1 hour
    return cached.value;
  };
}

function createRelay({ hubUrl, basePath = '/research-hub', clientHops = 1, getToken, log = () => {} }) {
  const hub = new URL(hubUrl);
  const lib = hub.protocol === 'https:' ? https : http;
  return http.createServer(async (req, res) => {
    const path = req.url || '/';
    if (path === '/relay-healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'); return; }
    if (!allowed(path, basePath)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    log({ path: path.split('?')[0], xff: req.headers['x-forwarded-for'] });
    let token;
    try { token = await getToken(); } catch (e) {
      console.error('relay: no ID token:', e.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end('Bad gateway'); return;
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    const ip = clientIp(req.headers['x-forwarded-for'], clientHops);
    if (ip) headers['x-forwarded-for'] = ip;
    headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host || '';
    headers['x-forwarded-proto'] = 'https';
    headers['x-serverless-authorization'] = `Bearer ${token}`;
    headers.host = hub.host;
    const up = lib.request({ protocol: hub.protocol, hostname: hub.hostname, port: hub.port, method: req.method, path, headers }, (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
      res.writeHead(r.statusCode, out);
      r.pipe(res);
    });
    up.on('error', (e) => {
      console.error('relay: upstream error:', e.message);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }).end('Bad gateway'); else res.destroy();
    });
    req.pipe(up);
  });
}

if (require.main === module) {
  const hubUrl = (process.env.HUB_URL || '').replace(/\/+$/, '');
  if (!hubUrl) { console.error('Set HUB_URL (the hub\'s run.app URL).'); process.exit(1); }
  const server = createRelay({
    hubUrl, basePath: process.env.BASE_PATH || '/research-hub', clientHops: Number(process.env.CLIENT_HOPS) || 1,
    getToken: metadataToken(hubUrl), log: process.env.LOG_XFF === '1' ? (e) => console.log(JSON.stringify(e)) : undefined,
  });
  server.listen(Number(process.env.PORT) || 8080, () => console.log(`relay -> ${hubUrl}`));
}

module.exports = { createRelay, clientIp, allowed };
