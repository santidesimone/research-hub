// Understands where a file link points. Pure functions, no I/O: used by the API, the MCP tools and the Drive module.
// A link is stored exactly as the owner gave it, except that every Google Drive form is rewritten to the canonical
// https://drive.google.com/file/d/<id>/view so the same file never appears under two different URLs.
const { HttpError } = require('./errors');

const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com']);
const ID_RE = /^[A-Za-z0-9_-]{10,}$/;
const MAX_URL = 2000;

function driveId(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!DRIVE_HOSTS.has(u.hostname)) return null;
  const m = /^\/file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/.exec(u.pathname);
  if (m && ID_RE.test(m[1])) return m[1];
  const id = u.searchParams.get('id');
  if (id && ID_RE.test(id) && ['/open', '/uc'].includes(u.pathname)) return id;
  return null;
}

const driveView = (id) => `https://drive.google.com/file/d/${id}/view`;

// Validate and canonicalise a link before it is stored. Only https links are accepted.
function normalize(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new HttpError(400, 'file_url is empty');
  if (s.length > MAX_URL) throw new HttpError(400, 'file_url is too long');
  let u;
  try { u = new URL(s); } catch { throw new HttpError(400, 'file_url is not a valid URL'); }
  if (u.protocol !== 'https:') throw new HttpError(400, 'file_url must be an https link');
  if (u.username || u.password) throw new HttpError(400, 'file_url must not contain credentials');
  const id = driveId(u.toString());
  return id ? driveView(id) : u.toString();
}

// What the UI needs to show a stored link: where to open it and whether it can be embedded.
function describe(url) {
  if (!url) return null;
  const id = driveId(url);
  if (id) {
    return {
      url: driveView(id), kind: 'drive', drive_id: id,
      embed_url: `https://drive.google.com/file/d/${id}/preview`,
      download_url: `https://drive.google.com/uc?export=download&id=${id}`,
    };
  }
  return { url, kind: 'link', embed_url: null, download_url: null };
}

module.exports = { driveId, driveView, normalize, describe };
