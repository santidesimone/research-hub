// Security headers. Every response gets the basics; the HTML shell also gets a Content-Security-Policy with a per-request
// nonce, so only the page's own scripts run (a note containing <script> or an onerror= handler cannot execute).
const SKIN_HOSTS_STYLE = ['https://fonts.googleapis.com'];
const SKIN_HOSTS_FONT = ['https://fonts.gstatic.com'];

function headers(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000'); // 180 days, only ever sent over https
  next();
}

// extra: { style: [origins], font: [origins] } a skin may declare in skin.json under "csp".
function csp(nonce, extra = {}) {
  const join = (...parts) => parts.flat().filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src ${join("'self'", "'unsafe-inline'", SKIN_HOSTS_STYLE, extra.style)}`,
    `font-src ${join("'self'", 'data:', SKIN_HOSTS_FONT, extra.font)}`,
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    'frame-src https:', // the Reader embeds Google Drive previews (and any https link the owner chooses to try)
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

module.exports = { headers, csp };
