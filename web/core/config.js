// One place that reads the environment. The same code runs on your laptop and on Cloud Run; only these variables differ.
//   local       NODE_ENV unset. Forgiving: problems are warnings, pretty logs, listens on 127.0.0.1.
//   production  NODE_ENV=production (the Dockerfile sets it). Strict: a weak or missing token or a default database
//               password stops the server at start-up instead of running insecurely on the internet.
const { BASE } = require('./env');

const DEFAULT_NEO4J_PASSWORD = 'hubpassword';
const MIN_TOKEN_LENGTH = 24;
const GOOGLE_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];

function get(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const num = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback);
  const google = GOOGLE_VARS.filter((k) => env[k]);
  return {
    production,
    base: BASE,
    port: num(env.PORT, 3000),
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    token: env.HUB_API_TOKEN || '',
    neo4j: {
      uri: env.NEO4J_URI || 'bolt://localhost:7687',
      user: env.NEO4J_USER || 'neo4j',
      password: env.NEO4J_PASSWORD || DEFAULT_NEO4J_PASSWORD,
      poolSize: num(env.NEO4J_POOL_SIZE, 20),
    },
    drive: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      refreshToken: env.GOOGLE_REFRESH_TOKEN || '',
      configured: google.length === GOOGLE_VARS.length,
      partial: google.length > 0 && google.length < GOOGLE_VARS.length,
    },
    rateLimitPerMin: num(env.RATE_LIMIT_PER_MIN, 600),
    heavyRateLimitPerMin: num(env.HEAVY_RATE_LIMIT_PER_MIN, 120), // /api/query and /mcp
    maxUploadBytes: num(env.MAX_UPLOAD_MB, 30) * 1024 * 1024, // Cloud Run rejects request bodies over 32 MB
    publicCacheSeconds: num(env.PUBLIC_CACHE_SECONDS, 60),
    logFormat: env.LOG_FORMAT || (production ? 'json' : 'pretty'),
  };
}

// { errors, warnings }. In production the "errors" stop the server; locally they are only warnings.
function problems(cfg = get()) {
  const errors = [];
  const warnings = [];
  const strict = (msg) => (cfg.production ? errors : warnings).push(msg);
  if (!cfg.token) strict('HUB_API_TOKEN is not set: private pages and every write are disabled.');
  else if (cfg.token.length < MIN_TOKEN_LENGTH) strict(`HUB_API_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters. Generate one with: openssl rand -hex 32`);
  if (cfg.production && cfg.neo4j.password === DEFAULT_NEO4J_PASSWORD) errors.push('NEO4J_PASSWORD is the default. Set a real password.'); // fine on your laptop, never on the internet
  if (cfg.drive.partial) strict(`Google Drive is half configured: set all of ${GOOGLE_VARS.join(', ')} or none of them.`);
  if (!cfg.drive.configured && !cfg.drive.partial) warnings.push('Google Drive is not configured: papers can store links, but uploading PDFs is off (see deploy/README.md).');
  return { errors, warnings };
}

module.exports = { get, problems, MIN_TOKEN_LENGTH };
