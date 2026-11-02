// Thoughts (docs/UI_REDESIGN.md section 4): quick text, on any item, that becomes structure. A thought's page shows
// Claude's suggestion as one button and "Something else…" as a popover of the other choices; once turned, it offers
// to delete the thought (never automatically). Every item page ends with "Your thoughts on this" and a field to add one.
// Turning uses the ordinary item and link API, so provenance and hooks work as for any write.
import { h, api, toast } from '../../shell/ui.js';
import { turnOptions, suggestedTurn } from './model.js';

const enc = encodeURIComponent;
const linkTo = (lib, l) => h('a', { class: 'ref', onclick: () => lib.openKey(l.key) }, l.name || l.key);
const onLinks = (item) => item.links.out.filter((l) => l.rel === 'ANNOTATES');
const labelsOf = (l) => l.labels || [];
// a short key for a new item made from a thought: its first words
const slugOf = (text) => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 10).join('-');
const firstLine = (text) => String(text).split(/(?<=[.?!])\s|\n/)[0].slice(0, 120);

// Make the thought into the chosen item. Returns { kind, key } of what it became (or { kept: true }).
export async function turnThought(item, option, collections) {
  const text = item.fields.text || item.fields.title || '';
  const on = onLinks(item);
  const sources = on.filter((l) => !labelsOf(l).includes('ResearchQuestion') && !labelsOf(l).includes('Hypothesis'));
  const questions = on.filter((l) => labelsOf(l).includes('ResearchQuestion'));
  const paper = on.find((l) => labelsOf(l).includes('Paper'));
  const link = (from, rel, target, extra = {}) => api(`/api/items/${enc(from)}/links`, { method: 'PUT', body: { rel, target, ...extra } });
  const done = async (key) => {
    await link(item.key, 'TURNED_INTO', key);
    await api('/api/items/' + enc(item.key), { method: 'PATCH', body: { fields: { state: 'turned' } } });
    return { kind: option.label.toLowerCase(), key };
  };
  const create = async (collection, fields) => (await api('/api/items', { method: 'POST', body: { collection, slug: slugOf(text), fields } })).key;
  const informsFrom = (k) => { const c = collections.find((x) => x.name === 'research_question'); return c ? sources.map((s) => link(s.key, 'INFORMS', k).catch(() => null)) : []; };
  switch (option.id) {
    case 'question': {
      const key = await create('research_question', { text });
      await Promise.all([...informsFrom(key), ...questions.map((q) => link(key, 'SUB_QUESTION_OF', q.key))]);
      return done(key);
    }
    case 'hypothesis': {
      const key = await create('hypothesis', { statement: text });
      await Promise.all([...informsFrom(key), ...questions.map((q) => link(key, 'ANSWERS', q.key))]);
      return done(key);
    }
    case 'critique': case 'support': case 'contradiction':
      await link(item.key, option.rel, paper.key, { evidence: text.slice(0, 2000) });
      await api('/api/items/' + enc(item.key), { method: 'PATCH', body: { fields: { state: 'kept' } } });
      return { kept: true, kind: option.label.toLowerCase() };
    case 'finding': {
      const p = await api('/api/items/' + enc(paper.key));
      await api('/api/items/' + enc(paper.key), { method: 'PATCH', body: { fields: { key_findings: [...(p.fields.key_findings || []), { text, location: null }] } } });
      return done(paper.key);
    }
    case 'method': {
      const key = await create('method', { title: firstLine(text), summary: text });
      return done(key);
    }
    default:
      await api('/api/items/' + enc(item.key), { method: 'PATCH', body: { fields: { state: 'kept' } } });
      return { kept: true, kind: 'note' };
  }
}

