// One owner (you). Two ways in, both proving knowledge of HUB_API_TOKEN:
//   * Authorization: Bearer <token>        scripts, the CLI, the MCP connector
//   * a signed session cookie from /api/login   the web UI (cookie is named __session: the only one Firebase Hosting forwards)
// Anonymous visitors only ever get the public preview.
const crypto = require('crypto');
const { BASE } = require('./env');
const config = require('./config');

const COOKIE = '__session';
const DAYS = 30;

const token = () => config.get().token;
const key = () => crypto.createHash('sha256').update('hub-session:' + token()).digest();
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function sign(expMs) {
  const p = String(expMs);
  return `${p}.${crypto.createHmac('sha256', key()).update(p).digest('base64url')}`;
}
function verify(value) {
  const [p, mac] = String(value || '').split('.');
  if (!p || !mac || !token()) return false;
  const good = crypto.createHmac('sha256', key()).update(p).digest('base64url');
  return eq(mac, good) && Number(p) > Date.now();
}
function cookieValue(req) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : '';
}
function bearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

// 'token' | 'cookie' | null
function how(req) {
  if (!token()) return null;
  const b = bearer(req);
  if (b && eq(b, token())) return 'token';
  if (verify(cookieValue(req))) return 'cookie';
  return null;
}
const isOwner = (req) => how(req) !== null;

function requireOwner(req, res, next) {
  if (!token()) return res.status(503).json({ error: 'Set HUB_API_TOKEN on the server first.' });
  const kind = how(req);
  if (!kind) return res.status(401).json({ error: 'Sign in required (Bearer token or session).' });
  // Cookie-authenticated changes must carry a custom header, which other sites cannot send (CSRF guard).
  if (kind === 'cookie' && !['GET', 'HEAD'].includes(req.method) && req.get('x-hub') !== '1') {
    return res.status(403).json({ error: 'Missing X-Hub header.' });
  }
  next();
}

const fails = new Map(); // ip -> timestamps of failed logins
// The owner token typed into a form (sign-in, the OAuth approval page), with a limit on failed attempts per address.
// -> null when it is right, else { status, error }
function checkToken(ip, value) {
  const recent = (fails.get(ip) || []).filter((t) => Date.now() - t < 10 * 60 * 1000);
  if (recent.length >= 10) return { status: 429, error: 'Too many attempts. Try again in a few minutes.' };
  if (!token()) return { status: 503, error: 'Set HUB_API_TOKEN on the server first.' };
  if (!eq(value || '', token())) { fails.set(ip, [...recent, Date.now()]); return { status: 401, error: 'Wrong token.' }; }
  return null;
}

function login(req, res) {
  const bad = checkToken(req.ip, req.body && req.body.token);
  if (bad) return res.status(bad.status).json({ error: bad.error });
  const exp = Date.now() + DAYS * 864e5;
  res.cookie(COOKIE, sign(exp), { httpOnly: true, sameSite: 'lax', secure: req.secure, path: BASE || '/', maxAge: DAYS * 864e5 });
  res.json({ owner: true });
}
function logout(req, res) {
  res.clearCookie(COOKIE, { path: BASE || '/' });
  res.json({ owner: false });
}

module.exports = { requireOwner, isOwner, login, logout, sign, verify, checkToken, bearer };
