// Read-only rendering of collection items from the schema: grouped fields with tier badges, provenance markers
// (Claude / source / you, confidence) and ungrounded-finding flags. All values are text nodes, never HTML.
import { h } from '../../shell/ui.js';
import { fieldGroups, isEmpty, provenanceLabel, ungrounded, safeHref } from './model.js';

export function provBadge(p) {
  const l = provenanceLabel(p);
  if (!l) return null;
  return h('span', { class: `prov prov-${l.kind}${l.low ? ' low' : ''}`, title: l.title || null }, l.text, l.low && ' · low', l.reviewed && l.kind !== 'owner' && ' ✓');
}
export const tierBadge = (tier) => h('span', { class: `tier tier-${tier}` }, tier);

// One value, by field type. onRef(target) opens a linked node.
export function renderValue(spec, v, { onRef } = {}) {
  if (isEmpty(v)) return h('span', { class: 'faint' }, '—');
  if (spec.type === 'ref') {
    const list = Array.isArray(v) ? v : [v];
    return h('span', { class: 'chips inline' }, list.map((x) => (x.key && onRef
      ? h('button', { type: 'button', class: 'chip', onclick: () => onRef(x.key) }, x.name || x.key)
      : h('span', { class: 'chip static', title: x.key ? null : 'text from an older version (not linked yet)' }, x.name || x.key))));
  }
  if (spec.type === 'object') {
    const parts = Object.keys(spec.props || {});
    if (spec.list) {
      return h('table', { class: 'kv grid' },
        h('thead', null, h('tr', null, parts.map((k) => h('th', null, k.replace(/_/g, ' '))))),
        h('tbody', null, v.map((row) => h('tr', null, parts.map((k) => h('td', null, cell(spec.props[k], row && row[k])))))));
    }
    return h('table', { class: 'kv' }, h('tbody', null, parts.filter((k) => !isEmpty(v[k])).map((k) => h('tr', null, h('td', null, k.replace(/_/g, ' ')), h('td', null, cell(spec.props[k], v[k]))))));
  }
  if (spec.list) return h('ul', { class: 'vlist' }, v.map((x) => h('li', null, cell(spec.type, x))));
  if (spec.type === 'longtext' || spec.type === 'markdown') return h('div', { class: 'longtext' }, String(v));
  return cell(spec.type, v);
}
function cell(type, v) {
  if (v == null || v === '') return h('span', { class: 'faint' }, '—');
  if (type === 'boolean') return v ? 'yes' : 'no';
  if (type === 'url') { const href = safeHref(v); return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, href) : String(v); }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Every group of a collection item. opts: { onRef, showEmpty, only: field filter }
export function renderFields(item, coll, { onRef, showEmpty = false, skip = [] } = {}) {
  const wrap = h('div', { class: 'fieldgroups' });
  const flagged = new Set(ungrounded(item.fields.key_findings));
  for (const g of fieldGroups(coll)) {
    const filled = g.fields.filter((f) => !skip.includes(f) && !isEmpty(item.fields[f]));
    const empty = g.fields.filter((f) => !skip.includes(f) && isEmpty(item.fields[f]));
    if (!filled.length && !showEmpty) continue;
    const sec = h('section', { class: 'fieldgroup' }, h('div', { class: 'label' }, g.label));
    for (const f of filled) {
      const spec = coll.fields[f];
      const value = renderValue(spec, item.fields[f], { onRef });
      if (f === 'key_findings' && flagged.size) {
        value.querySelectorAll('tbody tr').forEach((tr, i) => { if (flagged.has(i)) { tr.classList.add('flagged'); tr.title = 'Ungrounded: no location in the source'; } });
      }
      sec.append(h('div', { class: 'field', 'data-field': f },
        h('div', { class: 'field-head' }, h('span', { class: 'field-name' }, spec.label || f), tierBadge(spec.tier), provBadge(item.provenance[f]),
          f === 'key_findings' && flagged.size ? h('span', { class: 'flag' }, `${flagged.size} ungrounded`) : null),
        h('div', { class: 'field-value' }, value)));
    }
    if (empty.length) {
      sec.append(h('div', { class: 'empties' }, h('span', { class: 'faint' }, 'Empty: '),
        empty.map((f) => h('span', { class: `empty-field tier-${coll.fields[f].tier}`, title: coll.fields[f].help || null }, coll.fields[f].label || f))));
    }
    wrap.append(sec);
  }
  return wrap;
}

// Links in and out, to anything (items, notes, projects, vocabulary). onRemove(link) is offered for outgoing links.
export function renderLinks(item, { onOpen, onRemove } = {}) {
  const row = (l, dir) => h('li', null,
    h('span', { class: 'badge outline' }, l.rel.toLowerCase().replace(/_/g, ' ')),
    h('a', { onclick: () => onOpen && onOpen(l.key) }, l.name || l.key),
    h('span', { class: 'faint small' }, (l.labels || []).join(', ')),
    l.by && l.by !== 'owner' && provBadge({ by: l.by, model: l.model, confidence: l.confidence, status: l.status }),
    l.evidence && h('span', { class: 'evidence', title: [l.evidence, l.location].filter(Boolean).join(' · ') }, '“' + String(l.evidence).slice(0, 80) + (String(l.evidence).length > 80 ? '…' : '') + '”'),
    dir === 'out' && onRemove && !l.field && h('button', { type: 'button', class: 'iconbtn small', 'aria-label': 'Remove link', title: 'Remove link', onclick: () => onRemove(l) }, '×'));
  const sec = (title, list, dir) => (list.length ? h('section', { class: 'rel' }, h('div', { class: 'label' }, title), h('ul', null, list.map((l) => row(l, dir)))) : null); // never 0: the DOM would print it
  const out = item.links.out.filter((l) => !['AUTHORED_BY', 'PUBLISHED_IN'].includes(l.rel) && !l.field);
  return h('div', null, sec('Links to', out, 'out'), sec('Linked from', item.links.in, 'in'));
}
