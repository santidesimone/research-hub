// OAuth endpoints for the MCP connector (core/oauth.js has the rules). A chat client (the claude.ai connector) finds them
// from the 401 that /mcp returns, registers itself, sends the owner to the approval page below, and exchanges the code.
//   /.well-known/oauth-protected-resource[<base>/mcp]   which authorization server protects /mcp
//   /.well-known/oauth-authorization-server[<base>]     the endpoints (also at <base>/.well-known/... and openid-configuration)
//   POST <base>/oauth/register     dynamic client registration (redirect URIs from an allow-list)
//   GET  <base>/oauth/authorize    the owner approves (signed in, or typing the owner token); PKCE S256 required
//   POST <base>/oauth/token        code or refresh token -> tokens (the access token only works for /mcp)
//   GET/DELETE <base>/api/oauth/grants   the owner lists and revokes connections
// The well-known paths sit at the domain root: behind a site proxy they need their own rewrite (deploy/README.md).
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { BASE } = require('../../core/env');
const config = require('../../core/config');
const oauth = require('../../core/oauth');
const security = require('../../core/security');
const { requireOwner, isOwner, checkToken } = require('../../core/auth');
const { limiter } = require('../../core/ratelimit');
const { HttpError } = require('../../core/errors');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
// Discovery, registration and the token endpoint may be called from a browser-based MCP client (no cookies involved).
const cors = (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*').set('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version').set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
};

const resourceUrl = (req) => oauth.baseUrl(req) + '/mcp';
const resourceMetadataUrl = (req) => `${config.get().publicUrl || `${req.protocol}://${req.get('host')}`}/.well-known/oauth-protected-resource${BASE}/mcp`;

function serverMetadata(req) {
  const issuer = oauth.baseUrl(req);
  return {
    issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], scopes_supported: [oauth.SCOPE],
  };
}
const resourceMetadata = (req) => ({ resource: resourceUrl(req), authorization_servers: [oauth.baseUrl(req)], bearer_methods_supported: ['header'], scopes_supported: [oauth.SCOPE], resource_name: 'Research Hub' });

// A resource indicator, when sent, must name this hub's MCP endpoint (with or without a trailing slash)
const resourceOk = (req, r) => !r || String(r).replace(/\/+$/, '') === resourceUrl(req) || String(r).replace(/\/+$/, '') === oauth.baseUrl(req);

