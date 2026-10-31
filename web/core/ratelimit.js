// Small in-memory rate limiter (per process). Enough to blunt brute force and runaway scripts on a personal deployment;
// with several Cloud Run instances each keeps its own count, so the effective limit is per instance.
function limiter({ windowMs = 60000, max = 600, name = 'requests' } = {}) {
  const hits = new Map(); // key -> { count, reset }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = req.ip;
    let h = hits.get(key);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + windowMs }; hits.set(key, h); }
    h.count++;
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - h.count)));
    if (h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: `Too many ${name}. Slow down and retry shortly.` });
    }
    next();
  };
}

// Endpoints that cost real work (database scans, outside services, bulk writes) share the smaller "heavy" budget.
const HEAVY = ['/api/query', '/mcp', '/api/analysis', '/api/audit', '/api/backup', '/api/restore', '/api/import', '/api/export', '/api/enrich', '/api/notes/sync'];

module.exports = { limiter, HEAVY };
