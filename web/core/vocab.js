// Vocabulary nodes (Person, Concept, Topic, Domain, Venue, Organisation, Dataset) and the name matcher.
// Callers (Claude, the API) pass names, never keys: resolve() finds the node that name means, or creates one.
//
// Matching, in order. "Empty beats wrong": anything less certain than these creates a new node instead of guessing.
//   exact    same normalised form (case, punctuation, accents and, for terms, plurals ignored) as the name or an alias
//   acronym  an UPPER-CASE token stands for one initial per letter, on either side: "ZKP" = "ZK proofs" =
//            "zero knowledge proof". Needs a shared ordinary word or 3+ letters ("AI" alone matches nothing)
//   typo     one word of 8+ letters differs by one edit, every other word equal: "cryptograpy" = "cryptography"
// Candidates come from indexed lookups on the stored normalised fields, then the `vocab_text` full-text index.
// A non-exact match records the spelling as an alias, so the next lookup is exact.
//
// Concurrency: creating a node (or adding an alias) takes a per-label lock, (:VocabLock {label}), for one transaction
// and re-checks under it, so parallel calls with different spellings of one name still create a single node. The key is
// derived from the normalised name and written with MERGE on the unique key. Lookups never lock.
const { schema, entityLabels, safeLabel } = require('./schema');
const { HttpError } = require('./errors');
const db = require('./db');
const log = require('./log');

const MAX_NAME = 200;
const UNCHANGED_PLURALS = new Set(['news', 'series', 'species', 'means', 'lens', 'gas', 'bias', 'chaos', 'canvas', 'atlas']);

