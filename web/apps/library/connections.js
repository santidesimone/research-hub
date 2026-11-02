// Connections: the one place to see and manage everything an item is linked to. A simple diagram (the item on the
// left, a line out to each group of linked things by type), each link with its role, note and a ⋯ menu (change how it
// relates, edit the note, unlink), Claude's unsure links as suggestions (Link / Dismiss), and Link… to add any link
// the schema allows. Popovers close on a tap outside or Esc. Owner, private library.
import { h, api, icon, toast, cssVar, state as S } from '../../shell/ui.js';
import { connectionGroups, linkOptions, linkableLabels, noun } from './model.js';

const enc = encodeURIComponent;
const linkUrl = (source) => `/api/items/${enc(source)}/links`;

// A popover anchored in `host`, with a transparent scrim behind it that closes it; Esc closes it too.
function popover(host, content, { cls = '', onClose } = {}) {
  host.querySelectorAll(':scope > .popover, :scope > .popscrim').forEach((x) => x.remove());
  const close = () => { scrim.remove(); pop.remove(); document.removeEventListener('keydown', esc, true); if (onClose) onClose(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const scrim = h('button', { type: 'button', class: 'popscrim', tabindex: '-1', 'aria-label': 'Close', onclick: close });
  const pop = h('div', { class: 'popover ' + cls, role: 'dialog' }, content);
  host.append(scrim, pop);
  document.addEventListener('keydown', esc, true);
  const first = pop.querySelector('input, button'); if (first) first.focus();
  return { close, pop };
}

// One option per line, with an optional explanation under it.
const optionList = (opts) => h('div', { class: 'optlist' }, opts.map((o) => h('button', { type: 'button', class: 'opt' + (o.danger ? ' danger' : ''), 'data-option': o.id || o.label, onclick: o.onclick },
  h('span', { class: 'optlabel' }, o.label), o.help && h('span', { class: 'opthelp' }, o.help))));

export class Connections {
  // lib: the Library; coll: this item's collection; item: from GET /api/items/<key>; onChanged: reload the item
  constructor(lib, coll, item, { onChanged } = {}) {
    this.lib = lib; this.coll = coll; this.item = item; this.onChanged = onChanged;
    this.ctx = { collections: lib.collections, sections: (S.schema && S.schema.sections) || [], labels: lib.labels, entityLabels: lib.entities.map((e) => e.label) };
  }
  get count() { return connectionGroups(this.item, this.ctx).reduce((n, g) => n + g.rows.filter((r) => !r.suggested).length, 0); }
  colorOf(name, fallback) { return (name && cssVar('--node-' + name)) || fallback || 'var(--text-faint)'; }
  labelsOfKey(key) { const n = this.lib.graph.nodes.find((x) => x.key === key); return n ? n.labels : []; }

  render() {
    const groups = connectionGroups(this.item, this.ctx);
    const shown = groups.map((g) => ({ ...g, rows: g.rows.filter((r) => !r.suggested) })).filter((g) => g.rows.length);
    const suggestions = groups.flatMap((g) => g.rows.filter((r) => r.suggested));
    const what = noun(this.coll.label);
    this.el = h('div', { class: 'connections' },
      h('div', { class: 'connhead' },
        h('p', { class: 'muted' }, `How this ${what} connects to the rest of your library. Click an item to open it; ⋯ changes or removes a link.`),
        h('div', { class: 'popanchor' }, h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'link', onclick: (e) => this.openPicker(e.currentTarget.parentNode) }, icon('link', 15), 'Link…'))),
      h('div', { class: 'conndiagram' },
        h('div', { class: 'connself' }, h('div', { class: 'connselfcard' }, h('small', null, `This ${what}`), h('strong', null, this.item.fields.title || this.item.key))),
        h('div', { class: 'conntree' }, shown.length ? shown.map((g) => this.group(g)) : h('p', { class: 'faint connempty' }, 'No links yet. Use Link… to connect it.'))),
      suggestions.length ? h('section', { class: 'connsuggest' }, h('div', { class: 'label' }, 'Suggested by Claude'),
        suggestions.map((r) => this.suggestion(r))) : null);
    return this.el;
  }
  group(g) {
    const color = this.colorOf(g.name);
    return h('div', { class: 'conngroup', 'data-group': g.id },
      h('div', { class: 'connlabel' }, h('span', { class: 'dot', style: { background: color } }), `${g.label} · ${g.rows.length}`),
      g.rows.map((r) => h('div', { class: 'connrow', 'data-key': r.key, 'data-rel': r.rel, 'data-dir': r.dir },
        h('span', { class: 'connline', style: { borderColor: color } }),
        h('div', { class: 'conncard' },
          h('span', { class: 'role tone-' + r.tone }, r.role),
          h('button', { type: 'button', class: 'connname', onclick: () => this.lib.openKey(r.key) }, h('span', null, r.name),
            (r.note || r.location) && h('small', null, [r.note, r.location].filter(Boolean).join(' · '))),
          h('div', { class: 'popanchor' }, h('button', { type: 'button', class: 'dots', 'aria-label': 'Options for this link', onclick: (e) => this.rowMenu(e.currentTarget.parentNode, r) }, '⋯'))))));
  }
  suggestion(r) {
    return h('div', { class: 'suggestrow', 'data-key': r.key, 'data-rel': r.rel },
      h('span', { class: 'grow' }, h('strong', null, r.role), ' → ', h('a', { onclick: () => this.lib.openKey(r.key) }, r.name), r.note && h('small', null, r.note)),
      h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => this.act(() => api('/api/audit/accept', { method: 'POST', body: { key: r.source, links: [{ rel: r.rel, target: r.target }] } }), 'Linked') }, 'Link'),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => this.act(() => this.unlink(r), 'Dismissed') }, 'Dismiss'));
  }

  async act(fn, done) {
    try { await fn(); toast(done); if (this.onChanged) await this.onChanged(); } catch (e) { toast(e.message, 'error'); }
  }
  unlink(r) { return api(`${linkUrl(r.source)}?rel=${enc(r.rel)}&target=${enc(r.target)}`, { method: 'DELETE' }); }
  // a link written again with the same relation keeps one relationship and updates its note (it becomes yours)
  put(dir, rel, other, body) {
    const [source, target] = dir === 'out' ? [this.item.key, other] : [other, this.item.key];
    return api(linkUrl(source), { method: 'PUT', body: { rel, target, ...body } });
  }

  rowMenu(host, r) {
    const p = popover(host, null, { cls: 'rowmenu' });
    const main = () => p.pop.replaceChildren(r.field
      ? optionList([{ id: 'form', label: 'Change it in the form', help: 'This link is a field of the item.', onclick: () => { p.close(); this.lib.editItem(r.source, r.field); } }])
      : optionList([
        { id: 'change', label: 'Change how it relates', onclick: change },
        { id: 'note', label: r.note || r.location ? 'Edit the note' : 'Add a note', onclick: note },
        { id: 'unlink', label: 'Unlink', danger: true, onclick: () => { p.close(); this.act(() => this.unlink(r), 'Unlinked'); } }]));
    const change = () => {
      const opts = linkOptions(this.coll, this.labelsOfKey(r.key), this.lib.collections).filter((o) => !(o.dir === r.dir && o.rel === r.rel && (o.props.result || null) === r.result));
      p.pop.replaceChildren(h('button', { type: 'button', class: 'linkbtn back', onclick: main }, '← Back'),
        opts.length ? optionList(opts.map((o) => ({ label: o.label, onclick: () => { p.close(); this.act(async () => {
          await this.put(o.dir, o.rel, r.key, { ...o.props, evidence: r.note || undefined, location: r.location || undefined });
          await this.unlink(r);
        }, 'Changed'); } }))) : h('p', { class: 'faint small' }, 'The schema allows no other way to link these two.'));
    };
    const note = () => {
      const ev = h('textarea', { class: 'textarea prose-input', rows: 3, 'aria-label': 'Note', placeholder: 'Why it matters, or the passage' }, r.note || '');
      const loc = h('input', { class: 'input', 'aria-label': 'Location', placeholder: 'Page or section', value: r.location || '' });
      p.pop.replaceChildren(h('button', { type: 'button', class: 'linkbtn back', onclick: main }, '← Back'),
        h('form', { class: 'noteform', onsubmit: (e) => { e.preventDefault(); p.close(); this.act(() => this.put(r.dir, r.rel, r.key, {
          evidence: ev.value.trim() || undefined, location: loc.value.trim() || undefined, ...(r.result ? { result: r.result } : {}) }), 'Note saved'); } },
        ev, loc, h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-sm btn-primary' }, 'Save'))));
      ev.focus();
    };
    main();
  }

  // Link…: find anything the schema lets this item link to, then say how it relates (with an optional note).
  openPicker(host) {
    const kinds = linkableLabels(this.coll, this.lib.collections);
    const p = popover(host, null, { cls: 'linkpicker' });
    let seq = 0;
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Find a question, hypothesis, method, concept, paper…', 'aria-label': 'Find what to link' });
    const results = h('div', { class: 'linkresults' });
    const find = async () => {
      const q = search.value.trim(), mine = ++seq;
      const jobs = kinds.map(async (label) => {
        const c = this.lib.collections.find((x) => x.label === label);
        const ent = this.lib.entities.find((e) => e.label === label);
        if (!c && !ent) return null;
        const items = c ? (await api(`/api/items?collection=${c.name}&limit=5${q ? '&q=' + enc(q) : ''}`)).items.map((x) => ({ key: x.key, name: x.title || x.key }))
          : (await api(`/api/vocab?kind=${enc(label)}&limit=5&q=${enc(q)}`)).items.map((x) => ({ key: x.key, name: x.name }));
        const l = this.lib.labels.find((x) => x.label === label) || {};
        return { label, plural: l.plural || label, color: this.colorOf(l.name, l.color), items: items.filter((x) => x.key !== this.item.key) };
      });
      let groups;
      try { groups = (await Promise.all(jobs)).filter((g) => g && g.items.length); } catch (e) { results.replaceChildren(h('div', { class: 'alert' }, e.message)); return; }
      if (mine !== seq) return;
      results.replaceChildren(...(groups.length ? groups.map((g) => h('div', { class: 'linkgroup', 'data-kind': g.label },
        h('div', { class: 'connlabel' }, h('span', { class: 'dot', style: { background: g.color } }), g.plural),
        optionList(g.items.map((x) => ({ id: x.key, label: x.name, onclick: () => roles(x, g.label) }))))) : [h('p', { class: 'faint small' }, 'Nothing matches.')]));
    };
    let t;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(find, 200); });
    const roles = (x, label) => {
      const opts = linkOptions(this.coll, [label, ...this.labelsOfKey(x.key)], this.lib.collections);
      const ev = h('input', { class: 'input', 'aria-label': 'Note', placeholder: 'Note (optional): why it matters' });
      const loc = h('input', { class: 'input', 'aria-label': 'Location', placeholder: 'Page or section (optional)' });
      p.pop.replaceChildren(h('button', { type: 'button', class: 'linkbtn back', onclick: start }, '← Back'),
        h('p', { class: 'faint small', style: { margin: '10px 0 2px' } }, 'How does it relate to'), h('p', { class: 'linkwhat' }, x.name),
        h('div', { class: 'row-flex' }, ev, loc),
        optionList(opts.map((o) => ({ id: `${o.dir}:${o.rel}:${o.props.result || ''}`, label: o.label, onclick: () => { p.close(); this.act(() => this.put(o.dir, o.rel, x.key, {
          ...o.props, evidence: ev.value.trim() || undefined, location: loc.value.trim() || undefined }), 'Linked'); } }))));
    };
    const start = () => {
      p.pop.replaceChildren(h('div', { class: 'pophead' }, h('strong', null, 'Link to…'), h('button', { type: 'button', class: 'iconbtn small', 'aria-label': 'Close', onclick: p.close }, icon('close', 16))),
        h('div', { class: 'searchbox' }, icon('search', 15), search), results);
      search.focus();
      find();
    };
    start();
  }
}