function redirectTo(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

/* ------------------------------------------------------------------ the approval page (no scripts) */
const skinNames = () => fs.readdirSync(path.join(__dirname, '../../skins'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
function page(req, res, { status = 200, title, body, redirectOrigin }) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const skin = skinNames().includes(config.get().skin) ? config.get().skin : 'paper';
  // the approval form redirects to the client: Chrome checks form-action on that redirect too
  const csp = security.csp(nonce).replace("form-action 'self'", `form-action 'self'${redirectOrigin ? ' ' + redirectOrigin : ''}`);
  res.status(status).set('Cache-Control', 'no-store').set('Content-Security-Policy', csp).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Research Hub</title>
<link rel="stylesheet" href="${BASE}/skins/${skin}/skin.css"><link rel="stylesheet" href="${BASE}/shell/base.css">
<style>body{display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}.card{max-width:440px;width:100%}.card h1{font-size:20px;margin:0 0 12px}.card p{margin:0 0 12px;line-height:1.5}.row-flex{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.oauth-error{color:var(--danger, var(--warn))}</style>
</head><body><main class="card">${body}</main></body></html>`);
}
const errorPage = (req, res, status, message) => page(req, res, { status, title: 'Cannot connect', body: `<h1>Cannot connect</h1><p>${esc(message)}</p><p class="faint">Start the connection again from your MCP client.</p>` });

function approvalBody(req, r, { signedIn, error } = {}) {
  const client = oauth.client(r.client_id);
  const target = new URL(r.redirect_uri);
  return `<h1>Connect to your Research Hub?</h1>
<p><strong>${esc(client.client_name)}</strong> wants to use your hub through MCP: read and search everything, and add or change items, links and files.</p>
<p class="faint">It returns to <code>${esc(target.origin)}</code>. You can revoke it any time with <code>hub oauth revoke</code>.</p>
${error ? `<p class="oauth-error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="${BASE}/oauth/authorize">
<input type="hidden" name="req" value="${esc(oauth.sealRequest(r))}">
${signedIn ? '<p class="faint">You are signed in as the owner.</p>' : '<label for="owner_token">Owner token</label><input class="input" id="owner_token" name="owner_token" type="password" autocomplete="current-password" required autofocus>'}
<div class="row-flex"><button class="btn btn-primary" name="decision" value="allow" type="submit">Allow</button>
<button class="btn" name="decision" value="deny" type="submit" formnovalidate>Deny</button></div>
</form>`;
}

module.exports = {
  name: 'oauth',
  resourceMetadataUrl,
  // routes outside BASE: the well-known documents live at the domain root
  mountRoot(app) {
    const uniq = (xs) => [...new Set(xs)];
    app.all(uniq([`/.well-known/oauth-protected-resource${BASE}/mcp`, `/.well-known/oauth-protected-resource${BASE}`, '/.well-known/oauth-protected-resource', `${BASE}/.well-known/oauth-protected-resource`]),
      cors, (req, res) => res.json(resourceMetadata(req)));
    app.all(uniq([`/.well-known/oauth-authorization-server${BASE}`, '/.well-known/oauth-authorization-server', `${BASE}/.well-known/oauth-authorization-server`,
      `/.well-known/openid-configuration${BASE}`, '/.well-known/openid-configuration', `${BASE}/.well-known/openid-configuration`]),
    cors, (req, res) => res.json(serverMetadata(req)));
  },
  mount(app) {
    app.use('/oauth', limiter({ max: 60, name: 'OAuth requests' }), noStore);
    app.all('/oauth/register', cors);
    app.post('/oauth/register', express.json({ limit: '10kb' }), (req, res) => {
      const out = oauth.registerClient(req.body || {});
      res.status(out.error ? 400 : 201).json(out);
    });

    app.get('/oauth/authorize', (req, res) => {
      const q = req.query;
      const client = oauth.client(q.client_id);
      if (!client) return errorPage(req, res, 400, 'Unknown client. Your MCP client should register again.');
      if (typeof q.redirect_uri !== 'string' || !client.redirect_uris.includes(q.redirect_uri) || !oauth.redirectAllowed(q.redirect_uri)) return errorPage(req, res, 400, 'The redirect address is not one this client registered.');
      const back = (error, description) => res.redirect(302, redirectTo(q.redirect_uri, { error, error_description: description, state: q.state }));
      if (q.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code');
      if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE with S256 is required');
      if (!resourceOk(req, q.resource)) return back('invalid_target', 'This server only issues tokens for ' + resourceUrl(req));
      const r = { client_id: q.client_id, redirect_uri: q.redirect_uri, code_challenge: String(q.code_challenge), state: q.state != null ? String(q.state) : null, resource: q.resource || null };
      page(req, res, { title: 'Connect', body: approvalBody(req, r, { signedIn: isOwner(req) }), redirectOrigin: new URL(q.redirect_uri).origin });
    });

    app.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '20kb' }), wrap(async (req, res) => {
      const b = req.body || {};
      const r = oauth.openRequest(b.req);
      if (!r || !oauth.client(r.client_id)) return errorPage(req, res, 400, 'This approval page expired.');
      const origin = new URL(r.redirect_uri).origin;
      if (b.decision !== 'allow') return res.redirect(302, redirectTo(r.redirect_uri, { error: 'access_denied', state: r.state }));
      const signedIn = isOwner(req);
      if (!signedIn) {
        const bad = checkToken(req.ip, b.owner_token);
        if (bad) return page(req, res, { status: bad.status, title: 'Connect', body: approvalBody(req, r, { error: bad.error }), redirectOrigin: origin });
      }
      const code = await oauth.issueCode(r);
      res.redirect(302, redirectTo(r.redirect_uri, { code, state: r.state, iss: oauth.baseUrl(req) }));
    }));

    app.all('/oauth/token', cors);
    app.post('/oauth/token', express.urlencoded({ extended: false, limit: '10kb' }), express.json({ limit: '10kb' }), wrap(async (req, res) => {
      const { status, body } = await oauth.exchange(req.body || {});
      res.status(status).set('Pragma', 'no-cache').json(body);
    }));

    app.get('/api/oauth/grants', requireOwner, wrap(async (_req, res) => res.json({ connections: await oauth.list() })));
    app.delete('/api/oauth/grants', requireOwner, wrap(async (req, res) => {
      if (req.query.all === '1') return res.json({ revoked: await oauth.revokeAll() });
      if (!req.query.id) throw new HttpError(400, 'Pass ?id=<connection id> or ?all=1');
      if (!(await oauth.revoke(String(req.query.id)))) throw new HttpError(404, 'No such connection');
      res.json({ revoked: 1 });
    }));
  },
};