// Plural -> singular, deliberately simple and applied the same way to both sides of every comparison.
function singular(w) {
  if (w.length <= 3 || /\d/.test(w) || UNCHANGED_PLURALS.has(w) || /(ss|us|is|os|ics)$/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(sses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

const ACRONYM = /^[A-Z]{2,6}s?$/;

// -> { norm, toks, acr, letters }: normalised tokens, which tokens were written as acronyms, and the letter signature
// (an acronym gives each of its letters, a word its first letter; null for a single word) used to find acronym matches.
function analyse(mode, raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (mode === 'person') { const parts = s.split(','); if (parts.length === 2 && parts[1].trim()) s = `${parts[1]} ${parts[0]}`; } // "Lovelace, Ada"
  s = s.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/&/g, ' and ').replace(/['’]s\b/g, '').replace(/['’]/g, '');
  const orig = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const shouting = orig.length > 1 && !/\p{Ll}/u.test(s); // "ZERO KNOWLEDGE PROOF" is not three acronyms
  const acr = orig.map((t) => !shouting && ACRONYM.test(t));
  const toks = orig.map((t, i) => {
    const low = acr[i] ? t.replace(/s$/, '').toLowerCase() : t.toLowerCase(); // "ZKPs" -> zkp
    return mode === 'term' ? singular(low) : low;
  });
  const units = toks.flatMap((t, i) => (acr[i] ? [...t].map((c) => ({ i: c })) : [{ w: t }]));
  return { norm: toks.join(' '), toks, acr, units, letters: units.length > 1 ? units.map((u) => u.i || u.w[0]).join('') : null };
}

// Unit by unit: word = word, an acronym letter = a word starting with it, or = the same acronym letter. A two-letter
// acronym alone is too ambiguous ("AI" vs "art investing"), so it needs a shared ordinary word ("ZK proofs").
function acronymMatch(a, b) {
  if (a.units.length !== b.units.length) return false;
  let anchors = 0, letters = 0;
  for (let k = 0; k < a.units.length; k++) {
    const x = a.units[k], y = b.units[k];
    if (x.w && y.w) { if (x.w !== y.w) return false; anchors++; continue; }
    if ((x.i || x.w[0]) !== (y.i || y.w[0])) return false;
    letters++;
  }
  return letters > 0 && (anchors > 0 || letters >= 3);
}

function oneEdit(x, y) {
  if (x === y || Math.abs(x.length - y.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (x.length > y.length) i++; else if (y.length > x.length) j++; else { i++; j++; }
  }
  return edits + (x.length - i) + (y.length - j) === 1;
}

function typo(a, b) {
  if (a.toks.length !== b.toks.length) return false;
  const diff = a.toks.map((t, i) => [t, b.toks[i]]).filter(([x, y]) => x !== y);
  return diff.length === 1 && diff[0].every((t) => t.length >= 8 && !/\d/.test(t)) && oneEdit(diff[0][0], diff[0][1]);
}

const RANK = { exact: 0, alias: 1, acronym: 2, typo: 3 };

// How (and whether) the query means this candidate, judged against its name and every alias.
function judge(q, mode, cand) {
  const forms = [{ a: analyse(mode, cand.name || ''), alias: false }, ...(cand.aliases || []).map((x) => ({ a: analyse(mode, x), alias: true }))];
  let best = null;
  for (const { a, alias } of forms) {
    const m = q.norm === a.norm ? (alias ? 'alias' : 'exact') : acronymMatch(q, a) ? 'acronym' : typo(q, a) ? 'typo' : null;
    if (m && (!best || RANK[m] < RANK[best])) best = m;
  }
  return best;
}

function pick(q, mode, rows) {
  let best = null;
  for (const r of [...rows].sort((x, y) => (x.key < y.key ? -1 : 1))) {
    const m = judge(q, mode, r);
    if (m && (!best || RANK[m] < RANK[best.match])) best = { ...r, match: m };
  }
  return best;
}

function labelOf(kind) {
  const label = entityLabels.find((l) => l.toLowerCase() === String(kind || '').toLowerCase());
  if (!label) throw new HttpError(400, `Unknown vocabulary "${kind}". Known: ${entityLabels.join(', ')}`);
  return label;
}
const modeOf = (label) => schema.entities[label].match;

// The derived fields every vocabulary node carries so lookups can use indexes. Writers that create vocabulary nodes
// themselves (papers, notes, backup) set at least norm and initials.
function derived(label, name, aliases = []) {
  const mode = modeOf(label);
  const a = analyse(mode, name);
  const al = aliases.map((x) => analyse(mode, x));
  const aliasNorms = [...new Set(al.map((x) => x.norm).filter(Boolean))];
  return { norm: a.norm, letters: a.letters, aliases_norm: aliasNorms, aliases_letters: [...new Set(al.map((x) => x.letters).filter(Boolean))], aliases_text: aliasNorms.join(' | ') };
}
const nameProps = (label, name) => { const d = derived(label, name); return { norm: d.norm, letters: d.letters }; };

const FIELDS = 'n.key AS key, n.name AS name, coalesce(n.aliases, []) AS aliases';
// Indexed candidates: same normalised form or alias, or the same letter signature (acronym spellings). Name and alias
// hits sort first, so many nodes sharing a signature can never push the exact one past the limit.
const EXACT = `n.norm = $norm OR $norm IN coalesce(n.aliases_norm, []) OR ($letters IS NOT NULL AND (n.letters = $letters OR $letters IN coalesce(n.aliases_letters, [])))`;
const FIRST_EXACT = `ORDER BY CASE WHEN n.norm = $norm OR $norm IN coalesce(n.aliases_norm, []) THEN 0 ELSE 1 END, n.key`;

function lucene(q) {
  return q.toks.filter((t, i) => !q.acr[i]).map((t) => (t.length >= 8 ? `${t}~1` : t)).join(' OR ');
}

async function candidates(label, q) {
  const L = safeLabel(label);
  const rows = await db.run(`MATCH (n:${L}) WHERE ${EXACT} RETURN ${FIELDS} ${FIRST_EXACT} LIMIT 50`, { norm: q.norm, letters: q.letters });
  const text = lucene(q);
  if (!text) return { exact: rows, fuzzy: [] };
  try {
    const fuzzy = await db.run(
      `CALL db.index.fulltext.queryNodes('vocab_text', $text) YIELD node AS n, score WHERE n:${L} RETURN ${FIELDS} ORDER BY score DESC LIMIT 10`, { text });
    return { exact: rows, fuzzy };
  } catch (e) {
    log.warn(`vocab_text full-text lookup failed (${e.message}); only exact matches are used`);
    return { exact: rows, fuzzy: [] };
  }
}

// One transaction holding the label's lock. The lock node is created by migration 006; MERGE covers a fresh database.
async function locked(label, fn) {
  return db.writeTx(async (tx) => {
    await tx.run('MERGE (l:VocabLock {label:$label}) SET l.at = datetime()', { label });
    return fn(tx);
  });
}
const rowsOf = (res) => res.records.map((r) => ({ key: r.get('key'), name: r.get('name'), aliases: r.get('aliases') || [] }));

async function addAliases(tx, label, key, add) {
  const L = safeLabel(label);
  const [row] = rowsOf(await tx.run(`MATCH (n:${L} {key:$key}) RETURN ${FIELDS}`, { key }));
  if (!row) return;
  const mode = modeOf(label);
  const have = new Set([row.name, ...row.aliases].map((x) => analyse(mode, x).norm));
  const fresh = add.filter((x) => { const n = analyse(mode, x).norm; if (!n || have.has(n)) return false; have.add(n); return true; });
  if (!fresh.length) return;
  const aliases = [...row.aliases, ...fresh];
  const d = derived(label, row.name, aliases);
  await tx.run(`MATCH (n:${L} {key:$key}) SET n.aliases = $aliases, n.aliases_norm = $an, n.aliases_letters = $al, n.aliases_text = $at`,
    { key, aliases, an: d.aliases_norm, al: d.aliases_letters, at: d.aliases_text });
}

// -> { key, name, created, match } ; key is null when nothing matched and create is false.
async function resolve(kind, name, { create = true, aliases = [], by = 'claude', model = null } = {}) {
  const label = labelOf(kind);
  const mode = modeOf(label);
  const display = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (display.length > MAX_NAME) throw new HttpError(400, `${label} name is too long (max ${MAX_NAME} characters)`);
  const q = analyse(mode, display);
  if (!q.norm) throw new HttpError(400, `${label} name is empty`);
  const extra = (Array.isArray(aliases) ? aliases : [aliases]).map((x) => String(x).trim()).filter(Boolean);
  const learn = (m) => [...(m.match === 'exact' || m.match === 'alias' ? [] : [display]), ...extra];

  const found = await candidates(label, q);
  const hit = pick(q, mode, found.exact) || pick(q, mode, found.fuzzy);
  if (hit) {
    if (create && learn(hit).length) await locked(label, (tx) => addAliases(tx, label, hit.key, learn(hit)));
    return { key: hit.key, name: hit.name, created: false, match: hit.match };
  }
  if (!create) return { key: null, name: display, created: false, match: null };

  const L = safeLabel(label);
  const key = schema.entities[label].key_prefix + q.norm.replace(/ /g, '-');
  return locked(label, async (tx) => {
    // re-check under the lock: another call may have created this name (the full-text index can lag behind writes)
    const words = q.toks.filter((t, i) => !q.acr[i] && t.length >= 3);
    const res = await tx.run(
      `MATCH (n:${L}) WHERE n.key = $key OR ${EXACT} OR any(t IN $words WHERE n.norm CONTAINS t OR coalesce(n.aliases_text, '') CONTAINS t)
       RETURN ${FIELDS} ${FIRST_EXACT} LIMIT 200`, { key, norm: q.norm, letters: q.letters, words });
    const rows = rowsOf(res);
    const again = pick(q, mode, rows) || (rows.find((r) => r.key === key) && { ...rows.find((r) => r.key === key), match: 'exact' });
    if (again) {
      if (learn(again).length) await addAliases(tx, label, again.key, learn(again));
      return { key: again.key, name: again.name, created: false, match: again.match };
    }
    const d = derived(label, display, extra);
    await tx.run(
      `MERGE (n:${L} {key:$key})
       ON CREATE SET n.name = $name, n.aliases = $aliases, n += $derived, n.by = $by, n.model = $model, n.record_status = 'auto', n.created_at = datetime()`,
      { key, name: display, aliases: extra, derived: d, by, model });
    return { key, name: display, created: true, match: 'new' };
  });
}

module.exports = { resolve, analyse, judge, singular, derived, nameProps, labelOf, lucene };
