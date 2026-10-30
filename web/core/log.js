// Logging. One line per event. JSON in production (Cloud Logging reads `severity` and `message`), readable text locally.
const crypto = require('crypto');
const config = require('./config');

const SEVERITY = { info: 'INFO', warn: 'WARNING', error: 'ERROR' };

function write(level, message, fields = {}) {
  const line = config.get().logFormat === 'json'
    ? JSON.stringify({ severity: SEVERITY[level], message, ...fields })
    : `${level.toUpperCase().padEnd(5)} ${message}${Object.keys(fields).length ? ' ' + JSON.stringify(fields) : ''}`;
  (level === 'error' ? console.error : console.log)(line);
}

const info = (m, f) => write('info', m, f);
const warn = (m, f) => write('warn', m, f);
const error = (m, f) => write('error', m, f);

// Gives every request an id (Cloud Run's trace id when present) and logs one line when it finishes.
function requestLogger(req, res, next) {
  const trace = String(req.get('x-cloud-trace-context') || '').split('/')[0];
  req.id = trace || crypto.randomBytes(6).toString('hex');
  res.set('X-Request-Id', req.id);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const path = req.originalUrl.split('?')[0]; // never log the query string
    if (/\/healthz$|\/readyz$/.test(path) && res.statusCode < 400) return;
    const ms = Number((process.hrtime.bigint() - start) / 1000000n);
    write(res.statusCode >= 500 ? 'error' : 'info', `${req.method} ${path} ${res.statusCode}`, { id: req.id, ms });
  });
  next();
}

module.exports = { info, warn, error, requestLogger };
