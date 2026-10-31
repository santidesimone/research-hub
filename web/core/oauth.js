// OAuth 2.1 for the MCP endpoint, so chat clients (the claude.ai connector) can connect without pasting the owner token.
// One owner: the owner approves a client once on the hub's own page, and the client gets an access token that only
// works for /mcp. Public clients with PKCE (S256) only; no client secrets.
//   client_id      stateless: the registered redirect URIs and name, signed (nothing stored per client)
//   code           random, single use, 5 minutes, stored (hashed) as (:OAuthCode)
//   refresh token  hub_rt.<grant>.<secret>; the grant is (:OAuthGrant) holding only a hash; rotated on every use, a reused
//                  old one revokes the grant; unused for 90 days it expires
//   access token   hub_at.<payload>.<mac>, 1 hour, valid only while its grant exists (revoking a connection is immediate)
// The signing key is derived from HUB_API_TOKEN: changing the token invalidates every client id and token.
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const ACCESS_SECONDS = 3600;
const CODE_SECONDS = 300;
const REFRESH_IDLE_DAYS = 90;
const SCOPE = 'mcp';

const key = () => crypto.createHash('sha256').update('hub-oauth:' + config.get().token).digest();
const mac = (s) => crypto.createHmac('sha256', key()).update(s).digest('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s) => { try { return JSON.parse(Buffer.from(s, 'base64url').toString()); } catch { return null; } };

// Signed blobs: <payload>.<mac>, optionally with a prefix
function seal(prefix, obj) { const p = b64(obj); return `${prefix}${p}.${mac(prefix + p)}`; }
function open(prefix, value) {
  const v = String(value || '');
  if (!config.get().token || !v.startsWith(prefix)) return null;
  const [p, m] = v.slice(prefix.length).split('.');
  if (!p || !m || !eq(m, mac(prefix + p))) return null;
  return unb64(p);
}

// Redirect URIs a client may register: the configured list (the claude.ai callbacks by default), and loopback addresses on
// any port, which only ever reach the owner's own machine (desktop clients, testing).
function redirectAllowed(uri) {
  let u; try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return true;
  return config.get().mcpOauthRedirects.includes(uri);
}

function registerClient({ redirect_uris: uris, client_name: name } = {}) {
  if (!Array.isArray(uris) || !uris.length || uris.length > 5) return { error: 'invalid_redirect_uri', error_description: 'redirect_uris: one to five URIs' };
  const bad = uris.find((u) => typeof u !== 'string' || !redirectAllowed(u));
  if (bad !== undefined) return { error: 'invalid_redirect_uri', error_description: `Not an allowed redirect URI: ${String(bad).slice(0, 200)} (MCP_OAUTH_REDIRECTS)` };
  const clientName = String(name || 'MCP client').slice(0, 80);
  const iat = Math.floor(Date.now() / 1000);
  return { client_id: seal('hub_c.', { r: uris, n: clientName, t: iat }), client_id_issued_at: iat, client_name: clientName, redirect_uris: uris,
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE };
}
// -> { redirect_uris, client_name } or null
function client(clientId) {
  const c = open('hub_c.', clientId);
  return c && Array.isArray(c.r) ? { redirect_uris: c.r, client_name: c.n } : null;
}

// PKCE S256: base64url(sha256(verifier)) == challenge; verifier 43 to 128 characters
const pkceOk = (verifier, challenge) => typeof verifier === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) && eq(sha(verifier), challenge || '');

/* ------------------------------------------------------------------ storage */
const neo4jStore = {
  async saveCode(hash, data, exp) {
    await db.exec('MATCH (c:OAuthCode) WHERE c.exp < $now DELETE c', { now: Date.now() });
    await db.exec('CREATE (:OAuthCode {hash:$hash, data_json:$data, exp:$exp})', { hash, data: JSON.stringify(data), exp });
  },
  async takeCode(hash) {
    const [r] = await db.exec('MATCH (c:OAuthCode {hash:$hash}) WITH c, c.data_json AS d, c.exp AS exp DELETE c RETURN d, exp', { hash });
    return r && r.exp > Date.now() ? JSON.parse(r.d) : null;
  },
  async createGrant(g) { await db.exec('CREATE (g:OAuthGrant) SET g = $g', { g }); },
  async getGrant(id) { const [r] = await db.run('MATCH (g:OAuthGrant {id:$id}) RETURN properties(g) AS g', { id }); return r ? r.g : null; },
  async rotate(id, oldHash, newHash, now) {
    const [r] = await db.exec('MATCH (g:OAuthGrant {id:$id, refresh_hash:$old}) SET g.refresh_hash = $new, g.last_used_at = $now RETURN count(g) AS n', { id, old: oldHash, new: newHash, now });
    return Boolean(r && r.n);
  },
  async list() { return (await db.run('MATCH (g:OAuthGrant) RETURN g.id AS id, g.client_name AS client_name, g.created_at AS created_at, g.last_used_at AS last_used_at ORDER BY g.created_at')); },
  async revoke(id) { const [r] = await db.exec('MATCH (g:OAuthGrant {id:$id}) DELETE g RETURN count(*) AS n', { id }); return Boolean(r && r.n); },
  async revokeAll() { const [r] = await db.exec('MATCH (g:OAuthGrant) DELETE g RETURN count(*) AS n'); return r ? r.n : 0; },
};
function memoryStore() {
  const codes = new Map(); const grants = new Map();
  return {
    codes, grants,
    async saveCode(hash, data, exp) { codes.set(hash, { data, exp }); },
    async takeCode(hash) { const c = codes.get(hash); codes.delete(hash); return c && c.exp > Date.now() ? c.data : null; },
    async createGrant(g) { grants.set(g.id, { ...g }); },
    async getGrant(id) { return grants.has(id) ? { ...grants.get(id) } : null; },
    async rotate(id, oldHash, newHash, now) { const g = grants.get(id); if (!g || g.refresh_hash !== oldHash) return false; g.refresh_hash = newHash; g.last_used_at = now; return true; },
    async list() { return [...grants.values()].map(({ id, client_name, created_at, last_used_at }) => ({ id, client_name, created_at, last_used_at })); },
    async revoke(id) { return grants.delete(id); },
    async revokeAll() { const n = grants.size; grants.clear(); return n; },
  };
}
let store = neo4jStore;
const useStore = (s) => { store = s || neo4jStore; };

