// Generic list + detail for a collection (methods, use cases, case studies), built from the schema: list columns,
// filters, sorting, grouped fields with provenance, typed links, and create / edit / delete. Owner, private library.
import { h, icon, api, toast } from '../../shell/ui.js';
import { isEmpty, noun, barEntries, entryOf } from './model.js';
import { renderFields, renderLinks, renderValue } from './view.js';
import { itemForm, linkForm, picker, vocabSearch } from './forms.js';

export class CollectionView {
  // lib: the Library (navigation, schema); coll: the schema collection
  constructor(lib, coll) {
    this.lib = lib; this.coll = coll;
    this.q = ''; this.sort = coll.list_columns.includes('title') ? 'title' : '-updated_at'; this.filters = {};
    this.items = []; this.cursor = null; this.total = 0; this.loading = false; this.error = null;
  }

  mount(bodyEl) {
    const c = this.coll;
    this.searchEl = h('input', { class: 'input', type: 'search', placeholder: `Search ${c.plural.toLowerCase()}`, value: this.q,
      oninput: (e) => { this.q = e.target.value; this.reloadSoon(); } });
    const sortable = ['title', 'created_at', 'updated_at', ...c.list_columns.filter((f) => c.fields[f] && c.fields[f].type !== 'ref' && !c.fields[f].list && f !== 'title')];
    const sort = h('select', { class: 'select', 'aria-label': 'Sort', onchange: (e) => { this.sort = e.target.value; this.reload(); } },
      sortable.flatMap((f) => [[f, `${this.name(f)} ↑`], [`-${f}`, `${this.name(f)} ↓`]]).map(([v, l]) => h('option', { value: v, selected: v === this.sort }, l)));
    this.filterEl = h('div', { class: 'filters' }, c.filters.map((f) => this.filterControl(f)));
    this.countEl = h('span', { class: 'faint small', style: { marginLeft: 'auto' } });
    this.listEl = h('ul', { class: 'list' });
    this.detailEl = h('div', { class: 'detail' });
    // collections grouped in the bar (questions and hypotheses) switch between each other here
    const group = entryOf(barEntries(this.lib.collections), c.name);
    const groupSwitch = group && group.members.length > 1 ? h('div', { class: 'seg groupswitch' }, group.members.map((m) => {
      const mc = this.lib.collections.find((x) => x.name === m);
      return h('button', { type: 'button', class: m === c.name ? 'on' : '', 'data-section': m, onclick: () => m !== c.name && this.lib.goSection(m) }, mc.plural);
    })) : null;
    bodyEl.append(h('div', { class: 'split' },
      h('div', { class: 'pane' }, h('div', { class: 'pane-head' }, groupSwitch,
        h('div', { class: 'row-flex' }, h('div', { class: 'searchbox grow' }, icon('search', 16), this.searchEl),
          h('button', { class: 'btn btn-primary btn-sm', onclick: () => this.lib.goSection(c.name, { key: null, edit: true }) }, '+ New')),
        this.filterEl, h('div', { class: 'row-flex' }, sort, this.countEl)), this.listEl),
      this.detailEl));
    this.reload();
    this.show();
  }
  name(f) { return ((this.coll.fields[f] || {}).label || f.replace(/_/g, ' ')); }

  filterControl(f) {
    const spec = this.coll.fields[f];
    if (!spec) return null;
    if (spec.type === 'ref') {
      const p = picker({ multi: true, allowNew: false, search: vocabSearch(spec.ref), placeholder: this.name(f),
        onChange: (chosen) => this.setFilter(f, chosen.map((x) => x.key).join(',')) });
      return h('div', { class: 'filter', title: this.name(f) }, p.el);
    }
    return h('select', { class: 'select', 'aria-label': this.name(f), onchange: (e) => this.setFilter(f, e.target.value) },
      h('option', { value: '' }, `Any ${this.name(f).toLowerCase()}`), (spec.enum || []).map((v) => h('option', { value: v }, v.replace(/_/g, ' '))));
  }
  setFilter(f, v) { if ((this.filters[f] || '') === v) return; if (v) this.filters[f] = v; else delete this.filters[f]; this.reload(); }

