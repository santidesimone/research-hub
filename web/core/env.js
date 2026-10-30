// Loads <project>/.env (the same file the ingest script reads) and exposes shared paths.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* no .env */ }
// Where the app is mounted, e.g. BASE_PATH=/research-hub when served at santidesimone.com/research-hub ('' = at the root).
let BASE = (process.env.BASE_PATH || '').trim();
if (BASE && !BASE.startsWith('/')) BASE = '/' + BASE;
BASE = BASE.replace(/\/+$/, '');

module.exports = { ROOT, BASE, CONTENT_DIR: path.resolve(process.env.CONTENT_DIR || path.join(ROOT, 'content')) };
