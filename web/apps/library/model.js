// Library logic that needs no DOM: addresses, form values, what changed, provenance labels. Tested from web/test/run.js.

export const SECTIONS = ['all', 'graph', 'review'];
// older addresses of the two Review tabs
const REVIEW_ALIASES = { audit: 'check', curation: 'fixes' };

// /library/<slug>?key=..&edit=1  ->  { section, key, edit }; /library/review?tab=fixes adds { tab }. Older links
// (/library?key=..&view=graph, /library/audit, /library/curation) keep working.
export function parseRoute(rest, query, collections) {
  const first = (rest[0] || '').toLowerCase();
  const coll = collections.find((c) => c.slug === first);
  if (first === 'review' || REVIEW_ALIASES[first]) {
    return { section: 'review', key: null, edit: false, tab: REVIEW_ALIASES[first] || (query.get('tab') === 'fixes' ? 'fixes' : 'check') };
  }
  let section = coll ? coll.name : SECTIONS.includes(first) ? first : query.get('view') === 'graph' ? 'graph' : 'all';
  if (!first && !query.get('view') && !query.get('key')) section = 'paper'; // the Library opens on Papers
  return { section, key: query.get('key') || null, edit: query.get('edit') === '1' };
}
export function routePath({ section, key = null, edit = false, tab = null }, collections) {
  const coll = collections.find((c) => c.name === section);
  const qs = new URLSearchParams();
  if (key) qs.set('key', key);
  if (edit) qs.set('edit', '1');
  if (section === 'review' && tab === 'fixes') qs.set('tab', 'fixes');
  const s = qs.toString();
  return `/library/${coll ? coll.slug : section}${s ? '?' + s : ''}`;
}
// The Library sidebar: the schema's ui_sections in order, each with the collections that name it (ui_section), in
// schema order. A collection naming no known section lands in a trailing "Other" group, so a new type is never lost.
export function sidebarGroups(collections, sections = []) {
  const groups = sections.map((s) => ({ id: s.id, label: s.label, items: [] }));
  const other = { id: 'other', label: 'Other', items: [] };
  for (const c of collections) (groups.find((g) => g.id === c.ui_section) || other).items.push({ id: c.name, label: c.plural });
  return [...groups, other].filter((g) => g.items.length);
}

// The graph filter: node types grouped like the sidebar (collections by ui_section), then Vocabulary (the schema's
// entities: topics, people …), then any other type (notes, projects). labels: the schema's labels ({label, name,
// color}); entityLabels: the entities' labels. Empty groups are left out.
export function graphFilterGroups(labels, collections, sections = [], entityLabels = []) {
  const byLabel = new Map(collections.map((c) => [c.label, c]));
  const groups = sidebarGroups(collections, sections).map((g) => ({ id: g.id, label: g.label, items: [] }));
  const vocab = { id: 'vocabulary', label: 'Vocabulary', items: [] };
  const other = groups.find((g) => g.id === 'other') || { id: 'other', label: 'Other', items: [] };
  for (const l of labels) {
    const c = byLabel.get(l.label);
    const g = c ? groups.find((x) => x.id === c.ui_section) || other : entityLabels.includes(l.label) ? vocab : other;
    g.items.push(l);
  }
  return [...groups.filter((g) => g.id !== 'other'), vocab, other].filter((g) => g.items.length);
}
// Large vocabularies stay off until asked for, so the first view is not a hairball.
export const GRAPH_OFF_BY_DEFAULT = ['Concept', 'Person', 'Organisation', 'Venue'];

// How many items of each collection the loaded graph holds: { collection name: count }. Papers count from their own list.
export function collectionCounts(nodes, collections, papers = null) {
  const out = {};
  for (const c of collections) out[c.name] = c.name === 'paper' && papers ? papers.length : nodes.filter((n) => (n.labels || []).includes(c.label)).length;
  return out;
}

// Which collection a node belongs to, from its labels.
export const collectionOf = (labels, collections) => (collections.find((c) => (labels || []).includes(c.label)) || null);

// A value as one line of plain text, for list entries: names of linked items, lists joined, objects summarised.
export function plainValue(spec, v) {
  const one = (x) => (x && typeof x === 'object' ? x.name || x.title || x.key || Object.values(x).filter((y) => y != null && typeof y !== 'object').join(' ') : String(x).replace(/_/g, ' '));
  if (v == null || v === '') return '';
  if (spec && spec.type === 'object' && spec.list && Array.isArray(v)) return `${v.length} ${(spec.label || 'entries').toLowerCase()}`;
  return (Array.isArray(v) ? v : [v]).map(one).filter(Boolean).join(', ');
}

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