  reloadSoon() { clearTimeout(this.t); this.t = setTimeout(() => this.reload(), 250); }
  query(cursor) {
    const qs = new URLSearchParams({ collection: this.coll.name, sort: this.sort, limit: '50' });
    if (this.q.trim()) qs.set('q', this.q.trim());
    for (const [f, v] of Object.entries(this.filters)) qs.set(f, v);
    if (cursor) qs.set('cursor', cursor);
    return '/api/items?' + qs;
  }
  async reload() {
    this.loading = true; this.items = []; this.cursor = null; this.renderList();
    try { const r = await api(this.query()); this.items = r.items; this.cursor = r.next_cursor; this.total = r.total; this.error = null; } catch (e) { this.error = e.message; }
    this.loading = false; this.renderList();
  }
  async more() {
    try { const r = await api(this.query(this.cursor)); this.items.push(...r.items); this.cursor = r.next_cursor; } catch (e) { toast(e.message, 'error'); }
    this.renderList();
  }
  renderList() {
    const ul = this.listEl;
    if (this.loading) { ul.replaceChildren(h('li', { class: 'center' }, h('span', { class: 'spinner' }))); this.countEl.textContent = ''; return; }
    if (this.error) { ul.replaceChildren(h('li', { style: { padding: '16px' } }, h('div', { class: 'alert' }, this.error))); return; }
    this.countEl.textContent = `${this.items.length} of ${this.total}`;
    if (!this.items.length) { ul.replaceChildren(h('li', { class: 'empty', style: { height: 'auto', padding: '40px 16px' } }, `No ${this.coll.plural.toLowerCase()} match.`)); return; }
    const cols = this.coll.list_columns.filter((f) => f !== 'title');
    ul.replaceChildren(...this.items.map((it) => h('li', null, h('button', { type: 'button', class: 'item' + (it.key === this.lib.sel ? ' active' : ''), 'data-key': it.key, onclick: () => this.lib.goSection(this.coll.name, { key: it.key }) },
      h('div', { class: 't' }, it.title || it.key),
      h('div', { class: 'm' }, it.record_status === 'auto' && h('span', { class: 'badge info', title: 'Not reviewed yet' }, 'auto'),
        cols.map((f) => !isEmpty(it[f]) && h('span', { class: 'col', title: this.name(f) }, renderValue(this.coll.fields[f], it[f]))))))),
    this.cursor ? h('li', { class: 'center' }, h('button', { class: 'btn btn-sm', onclick: () => this.more() }, 'Load more')) : '');
  }

  /* ---------------------------------------------------------------- detail */
  show() {
    const { sel, edit } = this.lib;
    this.listEl.querySelectorAll('.item').forEach((b) => b.classList.toggle('active', b.dataset.key === sel));
    if (edit && !sel) return this.renderForm(null);
    if (!sel) { this.detailEl.replaceChildren(h('div', { class: 'empty' }, `Select a ${noun(this.coll.label)}, or create one`)); return; }
    return this.renderDetail(sel, edit);
  }
  async renderDetail(key, edit) {
    this.detailEl.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
    let item;
    try { item = await api('/api/items/' + encodeURIComponent(key)); } catch (e) { this.detailEl.replaceChildren(h('div', { class: 'alert' }, e.message)); return; }
    if (key !== this.lib.sel) return;
    if (edit) return this.renderForm(item);
    this.detailEl.replaceChildren(itemDetail(this.lib, this.coll, item, { onChanged: () => { this.reload(); this.renderDetail(key, false); } }));
    this.detailEl.scrollTop = 0;
  }
  renderForm(item) {
    const done = (res) => { toast(item ? 'Saved' : 'Created'); this.reload(); this.lib.goSection(this.coll.name, { key: res.key }, true); };
    this.detailEl.replaceChildren(h('div', { class: 'doc' }, itemForm(this.coll, item, this.lib.formCtx(), { onDone: done, focus: this.lib.focusField,
      onCancel: () => this.lib.goSection(this.coll.name, { key: item ? item.key : null }, true) })));
    this.detailEl.scrollTop = 0;
  }
}

// The full item page: header, actions, grouped fields with provenance, links and the add-link editor.
export function itemDetail(lib, coll, item, { onChanged, skip = [], compact = false } = {}) {
  const wrap = h('article', { class: 'doc' });
  const open = (k) => lib.openKey(k);
  if (!compact) {
    wrap.append(h('div', { class: 'eyebrow' }, noun(coll.label), item.record_status === 'auto' && h('span', { class: 'badge info' }, 'not reviewed'),
      item.record_status === 'reviewed' && h('span', { class: 'badge ok' }, 'reviewed')),
    h('h1', null, item.fields.title || item.key));
    if (item.fields.tldr) wrap.append(h('p', { class: 'lead tldr' }, item.fields.tldr));
  }
  const del = async () => {
    if (!wrap.querySelector('.confirm')) { delBtn.after(h('span', { class: 'confirm' }, 'Delete for good? ', h('button', { class: 'btn btn-sm danger', onclick: really }, 'Delete'))); return; }
  };
  const really = async () => {
    try { await api('/api/items/' + encodeURIComponent(item.key), { method: 'DELETE' }); toast('Deleted'); lib.afterDelete(coll.name); } catch (e) { toast(e.message, 'error'); }
  };
  const delBtn = h('button', { class: 'btn btn-sm btn-ghost', onclick: del }, 'Delete');
  wrap.append(h('div', { class: 'actions' },
    h('button', { class: 'btn btn-sm', onclick: () => lib.goSection(coll.name, { key: item.key, edit: true }) }, 'Edit'), delBtn,
    h('span', { class: 'faint small' }, item.key)));
  wrap.append(renderFields(item, coll, { onRef: open, skip: compact ? ['title', ...skip] : ['title', 'tldr', ...skip] }));
  wrap.append(renderLinks(item, { onOpen: open, onRemove: async (l) => {
    try { await api(`/api/items/${encodeURIComponent(item.key)}/links?rel=${encodeURIComponent(l.rel)}&target=${encodeURIComponent(l.key)}`, { method: 'DELETE' }); toast('Link removed'); onChanged && onChanged(); } catch (e) { toast(e.message, 'error'); }
  } }));
  if (coll.relations.length) {
    wrap.append(h('details', { class: 'meta' }, h('summary', null, 'Add a link'), linkForm(coll, item, lib.formCtx(), { onDone: () => { toast('Linked'); onChanged && onChanged(); } })));
  }
  return wrap;
}
