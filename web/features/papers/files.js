// A paper's file is a link (file_url). The hub never stores file bytes itself:
//   * setLink / removeLink   keep any https link the owner gives (Drive, arXiv, a publisher, ...);
//   * uploadPdf              sends a PDF to the owner's Google Drive (core/drive.js) and stores the resulting link.
// Files the hub uploaded are tracked by drive_file_id and moved to the Drive trash when they are replaced, unlinked
// or their paper is deleted. Files the hub did not upload are never touched.
const { run, writeTx } = require('../../core/db');
const { HttpError } = require('../../core/errors');
const drive = require('../../core/drive');
const links = require('../../core/links');
const config = require('../../core/config');

const maxBytes = () => config.get().maxUploadBytes;

const allowedHosts = () => config.get().pdfFetchAllowedHosts;

// Download a PDF so it can be copied to Drive. Only https, only allow-listed hosts, redirects re-checked at every hop.
async function fetchPdf(url) {
  const hosts = allowedHosts();
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    let u;
    try { u = new URL(current); } catch { throw new HttpError(400, 'pdf_url is not a valid URL'); }
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || !hosts.some((h) => host === h || host.endsWith('.' + h))) {
      throw new HttpError(400, `pdf_url host not allowed (allowed: ${hosts.join(', ')}). Upload the file instead, or set PDF_FETCH_ALLOWED_HOSTS.`);
    }
    const res = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'research-hub/0.6' }, signal: AbortSignal.timeout(60000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), u).toString();
      continue;
    }
    if (!res.ok) throw new HttpError(502, `Could not download PDF (HTTP ${res.status})`);
    if (Number(res.headers.get('content-length')) > maxBytes()) throw new HttpError(413, 'PDF too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes()) throw new HttpError(413, 'PDF too large');
    return buf;
  }
  throw new HttpError(502, 'Too many redirects while downloading PDF');
}

async function paperRow(key) {
  const [row] = await run(
    'MATCH (p:Paper {key:$key}) RETURN p.key AS key, p.title AS title, p.file_url AS file_url, p.drive_file_id AS drive_file_id',
    { key: String(key || '') }
  );
  if (!row) throw new HttpError(404, 'No such paper in the library');
  return row;
}

// Trash a Drive file the hub uploaded. Returns a warning string instead of throwing: the database change already happened.
async function trashQuietly(id) {
  try { await drive.trash(id); return null; } catch (e) { return `could not trash Drive file ${id}: ${e.message}`; }
}

async function setLink(key, raw) {
  const url = links.normalize(raw);
  const row = await paperRow(key);
  const same = row.drive_file_id && links.driveId(url) === row.drive_file_id;
  await writeTx((tx) => tx.run(
    `MATCH (p:Paper {key:$key}) SET p.file_url = $url${same ? '' : ' REMOVE p.drive_file_id'}`, { key: row.key, url }));
  const out = { file_url: url };
  if (row.drive_file_id && !same) {
    const warning = await trashQuietly(row.drive_file_id);
    if (warning) out.drive_warning = warning; else out.trashed_drive_file = row.drive_file_id;
  }
  return out;
}

async function removeLink(key) {
  const row = await paperRow(key);
  await writeTx((tx) => tx.run('MATCH (p:Paper {key:$key}) REMOVE p.file_url, p.drive_file_id', { key: row.key }));
  const out = { removed: Boolean(row.file_url) };
  if (row.drive_file_id) {
    const warning = await trashQuietly(row.drive_file_id);
    if (warning) out.drive_warning = warning; else out.trashed_drive_file = row.drive_file_id;
  }
  return out;
}

async function uploadPdf(key, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5 || buf.subarray(0, 5).toString() !== '%PDF-') throw new HttpError(400, 'File is not a PDF');
  if (buf.length > maxBytes()) throw new HttpError(413, `PDF is larger than the ${Math.round(maxBytes() / 1048576)} MB limit`);
  drive.requireConfigured();
  const row = await paperRow(key);
  const up = await drive.upload(row.title, buf);
  try {
    await writeTx((tx) => tx.run('MATCH (p:Paper {key:$key}) SET p.file_url = $url, p.drive_file_id = $id', { key: row.key, url: up.url, id: up.id }));
  } catch (e) {
    await trashQuietly(up.id); // do not leave a public file the graph does not know about
    throw e;
  }
  const out = { file_url: up.url, drive_file_id: up.id };
  if (row.drive_file_id) {
    const warning = await trashQuietly(row.drive_file_id);
    if (warning) out.drive_warning = warning; else out.replaced_drive_file = row.drive_file_id;
  }
  return out;
}

module.exports = { fetchPdf, setLink, removeLink, uploadPdf, paperRow, trashQuietly, maxBytes };
