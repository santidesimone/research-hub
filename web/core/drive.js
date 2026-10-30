// Google Drive as the file store. The hub keeps only links: this module uploads a PDF to one hub-created Drive folder,
// makes that file readable by anyone with the link, and can move it to the trash again. Plain HTTPS calls, no Google SDK.
//
// Auth is your own Google login (a refresh token from bin/drive-auth) with the narrow drive.file scope, which can only
// touch files this app created. A service account cannot be used: it has no Drive storage of its own.
const { HttpError } = require('./errors');
const links = require('./links');
const config = require('./config');
const db = require('./db');

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Research Hub PDFs';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' };

let http = (url, opts) => fetch(url, opts); // replaceable so tests never touch the network
const setHttp = (fn) => { http = fn; };

const configured = () => config.get().drive.configured;
function requireConfigured() {
  if (!configured()) {
    throw new HttpError(503, 'Google Drive is not set up on this server (needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN; run bin/drive-auth once, see deploy/README.md). Storing a link still works.');
  }
}

/* ---------------------------------------------------------------- access token */
let token = { value: null, exp: 0, pending: null };

async function accessToken(force = false) {
  requireConfigured();
  if (!force && token.value && Date.now() < token.exp - 60000) return token.value;
  if (token.pending) return token.pending;
  const c = config.get().drive;
  const p = (async () => {
    const res = await http('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new HttpError(503, `Google rejected the stored login (${data.error_description || data.error || res.status}). Run bin/drive-auth again and update GOOGLE_REFRESH_TOKEN.`);
    }
    token.value = data.access_token;
    token.exp = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return token.value;
  })();
  token.pending = p;
  try { return await p; } finally { token.pending = null; }
}

async function call(url, opts = {}, retry = true) {
  const t = await accessToken();
  const res = await http(url, { ...opts, headers: { Authorization: `Bearer ${t}`, ...(opts.headers || {}) } });
  if (res.status === 401 && retry) { await accessToken(true); return call(url, opts, false); }
  return res;
}

async function ok(res, what) {
  if (res.ok) return res;
  let detail = '';
  try { const j = await res.clone().json(); detail = j.error && (j.error.message || j.error); } catch { /* not JSON */ }
  throw new HttpError(502, `Google Drive: ${what} failed (${res.status}${detail ? ': ' + detail : ''})`);
}

/* ---------------------------------------------------------------- the folder */
let folderCache = null;

// The folder id is kept on a (:HubSetting {id:'drive'}) node so every instance uses the same folder.
async function ensureFolder() {
  if (folderCache) return folderCache;
  const [stored] = await db.run("MATCH (s:HubSetting {id:'drive'}) RETURN s.folder_id AS id");
  if (stored && stored.id) {
    const res = await call(`${API}/files/${encodeURIComponent(stored.id)}?fields=id,trashed`);
    if (res.ok) { const f = await res.json(); if (!f.trashed) return (folderCache = stored.id); }
    else if (res.status !== 404) await ok(res, 'checking the folder');
  }
  // One this app made earlier (for example after a database restore)? drive.file scope lets us list only our own files.
  const q = `name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const found = (await (await ok(await call(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`), 'looking for the folder')).json()).files || [];
  let id = found.length ? found[0].id : null;
  if (!id) {
    const created = await ok(await call(`${API}/files?fields=id`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }) }), 'creating the folder');
    id = (await created.json()).id;
  }
  await db.exec("MERGE (s:HubSetting {id:'drive'}) SET s.folder_id = $id, s.updated_at = datetime()", { id });
  return (folderCache = id);
}

/* ---------------------------------------------------------------- files */
const fileName = (title) => (String(title || 'paper').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'paper') + '.pdf';

async function makePublic(id) {
  await ok(await call(`${API}/files/${encodeURIComponent(id)}/permissions`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ role: 'reader', type: 'anyone', allowFileDiscovery: false }),
  }), 'making the file readable by anyone with the link');
}

async function trash(id) {
  const res = await call(`${API}/files/${encodeURIComponent(id)}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ trashed: true }) });
  if (res.status === 404) return; // already gone
  await ok(res, 'moving the file to the trash');
}

// Upload a PDF (resumable upload: works for any size) and share it by link. Returns { id, url }.
async function upload(title, buf) {
  const folder = await ensureFolder();
  const start = await ok(await call(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'X-Upload-Content-Type': 'application/pdf', 'X-Upload-Content-Length': String(buf.length) },
    body: JSON.stringify({ name: fileName(title), parents: [folder], mimeType: 'application/pdf' }),
  }), 'starting the upload');
  const session = start.headers.get('location');
  if (!session) throw new HttpError(502, 'Google Drive: no upload session was returned');
  const done = await ok(await http(session, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: buf }), 'uploading the file');
  const { id } = await done.json();
  try { await makePublic(id); }
  catch (e) { await trash(id).catch(() => {}); throw e; } // never leave a private orphan behind
  return { id, url: links.driveView(id) };
}

// Used by `hub drive`: proves the login works and the folder exists.
async function check() {
  const id = await ensureFolder();
  return { configured: true, scope: SCOPE, folder_id: id, folder_url: `https://drive.google.com/drive/folders/${id}` };
}

const _reset = () => { token = { value: null, exp: 0, pending: null }; folderCache = null; };

module.exports = { configured, requireConfigured, upload, trash, check, fileName, setHttp, _reset, SCOPE, FOLDER_NAME };
