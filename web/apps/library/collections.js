// Generic list + detail for a collection (methods, use cases, case studies), built from the schema: list columns,
// filters, sorting, grouped fields with provenance, typed links, and create / edit / delete. Owner, private library.
import { h, icon, api, toast } from '../../shell/ui.js';
import { isEmpty, noun, plainValue } from './model.js';
import { renderFields } from './view.js';
import { Connections } from './connections.js';
import { questionOverview, hypothesisOverview } from './inquiry.js';
import { thoughtOverview, thoughtsOn } from './thoughts.js';
import { popover } from './connections.js';
import { itemForm, picker, vocabSearch } from './forms.js';

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
    bodyEl.append(h('div', { class: 'split' },
      h('div', { class: 'pane' }, h('div', { class: 'pane-head' },
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
      h('div', { class: 'm' }, h('span', { class: 'grow' }, [...cols.filter((f) => !isEmpty(it[f])).map((f) => plainValue(this.coll.fields[f], it[f])), it.record_status === 'auto' && 'Not reviewed'].filter(Boolean).join(' · ')))))),
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

// An ontology's optional snapshot: a frozen copy in Drive. Shared by link like every upload, so the owner confirms the
// license allows it before uploading; a snapshot older than the record's version says so.
function snapshotPanel(item, onChanged) {
  const snap = item.fields.snapshot;
  const current = item.fields.version;
  const stale = snap && snap.version && current && snap.version !== current;
  const file = h('input', { type: 'file', 'aria-label': 'Snapshot file' });
  const ok = h('input', { type: 'checkbox', id: 'snap-license' });
  const go = h('button', { type: 'button', class: 'btn btn-sm btn-primary', disabled: true }, 'Upload snapshot');
  const ready = () => { go.disabled = !(ok.checked && file.files && file.files.length); };
  ok.addEventListener('change', ready); file.addEventListener('change', ready);
  go.addEventListener('click', async () => {
    const f = file.files[0];
    go.disabled = true;
    try {
      await api(`/api/ontologies/snapshot?key=${encodeURIComponent(item.key)}&name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: f, headers: { 'Content-Type': 'application/octet-stream' } });
      toast('Snapshot stored in your Drive'); onChanged && onChanged();
    } catch (e) { toast(e.message, 'error'); ready(); }
  });
  const remove = snap && h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: async () => {
    try { await api(`/api/ontologies/snapshot?key=${encodeURIComponent(item.key)}`, { method: 'DELETE' }); toast('Snapshot removed'); onChanged && onChanged(); } catch (e) { toast(e.message, 'error'); }
  } }, 'Remove snapshot');
  return h('details', { class: 'meta snapshot', open: Boolean(stale) },
    h('summary', null, snap ? `Snapshot${snap.version ? ' of ' + snap.version : ''}` : 'Snapshot (none)'),
    snap && h('p', { class: 'small' }, h('a', { href: snap.file_url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the copy'),
      ` · retrieved ${String(snap.retrieved_at || '').slice(0, 10)} · ${Math.round((snap.size_bytes || 0) / 1024)} KB · sha256 ${String(snap.sha256 || '').slice(0, 12)}…`),
    stale && h('p', { class: 'flag stale' }, `This snapshot is of version ${snap.version}; the record now says ${current}.`),
    h('p', { class: 'faint small' }, 'A snapshot is a frozen copy in your Google Drive, shared by link like every upload. Only keep one if the resource\'s license allows it.'),
    h('div', { class: 'row-flex' }, file),
    h('label', { class: 'row-flex small', for: 'snap-license' }, ok, 'I checked the license: a copy may be kept and shared by link'),
    h('div', { class: 'actions' }, go, remove));
}

// The full item page: header, actions, and two tabs: Info (grouped fields with provenance) and Connections.
export function itemDetail(lib, coll, item, { onChanged, skip = [], compact = false } = {}) {
  const wrap = h('article', { class: 'doc' });
  const open = (k) => lib.openKey(k);
  if (!compact) {
    const inquiryStatus = ['research_question', 'hypothesis'].includes(coll.name) && item.fields.status ? String(item.fields.status).replace(/_/g, ' ') : null;
    wrap.append(h('div', { class: 'eyebrow' }, [noun(coll.label), inquiryStatus, item.record_status === 'auto' ? 'not reviewed' : item.record_status === 'reviewed' ? 'reviewed' : null].filter(Boolean).join(' · ')),
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
  const conn = new Connections(lib, coll, item, { onChanged });
  // questions and hypotheses open on their overview (inquiry.js); their text and status are in the header already
  const overview = coll.name === 'research_question' ? questionOverview(lib, item, conn) : coll.name === 'hypothesis' ? hypothesisOverview(lib, item, conn)
    : coll.name === 'thought' ? thoughtOverview(lib, item, popover, { onChanged }) : null;
  const more = coll.name === 'thought' ? ['text', 'state', 'suggested_as', 'suggested_reason'] : overview ? [coll.fields.text ? 'text' : 'statement', 'status'] : [];
  const info = h('div', { class: 'tabpane' }, overview, renderFields(item, coll, { onRef: open, skip: compact ? ['title', ...more, ...skip] : ['title', 'tldr', ...more, ...skip] }),
    coll.name === 'ontology' && snapshotPanel(item, onChanged),
    coll.name !== 'thought' && thoughtsOn(lib, item.key, item.links.in, { onAdded: async () => { await lib.loadData(); lib.renderNav(); if (onChanged) await onChanged(); } }));
  const connEl = h('div', { class: 'tabpane' }, conn.render());
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const setTab = (id) => {
    lib.itemTab = id;
    tabs.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    info.classList.toggle('hidden', id !== 'info'); connEl.classList.toggle('hidden', id !== 'connections');
  };
  tabs.append(h('button', { type: 'button', class: 'tab', role: 'tab', 'data-tab': 'info', onclick: () => setTab('info') }, 'Info'),
    h('button', { type: 'button', class: 'tab', role: 'tab', 'data-tab': 'connections', onclick: () => setTab('connections') }, `Connections · ${conn.count}`));
  wrap.append(tabs, info, connEl);
  setTab(lib.itemTab === 'connections' ? 'connections' : 'info');
  return wrap;
}
