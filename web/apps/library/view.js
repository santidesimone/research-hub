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
    // plain words separated by commas, each linked item a link (no pills)
    return h('span', { class: 'reflist' }, list.flatMap((x, i) => [i ? ', ' : '', x.key && onRef
      ? h('a', { class: 'ref', 'data-key': x.key, onclick: () => onRef(x.key) }, x.name || x.key)
      : h('span', { title: x.key ? null : 'text from an older version (not linked yet)' }, x.name || x.key)]));
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

// Headings for links, by direction: a framework lists the papers framing on it, a hypothesis the papers testing it,
// an ontology its modules and users. Other relations read as their name.
const REL_HEADINGS = {
  out: { FRAMED_BY: 'Framed by', TESTS: 'Tests', USED_BY: 'Used by', PART_OF: 'Part of', DERIVED_FROM: 'Derived from', ANSWERS: 'Answers',
    ASKED_IN: 'Asked in', ADDRESSED_BY: 'Addressed by', SUB_QUESTION_OF: 'Sub-question of', COMPETES_WITH: 'Competes with', ALIGNS_WITH: 'Aligns with' },
  in: { FRAMED_BY: 'Framed by this', TESTS: 'Tested by', USED_BY: 'Uses this', PART_OF: 'Parts', DERIVED_FROM: 'Hypotheses derived from this',
    ANSWERS: 'Hypotheses answering this', ASKED_IN: 'Questions asked here', ADDRESSED_BY: 'Questions it addresses', SUB_QUESTION_OF: 'Sub-questions',
    COMPETES_WITH: 'Competing with this', BUILDS_ON: 'Built on by', DEFINED_IN: 'Concepts defined here' },
};
const relWords = (rel) => rel.toLowerCase().replace(/_/g, ' ');
const heading = (dir, rel) => (REL_HEADINGS[dir][rel] || (dir === 'out' ? relWords(rel)[0].toUpperCase() + relWords(rel).slice(1) : `${relWords(rel)} (from)`));
export const resultBadge = (r) => r && h('span', { class: `badge res res-${r}` }, r);

// Links in and out, to anything (items, notes, projects, vocabulary), grouped by relation. onRemove(link) is offered for
// outgoing links the owner may remove. Links that carry a result (TESTS) are a small table.
export function renderLinks(item, { onOpen, onRemove } = {}) {
  const open = (l) => h('a', { onclick: () => onOpen && onOpen(l.key) }, l.name || l.key);
  const remove = (l, dir) => (dir === 'out' && onRemove && !l.field ? h('button', { type: 'button', class: 'iconbtn small', 'aria-label': 'Remove link', title: 'Remove link', onclick: () => onRemove(l) }, '×') : null);
  const who = (l) => (l.by && l.by !== 'owner' ? provBadge({ by: l.by, model: l.model, confidence: l.confidence, status: l.status }) : null);
  const row = (l, dir) => h('li', null,
    open(l), h('span', { class: 'faint small' }, (l.labels || []).join(', ')), who(l),
    l.evidence && h('span', { class: 'evidence', title: [l.evidence, l.location].filter(Boolean).join(' · ') }, '“' + String(l.evidence).slice(0, 80) + (String(l.evidence).length > 80 ? '…' : '') + '”'),
    remove(l, dir));
  const table = (list, dir) => h('table', { class: 'kv grid results' },
    h('thead', null, h('tr', null, ['', 'result', 'evidence', 'location', ''].map((x) => h('th', null, x)))),
    h('tbody', null, list.map((l) => h('tr', { 'data-key': l.key }, h('td', null, open(l), ' ', who(l)), h('td', null, resultBadge(l.result)),
      h('td', { class: 'evidence' }, l.evidence || ''), h('td', null, l.location || h('span', { class: 'flag' }, 'no location')), h('td', null, remove(l, dir))))));
  const groups = (list, dir) => {
    const byRel = new Map();
    for (const l of list) { if (!byRel.has(l.rel)) byRel.set(l.rel, []); byRel.get(l.rel).push(l); }
    return [...byRel].map(([rel, ls]) => {
      const results = ls.filter((l) => l.result).map((l) => l.result);
      const tally = results.length ? ' (' + [...new Set(results)].map((r) => `${results.filter((x) => x === r).length} ${r}`).join(', ') + ')' : '';
      return h('section', { class: 'rel', 'data-rel': `${dir}:${rel}` }, h('div', { class: 'label' }, heading(dir, rel) + tally),
        results.length ? table(ls, dir) : h('ul', null, ls.map((l) => row(l, dir))));
    });
  };
  const out = item.links.out.filter((l) => !['AUTHORED_BY', 'PUBLISHED_IN', 'PUBLISHED_BY'].includes(l.rel) && !l.field);
  return h('div', { class: 'links' }, ...groups(out, 'out'), ...groups(item.links.in, 'in'));
}
