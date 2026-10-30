// Wires the pieces together: config, then every folder in features/ (API), then the shell (UI) and its apps and skins.
// Everything is mounted under BASE_PATH (e.g. /research-hub) so it can live at santidesimone.com/research-hub.
// The same code runs locally and on Cloud Run; core/config.js is the only place that reads the environment.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');
const config = require('./core/config');
const log = require('./core/log');

const cfg = config.get();
const { errors, warnings } = config.problems(cfg);
warnings.forEach((w) => log.warn(w));
if (errors.length) { errors.forEach((e) => log.error(e)); log.error('Refusing to start in production with these problems.'); process.exit(1); }

const { BASE } = require('./core/env');
const registry = require('./core/registry');
const migrate = require('./core/migrate');
const shell = require('./core/shell');
const security = require('./core/security');
const { limiter } = require('./core/ratelimit');
const { run } = require('./core/db');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // behind Cloud Run / a proxy: real client IP and https detection
app.use(log.requestLogger);
app.use(security.headers);
app.use(compression({ filter: (req, res) => !/\/mcp(\/|$)/.test(req.originalUrl.split('?')[0]) && compression.filter(req, res) })); // MCP may stream

const root = express.Router();
root.get('/healthz', (_req, res) => res.json({ ok: true })); // liveness: the process is up
root.get('/readyz', async (_req, res) => { // readiness: the database answers
  try {
    await Promise.race([run('RETURN 1 AS ok'), new Promise((_, rej) => setTimeout(() => rej(new Error('database timeout')), 2000))]);
    res.json({ ok: true });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

root.use('/api', limiter({ max: cfg.rateLimitPerMin, name: 'requests' }));
root.use(['/api/query', '/mcp'], limiter({ max: cfg.heavyRateLimitPerMin, name: 'queries' }));
root.use(['/api', '/mcp'], (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

for (const dir of fs.readdirSync(path.join(__dirname, 'features')).sort()) {
  const file = path.join(__dirname, 'features', dir, 'index.js');
  if (!fs.existsSync(file)) continue;
  const feature = require(file);
  feature.mount(root);
  registry.features.push(feature.name || dir);
}

const noCache = { etag: true, maxAge: 0 };
root.use('/shell', express.static(path.join(__dirname, 'public', 'shell'), noCache));
root.use('/apps', express.static(path.join(__dirname, 'apps'), noCache));
root.use('/skins', express.static(path.join(__dirname, 'skins'), noCache));
root.use('/vendor', express.static(path.dirname(require.resolve('vis-network/standalone/umd/vis-network.min.js')), { maxAge: '7d' }));
root.get('/openapi.json', (_req, res) => res.sendFile(path.join(__dirname, 'openapi.json')));

// Any other GET under BASE is a page route handled in the browser (/research-hub/library?key=...): serve the shell.
root.get('*', (req, res, next) => {
  if (/^\/(api|mcp)(\/|$)/.test(req.path)) return next();
  const nonce = crypto.randomBytes(16).toString('base64');
  const page = shell.render(req, nonce);
  res.set('Cache-Control', 'private, no-store').set('Content-Security-Policy', security.csp(nonce, page.csp)).type('html').send(page.html);
});

root.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint' }));

app.use(BASE || '/', root);
app.use((err, req, res, _next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500);
  if (status === 500) log.error(err.stack || String(err), { id: req.id });
  res.status(status).json({ error: status === 500 && cfg.production ? 'Internal error' : err.message, ...(err.extra || {}), ...(status === 500 ? { request_id: req.id } : {}) });
});

function migrateWithRetry(attempt = 1) {
  migrate.run().catch((e) => {
    if (attempt === 1) log.warn('Waiting for Neo4j to run migrations: ' + e.message);
    setTimeout(() => migrateWithRetry(attempt + 1), 5000);
  });
}

const server = app.listen(cfg.port, cfg.host, () => {
  log.info(`Research Hub on http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}${BASE}/  features: ${registry.features.join(', ')}`);
  migrateWithRetry();
});

// Cloud Run sends SIGTERM before stopping an instance: finish in-flight requests, then close the database pool.
process.on('SIGTERM', () => {
  log.info('SIGTERM: shutting down');
  server.close(() => require('./core/db').driver.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 8000).unref();
});