// The top of a thought's Info tab.
export function thoughtOverview(lib, item, popover, { onChanged }) {
  const on = onLinks(item);
  const turned = item.links.out.filter((l) => l.rel === 'TURNED_INTO');
  const state = item.fields.state || 'waiting';
  const options = turnOptions([...new Set(on.flatMap(labelsOf))], lib.collections);
  const sug = suggestedTurn(item.fields, options);
  const wrap = h('div', { class: 'thought' },
    h('p', { class: 'thoughttext' }, '“' + (item.fields.text || item.fields.title || '') + '”'),
    h('p', { class: 'muted thoughton' }, ...(on.length ? ['On: ', ...on.flatMap((l, i) => [i ? ', ' : '', linkTo(lib, l)])] : ['Not on anything yet (link it in Connections).'])));
  const turn = async (o, btn) => {
    if (btn) btn.disabled = true;
    try {
      const r = await turnThought(item, o, lib.collections);
      toast(r.kept ? `Kept as a ${r.kind}` : `Turned into a ${r.kind}`);
      if (onChanged) await onChanged();
    } catch (e) { toast(e.message, 'error'); if (btn) btn.disabled = false; }
  };
  if (state === 'waiting') {
    const others = options.filter((o) => o !== sug);
    let menu = null;
    const list = () => h('div', { class: 'optlist' }, others.map((o) => h('button', { type: 'button', class: 'opt', 'data-option': o.id,
      onclick: () => { menu.close(); turn(o); } }, h('span', { class: 'optlabel' }, o.label), h('span', { class: 'opthelp' }, o.help))));
    const anchor = h('div', { class: 'popanchor' }, h('button', { type: 'button', class: 'btn', 'data-action': 'turn-other', 'aria-haspopup': 'dialog',
      onclick: (e) => { menu = popover(e.currentTarget.parentNode, list(), { cls: 'turnmenu' }); } }, sug ? 'Something else… ▾' : 'Turn into… ▾'));
    wrap.append(...[ // the DOM would print false or null
      sug && h('div', { class: 'suggestbox' }, h('strong', null, item.fields.suggested_as ? `Claude suggests: ${sug.label.toLowerCase()}.` : `Looks like a ${sug.label.toLowerCase()}.`),
        ' ', item.fields.suggested_reason || sug.help),
      h('div', { class: 'actions' }, sug && h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'turn-suggested', onclick: (e) => turn(sug, e.currentTarget) },
        `Turn into a ${sug.label.toLowerCase()}`), anchor)].filter(Boolean));
  } else if (state === 'turned') {
    const del = async () => {
      try { await api('/api/items/' + enc(item.key), { method: 'DELETE' }); toast('Thought deleted'); lib.afterDelete('thought'); } catch (e) { toast(e.message, 'error'); }
    };
    wrap.append(h('div', { class: 'donebox' }, h('span', { class: 'grow' }, 'Turned into ', ...(turned.length ? turned.flatMap((l, i) => [i ? ', ' : '', linkTo(lib, l)]) : ['an item']), '. The thought has served its purpose.'),
      h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-action': 'delete-thought', onclick: del }, 'Delete the thought'),
      h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'keep-thought', onclick: async () => {
        try { await api('/api/items/' + enc(item.key), { method: 'PATCH', body: { fields: { state: 'kept' } } }); toast('Kept'); if (onChanged) await onChanged(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Keep it')));
  } else wrap.append(h('p', { class: 'faint keptnote' }, 'Kept as a note.'));
  return wrap;
}

// "Your thoughts on this": the thoughts on an item (incoming ANNOTATES from thoughts), and a field to add one.
// links: the item's incoming links ({rel, key, name, labels}); onAdded: reload the page.
export function thoughtsOn(lib, key, links, { onAdded } = {}) {
  const mine = links.filter((l) => (l.rel === 'ANNOTATES' || l.type === 'ANNOTATES') && labelsOf(l).includes('Thought'));
  const input = h('input', { class: 'input', 'aria-label': 'Add a thought', placeholder: 'Add a thought about this…' });
  const add = async (e) => {
    e.preventDefault();
    const text = input.value.trim(); if (!text) return;
    try {
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const t = await api('/api/items', { method: 'POST', body: { collection: 'thought', slug: `${stamp}-${Math.random().toString(36).slice(2, 8)}`, fields: { text } } });
      await api(`/api/items/${enc(t.key)}/links`, { method: 'PUT', body: { rel: 'ANNOTATES', target: key } });
      input.value = ''; toast('Saved in Thoughts');
      if (onAdded) await onAdded();
    } catch (err) { toast(err.message, 'error'); }
  };
  return h('section', { class: 'thoughtson' }, h('div', { class: 'label' }, 'Your thoughts on this'),
    mine.length ? h('ul', { class: 'inqlist plain' }, mine.map((l) => h('li', { 'data-key': l.key }, h('a', { class: 'ref', onclick: () => lib.openKey(l.key) }, l.name || l.title || l.key)))) : null,
    h('form', { class: 'row-flex', onsubmit: add }, h('div', { class: 'grow' }, input), h('button', { type: 'submit', class: 'btn' }, 'Save')));
}