/* ------------------------------------------------------------------ the flow */
// The owner approved: a single-use code bound to the client, redirect URI, PKCE challenge and resource.
async function issueCode({ client_id, redirect_uri, code_challenge, resource }) {
  const code = rand();
  await store.saveCode(sha(code), { client_id, redirect_uri, code_challenge, resource: resource || null }, Date.now() + CODE_SECONDS * 1000);
  return code;
}

function accessToken(grantId) {
  return seal('hub_at.', { g: grantId, exp: Math.floor(Date.now() / 1000) + ACCESS_SECONDS });
}
const tokenResponse = (grantId, refresh) => ({ access_token: accessToken(grantId), token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: SCOPE });
const err = (error, error_description) => ({ error, error_description });

// POST /oauth/token. -> { status, body }
async function exchange(p = {}) {
  if (p.grant_type === 'authorization_code') {
    const c = client(p.client_id);
    if (!c) return { status: 401, body: err('invalid_client', 'Unknown client_id (register again)') };
    const data = p.code ? await store.takeCode(sha(p.code)) : null; // taken even when the rest fails: a code is tried once
    if (!data) return { status: 400, body: err('invalid_grant', 'The code is invalid, expired or already used') };
    if (data.client_id !== p.client_id || data.redirect_uri !== p.redirect_uri) return { status: 400, body: err('invalid_grant', 'client_id or redirect_uri do not match the authorization request') };
    if (!pkceOk(p.code_verifier, data.code_challenge)) return { status: 400, body: err('invalid_grant', 'PKCE verification failed') };
    const id = rand(16); const secret = rand();
    const now = new Date().toISOString();
    await store.createGrant({ id, refresh_hash: sha(secret), client_id: sha(p.client_id), client_name: c.client_name, created_at: now, last_used_at: now });
    return { status: 200, body: tokenResponse(id, `hub_rt.${id}.${secret}`) };
  }
  if (p.grant_type === 'refresh_token') {
    const [pre, id, secret] = String(p.refresh_token || '').split('.');
    const g = pre === 'hub_rt' && id && secret ? await store.getGrant(id) : null;
    if (!g) return { status: 400, body: err('invalid_grant', 'Unknown or revoked refresh token') };
    if (p.client_id && sha(p.client_id) !== g.client_id) return { status: 400, body: err('invalid_grant', 'The refresh token belongs to another client') };
    if (!eq(sha(secret), g.refresh_hash)) { await store.revoke(id); return { status: 400, body: err('invalid_grant', 'Refresh token reused: the connection was revoked, connect again') }; }
    if (Date.now() - Date.parse(g.last_used_at) > REFRESH_IDLE_DAYS * 864e5) { await store.revoke(id); return { status: 400, body: err('invalid_grant', 'The connection expired after 90 days unused, connect again') }; }
    const next = rand();
    if (!(await store.rotate(id, g.refresh_hash, sha(next), new Date().toISOString()))) return { status: 400, body: err('invalid_grant', 'Refresh token already used') };
    return { status: 200, body: tokenResponse(id, `hub_rt.${id}.${next}`) };
  }
  return { status: 400, body: err('unsupported_grant_type', 'Use authorization_code or refresh_token') };
}

// Bearer hub_at.… on /mcp -> true when signed, unexpired and its grant still exists
async function verifyAccess(value) {
  const t = open('hub_at.', value);
  if (!t || !t.g || !(t.exp * 1000 > Date.now())) return false;
  return Boolean(await store.getGrant(t.g));
}
const isAccessToken = (value) => String(value || '').startsWith('hub_at.');

// The hub's public address with its base path, as clients see it: PUBLIC_URL, else the request's scheme and host
// (behind Cloud Run, TRUST_PROXY makes req.protocol https).
const { BASE } = require('./env');
const baseUrl = (req) => (config.get().publicUrl || `${req.protocol}://${req.get('host')}`) + BASE;

// Signed, short-lived copy of the authorization request, carried by the approval form (it cannot be altered in between)
const sealRequest = (params) => seal('hub_ar.', { ...params, exp: Date.now() + 10 * 60 * 1000 });
function openRequest(value) { const r = open('hub_ar.', value); return r && r.exp > Date.now() ? r : null; }

module.exports = {
  baseUrl,
  SCOPE, ACCESS_SECONDS, registerClient, client, redirectAllowed, pkceOk, issueCode, exchange, verifyAccess, isAccessToken,
  sealRequest, openRequest, sha, useStore, memoryStore,
  list: () => store.list(), revoke: (id) => store.revoke(id), revokeAll: () => store.revokeAll(),
};
