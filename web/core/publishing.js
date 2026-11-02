// Publishing settings: what new items default to and how much visitors see of public items. The owner changes them in
// Settings (PUT /api/settings/publishing); they live on (:HubSetting {id:'publishing'}) so every instance agrees.
//   default_visibility  public | private: what a new item gets when its input does not say
//   public_detail       basic: public items show the schema's public_props whitelist only
//                       full:  public items show every field (minus HIDDEN and links to the owner's Drive copies)
// Read through a short cache, so other Cloud Run instances catch up within seconds of a change.
const db = require('./db');
const { HttpError } = require('./errors');

const DEFAULTS = { default_visibility: 'private', public_detail: 'basic' };
const CHOICES = { default_visibility: ['public', 'private'], public_detail: ['basic', 'full'] };
const TTL_MS = 10000;

// Never shown to visitors, in any mode: Drive file ids and paths on the owner's computer. File links that point into the
// owner's Drive are dropped as well (copies of papers that may not be the owner's to redistribute); other links stay.
const HIDDEN = new Set(['drive_file_id', 'snapshot__drive_file_id', 'source_path', 'imported_from', 'path', 'legacy_pdf_uri']);

let cache = null;

async function get() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const [row] = await db.run("MATCH (s:HubSetting {id:'publishing'}) RETURN s.default_visibility AS default_visibility, s.public_detail AS public_detail");
  const value = { ...DEFAULTS };
  for (const k of Object.keys(CHOICES)) if (row && CHOICES[k].includes(row[k])) value[k] = row[k];
  cache = { at: Date.now(), value };
  return value;
}

async function set(input) {
  const changes = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (!CHOICES[k]) throw new HttpError(400, `Unknown setting: ${k}`);
    if (!CHOICES[k].includes(v)) throw new HttpError(400, `${k} must be ${CHOICES[k].join(' or ')}`);
    changes[k] = v;
  }
  if (!Object.keys(changes).length) throw new HttpError(400, `Nothing to change: send ${Object.keys(CHOICES).join(' and/or ')}`);
  await db.exec("MERGE (s:HubSetting {id:'publishing'}) SET s += $changes, s.updated_at = datetime()", { changes });
  cache = null;
  return get();
}

// Give every item the same visibility at once ("make everything public"). Returns how many changed.
async function applyToAll(visibility) {
  if (!CHOICES.default_visibility.includes(visibility)) throw new HttpError(400, 'visibility must be public or private');
  const [row] = await db.exec(
    'MATCH (a:Artifact) WHERE coalesce(a.visibility, "") <> $v SET a.visibility = $v, a.updated_at = datetime() RETURN count(a) AS changed', { v: visibility });
  return { visibility, changed: row ? row.changed : 0 };
}

const isDriveLink = (v) => typeof v === 'string' && /^https?:\/\/(drive|docs)\.google\.com(\/|$)/i.test(v.trim());
const fullProps = (props) => Object.fromEntries(Object.entries(props).filter(([k, v]) => !HIDDEN.has(k) && !isDriveLink(v)));

const forget = () => { cache = null; };

module.exports = { get, set, applyToAll, fullProps, isDriveLink, DEFAULTS, CHOICES, HIDDEN, forget };
