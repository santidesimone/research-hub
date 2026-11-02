// Library logic that needs no DOM: addresses, form values, what changed, provenance labels. Tested from web/test/run.js.

export const SECTIONS = ['all', 'graph', 'audit', 'curation'];

// /library/<slug>?key=..&edit=1  ->  { section, key, edit }. Older links (/library?key=..&view=graph) keep working.
export function parseRoute(rest, query, collections) {
  const first = (rest[0] || '').toLowerCase();
  const coll = collections.find((c) => c.slug === first);
  let section = coll ? coll.name : SECTIONS.includes(first) ? first : query.get('view') === 'graph' ? 'graph' : 'all';
  if (!first && !query.get('view') && !query.get('key')) section = 'paper'; // the Library opens on Papers
  return { section, key: query.get('key') || null, edit: query.get('edit') === '1' };
}
export function routePath({ section, key = null, edit = false }, collections) {
  const coll = collections.find((c) => c.name === section);
  const qs = new URLSearchParams();
  if (key) qs.set('key', key);
  if (edit) qs.set('edit', '1');
  const s = qs.toString();
  return `/library/${coll ? coll.slug : section}${s ? '?' + s : ''}`;
}
// The Collections bar: the main collections in a row, the rest (ui_more) under "More". Collections sharing a ui_group
// (research questions and hypotheses) are one entry that opens the first and switches between them.
export function barEntries(collections) {
  const main = collections.filter((c) => !c.ui_more).map((c) => ({ id: c.name, label: c.plural, members: [c.name] }));
  const more = [];
  for (const c of collections.filter((x) => x.ui_more)) {
    const g = c.ui_group;
    const same = g && more.find((e) => e.group === g.id);
    if (same) same.members.push(c.name);
    else more.push({ id: c.name, label: g ? g.label : c.plural, members: [c.name], group: g ? g.id : null });
  }
  return { main, more };
}
export const entryOf = (entries, section) => [...entries.main, ...entries.more].find((e) => e.members.includes(section)) || null;

// Which collection a node belongs to, from its labels.
export const collectionOf = (labels, collections) => (collections.find((c) => (labels || []).includes(c.label)) || null);

export const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => x == null || x === ''));

// "CaseStudy" -> "case study", for headings and messages.
export const noun = (label) => String(label).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

// Who wrote a field, for the marker next to it.
export function provenanceLabel(p) {
  if (!p || !p.by) return null;
  const who = p.by === 'owner' ? 'you' : p.by === 'claude' ? 'Claude' : p.by === 'source' ? 'source' : p.by;
  const bits = [p.model, p.confidence && `${p.confidence} confidence`, p.status === 'reviewed' && p.by !== 'owner' ? 'reviewed' : null, p.at && String(p.at).slice(0, 10)].filter(Boolean);
  return { text: who, kind: p.by === 'owner' ? 'owner' : p.by === 'claude' ? 'claude' : 'source', low: p.confidence === 'low' && p.status !== 'reviewed', reviewed: p.status === 'reviewed', title: bits.join(' · ') };
}

// Key findings without a location: saved, but not grounded in the source.
export const ungrounded = (findings) => (Array.isArray(findings) ? findings : [])
  .map((f, i) => (f && typeof f === 'object' && typeof f.location === 'string' && f.location.trim() ? null : i)).filter((i) => i !== null);

// The fields of a collection in display order: the schema's detail groups, then the common ones, then anything left.
export function fieldGroups(coll) {
  const seen = new Set();
  const groups = [];
  const general = ['title', 'tldr', 'summary', 'topics', 'tags', 'visibility', 'body'].filter((f) => coll.fields[f]);
  groups.push({ label: 'General', fields: general });
  general.forEach((f) => seen.add(f));
  for (const g of coll.detail_groups || []) {
    const fields = g.fields.filter((f) => coll.fields[f] && !seen.has(f));
    fields.forEach((f) => seen.add(f));
    if (fields.length) groups.push({ label: g.label, fields });
  }
  const rest = Object.keys(coll.fields).filter((f) => !seen.has(f) && f !== 'record_status');
  if (rest.length) groups.push({ label: 'Other', fields: rest });
  return groups;
}

/* ---------------------------------------------------------------- form values */

const trim = (v) => (typeof v === 'string' ? v.trim() : v);

// What a form widget holds -> what the API takes. Empty becomes null; numbers are numbers; refs are names or keys.
export function fromForm(spec, raw) {
  if (spec.type === 'ref') {
    const list = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map((x) => trim(x && typeof x === 'object' ? x.key || x.name : x)).filter((x) => x);
    return spec.list ? list : list[0] ?? null;
  }
  if (spec.type === 'object') {
    const one = (o) => {
      if (!o || typeof o !== 'object') return null;
      const out = {};
      for (const [k, t] of Object.entries(spec.props || {})) {
        const v = scalar(t, o[k]);
        if (v !== null) out[k] = v;
      }
      return Object.keys(out).length ? out : null;
    };
    if (spec.list) { const list = (Array.isArray(raw) ? raw : []).map(one).filter(Boolean); return list.length ? list : null; }
    return one(raw);
  }
  if (spec.list) { const list = (Array.isArray(raw) ? raw : []).map((x) => scalar(spec.type, x)).filter((x) => x !== null); return list.length ? list : null; }
  return scalar(spec.type, raw);
}
function scalar(type, v) {
  v = trim(v);
  if (v == null || v === '') return null;
  if (type === 'integer') { const n = Number(v); return Number.isInteger(n) ? n : v; } // a bad number is sent as typed; the server warns
  if (type === 'boolean') return v === true || v === 'true';
  return v;
}

// What the API returned -> what a form widget starts with.
export function toForm(spec, value) {
  if (spec.type === 'ref') return (Array.isArray(value) ? value : value ? [value] : []).map((x) => ({ key: x.key || null, name: x.name || x.key }));
  if (spec.list) return Array.isArray(value) ? value : [];
  return value ?? (spec.type === 'object' ? {} : '');
}

// Normalised for comparison: refs by key (or name for older text values), objects with sorted keys.
function canon(spec, v) {
  if (v == null) return null;
  if (spec.type === 'ref') {
    const list = (Array.isArray(v) ? v : [v]).map((x) => (x && typeof x === 'object' ? x.key || x.name : x)).filter(Boolean);
    return list.length ? list : null;
  }
  const sort = (x) => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
  return sort(v);
}
// What a create sends: filled fields only, and never a hub-managed field (by Sys) still at its default. A hypothesis's
// status left at "untested" must stay the hub's to derive, not become the owner's override.
export function createFields(specs, values) {
  return Object.fromEntries(Object.entries(values).filter(([f, v]) => v !== null
    && !(specs[f] && specs[f].by.includes('Sys') && specs[f].default != null && v === specs[f].default)));
}

// Only the fields the owner actually changed, so a PATCH marks just those as reviewed.
export function changedFields(specs, before, after) {
  const out = {};
  for (const [f, v] of Object.entries(after)) {
    const spec = specs[f];
    if (!spec) continue;
    if (JSON.stringify(canon(spec, before[f] ?? null)) !== JSON.stringify(canon(spec, v))) out[f] = v;
  }
  return out;
}

// Only http(s) links are shown as links (never javascript: or data:).
export const safeHref = (u) => (typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim()) ? u.trim() : null);
