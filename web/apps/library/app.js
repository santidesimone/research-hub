// Library: a sidebar of collections grouped by purpose (schema ui_sections), the graph view, the audit and curation.
// Papers keep their list, PDF reader, file link and status, plus an Analysis tab. The other collections get a generic
// list and detail built from the schema (collections.js), and every collection gets create / edit forms (forms.js).
// Addresses: /library/<collection>?key=..[&edit=1], /library/graph, /library/audit, /library/curation, /library/all.
// Anonymous visitors see the public preview (a static export, whitelisted fields only); the owner sees the database.
import { h, icon, api, state as S, BASE, cssVar, loadScript, toast } from '../../shell/ui.js';
import { parseRoute, routePath, collectionOf, sidebarGroups, collectionCounts, graphFilterGroups, GRAPH_OFF_BY_DEFAULT } from './model.js';
import { CollectionView, itemDetail } from './collections.js';
import { ReviewView, reviewCounts } from './review.js';
import { itemForm } from './forms.js';
import { renderFields } from './view.js';
import { Connections } from './connections.js';
import { thoughtsOn } from './thoughts.js';

const statusText = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ') : '');
const STATUS_CHOICES = ['to-read', 'reading', 'read', 'canonical', 'critique-target'];
const relName = (t) => t.toLowerCase().replace(/_/g, ' ');
const keyQuery = (k) => encodeURIComponent(k);

function shortAuthors(p) {
  const a = p.author_lasts || (p.authors || []).map((n) => n.trim().split(/\s+/).at(-1));
  if (!a.length) return '';
  return a.length <= 3 ? a.join(', ') : `${a[0]} et al.`;
}
function wrapLabel(s, n = 24, lines = 3) {
  const words = s.split(/\s+/), out = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > n && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) out.push(cur);
  if (out.length > lines) { out.length = lines; out[lines - 1] = out[lines - 1].replace(/.{0,2}$/, '') + '…'; }
  return out.join('\n');
}

class Library {
  constructor(ctx) {
    this.ctx = ctx;
    this.mode = S.owner ? 'private' : 'public';
    this.view = 'list';
    this.section = 'paper'; this.edit = false; this.focusField = null;
    this.collections = (S.schema && S.schema.collections) || [];
    this.entities = (S.schema && S.schema.entities) || [];
    this.sel = null;
    // ?key=…&upload=1 (the link Claude gives after saving a paper): show a drop zone for that paper's PDF
    const qs = new URLSearchParams(location.search);
    this.uploadKey = qs.get('upload') === '1' ? qs.get('key') : null;
    this.q = ''; this.status = ''; this.sort = 'new'; this.tab = 'info';
    this.graph = { nodes: [], edges: [] }; this.papers = []; this.personal = {};
    this.loading = true; this.error = null;
    this.enabled = new Set();
    this.network = null;
    this.onKey = this.onKey.bind(this);
  }

  /* ---------------------------------------------------------------- lifecycle */
  async start() {
    this.labels = (S.schema && S.schema.labels) || [];
    // graph types shown: as left in this browser, else everything but the large vocabularies
    let off = GRAPH_OFF_BY_DEFAULT;
    try { const saved = JSON.parse(localStorage.getItem('hub-graph-off')); if (Array.isArray(saved)) off = saved; } catch { /* private mode or nothing saved */ }
    this.enabled = new Set(this.labels.map((l) => l.label).filter((l) => !off.includes(l)));
    let collapsed = false;
    try { collapsed = localStorage.getItem('hub-sidebar') === 'collapsed'; } catch { /* private mode */ }
    this.root = h('div', { class: 'libwrap' + (collapsed ? ' collapsed' : '') });
    this.sideEl = h('nav', { class: 'sidebar', 'aria-label': 'Library' });
    this.mobileBarEl = h('div', { class: 'mobilebar' });
    this.bannerEl = h('div', { class: 'banner hidden' }, 'Public preview: built from a static export with no database access. Private nodes, your personal status, abstracts and PDFs are not part of it.');
    this.bodyEl = h('div', { class: 'libbody' });
    // on a phone the sidebar is a drawer; a tap outside it (on the scrim) closes it
    this.scrimEl = h('button', { type: 'button', class: 'scrim', 'aria-label': 'Close the menu', tabindex: '-1', onclick: () => this.drawer(false) });
    this.root.append(this.sideEl, this.scrimEl, h('div', { class: 'libmain' }, this.mobileBarEl, this.bannerEl, this.bodyEl));
    this.ctx.el.replaceChildren(this.root);
    document.addEventListener('keydown', this.onKey);
    this.readRoute();
    this.renderNav();
    this.renderBody();
    await this.loadData();
    this.renderBody();
    this.loadReviewWaiting();
    // older links (/library?key=..) open the item in its own collection
    if (this.section === 'all' && this.sel) { const c = this.collOfKey(this.sel); if (c) this.goSection(c.name, { key: this.sel }, true); }
  }
  destroy() {
    document.removeEventListener('keydown', this.onKey);
    if (this.network) this.network.destroy();
  }
  readRoute() {
    const r = parseRoute(this.ctx.route.rest || [], this.ctx.route.query, this.collections);
    if (r.section === 'review' && !(S.owner && this.mode === 'private')) r.section = 'paper';
    // the old Audit and Curation addresses show the Review tab under its own address
    const old = (this.ctx.route.rest || [])[0];
    if (r.section === 'review' && ['audit', 'curation'].includes(old)) this.ctx.navigate(routePath(r, this.collections), { replace: true });
    this.section = r.section; this.sel = r.key; this.edit = r.edit; this.reviewTab = r.tab || 'check';
    this.view = r.section === 'graph' ? 'graph' : 'list';
  }
  onRoute(ctx) {
    this.ctx = ctx;
    const before = this.section, sel = this.sel, edit = this.edit, tab = this.reviewTab;
    this.readRoute();
    if (before !== this.section || tab !== this.reviewTab) { this.renderBody(); return; }
    if (sel !== this.sel || edit !== this.edit) { if (this.cview) this.cview.show(); else this.showSelection(); }
  }
  onTheme() { if (this.view === 'graph') this.buildGraph(); }
  // older call sites: go({view, key}); list views stay in the current collection
  go({ view = this.view, key = this.sel } = {}, replace = false) {
    const listSection = ['graph', 'review'].includes(this.section) ? 'paper' : this.section;
    this.goSection(view === 'graph' ? 'graph' : listSection, { key }, replace);
  }
  goSection(section, { key = null, edit = false } = {}, replace = false) {
    if (!edit) this.focusField = null;
    this.ctx.navigate(routePath({ section, key, edit }, this.collections), { replace });
  }
  collOfKey(key) { const n = this.graph.nodes.find((x) => x.key === key); return n ? collectionOf(n.labels, this.collections) : null; }
  coll(name) { return this.collections.find((c) => c.name === name); }
  // Open any node where it lives: collection items in their collection, everything else in All.
  openKey(key, replace = false) {
    const c = this.collOfKey(key) || (key.startsWith('doi:') || key.startsWith('paper:') ? this.coll('paper') : null);
    if (this.view === 'graph' && !c) { this.go({ view: 'graph', key }, replace); return; }
    this.goSection(c ? c.name : 'all', { key }, replace);
  }
  editItem(key, field) {
    const c = this.collOfKey(key) || this.collections.find((x) => key.startsWith(x.name === 'use_case' ? 'usecase:' : x.name === 'case_study' ? 'case:' : x.name + ':')) || this.coll('paper');
    this.focusField = field || null; this.goSection(c.name, { key, edit: true });
  }
  async afterDelete(collName) {
    await this.loadData();
    this.goSection(collName, { key: null }, true);
    if (this.cview) this.cview.reload(); else this.renderBody(); // the list must not show what was just deleted
  }
  formCtx() { return { collections: this.collections, entities: this.entities }; }

  /* ---------------------------------------------------------------- data */
  derivePapers() {
    const byKey = new Map(this.graph.nodes.map((n) => [n.key, n]));
    return this.graph.nodes.filter((n) => n.labels.includes('Paper')).map((n) => ({
      key: n.key, props: n.props, has_file: false,
      topics: this.graph.edges.filter((e) => e.from === n.key && e.type === 'ABOUT').map((e) => byKey.get(e.to)).filter(Boolean).map((c) => c.props.name),
    }));
  }
  async loadData() {
    this.loading = true; this.error = null;
    try {
      if (this.mode === 'public') {
        this.graph = await api('/api/public'); this.papers = this.derivePapers(); this.personal = {};
      } else {
        const [g, p] = await Promise.all([api('/api/graph'), api('/api/papers')]);
        this.graph = g; this.papers = p.papers;
        this.personal = S.features.includes('personal') ? (await api('/api/personal')).items : {};
      }
    } catch (e) { this.error = e.message; this.graph = { nodes: [], edges: [] }; this.papers = []; }
    this.loading = false;
  }
  statusOf(key) { return (this.personal[key] || {}).status; }
  async detail(key) {
    if (this.mode === 'private') return api('/api/artifact?key=' + keyQuery(key));
    const n = this.graph.nodes.find((x) => x.key === key);
    if (!n) throw new Error('Not found');
    const find = (k) => this.graph.nodes.find((y) => y.key === k) || { labels: [], props: {} };
    const nm = (k) => find(k).props.title || find(k).props.name || k;
    return { ...n, has_file: false, file: null, html: n.html || null, // html: note text, in the full public view only
      out: this.graph.edges.filter((e) => e.from === key).map((e) => ({ type: e.type, key: e.to, title: nm(e.to), labels: find(e.to).labels })),
      in: this.graph.edges.filter((e) => e.to === key).map((e) => ({ type: e.type, key: e.from, title: nm(e.from), labels: find(e.from).labels })) };
  }
  async setMode(mode) {
    this.mode = mode; this.sel = null; this.status = '';
    this.bannerEl.classList.toggle('hidden', mode !== 'public');
    this.loading = true; this.renderBody();
    await this.loadData(); this.go({ key: null }, true); this.renderBody();
  }

  /* ---------------------------------------------------------------- sidebar */
  renderNav() {
    const counts = this.loading ? {} : collectionCounts(this.graph.nodes, this.collections, this.papers);
    const item = (id, label, count) => h('button', { type: 'button', class: 'nav' + (this.section === id ? ' on' : ''), 'data-section': id,
      'aria-current': this.section === id ? 'page' : null, onclick: () => { this.drawer(false); if (id !== this.section) this.q = ''; this.goSection(id); } },
    h('span', { class: 'grow' }, label), count != null && h('span', { class: 'count' }, String(count)));
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search everything', 'aria-label': 'Search everything',
      onkeydown: (e) => { if (e.key === 'Enter') { this.q = e.target.value; this.drawer(false); if (this.section === 'all') this.renderBody(); else this.goSection('all'); } } });
    const owner = S.owner && this.mode === 'private';
    this.sideEl.replaceChildren(
      h('div', { class: 'sidehead' }, h('div', { class: 'searchbox grow' }, icon('search', 15), search),
        h('button', { type: 'button', class: 'iconbtn small collapse', 'aria-label': 'Hide the sidebar', title: 'Hide the sidebar', onclick: () => this.collapse(true) }, '«')),
      h('button', { type: 'button', class: 'iconbtn small expand', 'aria-label': 'Show the sidebar', title: 'Show the sidebar', onclick: () => this.collapse(false) }, '»'),
      h('div', { class: 'sidescroll' },
        sidebarGroups(this.collections, (S.schema && S.schema.sections) || []).map((g) => h('div', { class: 'navgroup' },
          g.label && h('div', { class: 'navlabel' }, g.label), g.items.map((it) => item(it.id, it.label, counts[it.id])))),
        h('div', { class: 'navsep' }),
        item('graph', 'Graph'),
        owner && item('review', 'Review', this.reviewWaiting ? this.reviewWaiting.check + this.reviewWaiting.fixes : null),
        S.owner && S.publicAccess && h('div', { class: 'seg navmode' }, [['private', 'Private'], ['public', 'Public preview']].map(([m, l]) =>
          h('button', { type: 'button', class: this.mode === m ? 'on' : '', onclick: () => m !== this.mode && this.setMode(m) }, l)))));
    const here = this.coll(this.section);
    this.mobileBarEl.replaceChildren(h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Open the library menu', onclick: () => this.drawer(true) }, icon('menu', 18)),
      h('span', { class: 'mobiletitle' }, here ? here.plural : { graph: 'Graph', review: 'Review', all: 'Search' }[this.section] || 'Library'));
    this.bannerEl.classList.toggle('hidden', this.mode !== 'public');
  }
  collapse(on) {
    this.root.classList.toggle('collapsed', on);
    try { localStorage.setItem('hub-sidebar', on ? 'collapsed' : 'open'); } catch { /* private mode */ }
    if (this.network) setTimeout(() => this.network.redraw(), 0);
  }
  drawer(open) { this.root.classList.toggle('drawer-open', open); }
  goReview(tab) { this.ctx.navigate(routePath({ section: 'review', tab }, this.collections)); }
  // what is waiting in Review ({check, fixes}), shown as one count beside it in the sidebar
  setReviewWaiting(c) {
    const was = this.reviewWaiting ? this.reviewWaiting.check + this.reviewWaiting.fixes : null;
    this.reviewWaiting = { ...c };
    if (was !== c.check + c.fixes) this.renderNav();
  }
  async loadReviewWaiting() {
    if (!(S.owner && this.mode === 'private')) { this.reviewWaiting = null; return; }
    try { this.setReviewWaiting(await reviewCounts()); } catch { /* the sidebar shows Review without a count */ }
  }

  /* ---------------------------------------------------------------- body */
  renderBody() {
    this.renderNav();
    if (this.network && this.view !== 'graph') { this.network.destroy(); this.network = null; }
    this.bodyEl.replaceChildren();
    this.cview = null;
    if (this.view === 'graph') return this.renderGraphView();
    if (this.section === 'review') return new ReviewView(this).mount(this.bodyEl);
    const c = this.coll(this.section);
    if (c && c.name !== 'paper' && this.mode === 'private') { this.cview = new CollectionView(this, c); return this.cview.mount(this.bodyEl); }
    return this.renderListView();
  }
  // Rows for the list view: papers from /api/papers (private) or the export; other sections from the graph nodes.
  rows() {
    if (this.section === 'paper') return this.papers;
    const c = this.coll(this.section);
    return this.graph.nodes.filter((n) => n.labels.includes('Artifact') && (!c || n.labels.includes(c.label)))
      .map((n) => ({ key: n.key, props: n.props, labels: n.labels, topics: [] }));
  }
  sectionNoun() { const c = this.coll(this.section); return c ? c.plural.toLowerCase() : 'items'; }

  /* ---------------------------------------------------------------- list view */
  filtered() {
    const q = this.q.trim().toLowerCase();
    const rows = this.rows().filter((p) => {
      if (this.status && this.statusOf(p.key) !== this.status) return false;
      if (!q) return true;
      return [p.props.title, (p.props.authors || []).join(' '), p.props.venue, p.props.year, (p.topics || []).join(' ')].join(' ').toLowerCase().includes(q);
    });
    const t = (a, b) => a.props.title.localeCompare(b.props.title);
    const by = { new: (a, b) => (b.props.year || 0) - (a.props.year || 0) || t(a, b), old: (a, b) => (a.props.year || 9999) - (b.props.year || 9999) || t(a, b),
      title: t, status: (a, b) => (this.statusOf(a.key) || 'zzz').localeCompare(this.statusOf(b.key) || 'zzz') || t(a, b) };
    return rows.sort(by[this.sort]);
  }
  renderListView() {
    this.searchEl = h('input', { class: 'input', type: 'search', placeholder: 'Search title, author, topic, venue', value: this.q,
      oninput: (e) => { this.q = e.target.value; this.renderList(); } });
    const search = h('div', { class: 'searchbox' }, icon('search', 16), this.searchEl);
    const statuses = [...new Set(this.rows().map((p) => this.statusOf(p.key)).filter(Boolean))].sort();
    const sort = h('select', { class: 'select', onchange: (e) => { this.sort = e.target.value; this.renderList(); } },
      [['new', 'Newest first'], ['old', 'Oldest first'], ['title', 'Title A to Z'], statuses.length && ['status', 'Status']].filter(Boolean).map(([v, l]) => h('option', { value: v, selected: v === this.sort }, l)));
    const status = statuses.length ? h('select', { class: 'select', onchange: (e) => { this.status = e.target.value; this.renderList(); } },
      h('option', { value: '' }, 'Any status'), statuses.map((s) => h('option', { value: s, selected: s === this.status }, s))) : null; // never 0: the DOM would print it
    this.countEl = h('span', { class: 'faint', style: { marginLeft: 'auto', fontSize: '12.5px' } });
    this.listEl = h('ul', { class: 'list', tabindex: '0' });
    this.detailEl = h('div', { class: 'detail' });
    const canCreate = this.mode === 'private' && S.owner && this.section === 'paper';
    this.bodyEl.append(h('div', { class: 'split' },
      h('div', { class: 'pane' }, h('div', { class: 'pane-head' },
        canCreate ? h('div', { class: 'row-flex' }, h('div', { class: 'grow' }, search), h('button', { class: 'btn btn-primary btn-sm', onclick: () => this.goSection('paper', { key: null, edit: true }) }, '+ New')) : search,
        h('div', { class: 'row-flex' }, sort, status, this.countEl)), this.listEl),
      this.detailEl));
    this.renderList();
    this.showSelection();
  }
  renderList() {
    const ul = this.listEl;
    if (this.loading) { ul.replaceChildren(h('li', { class: 'center' }, h('span', { class: 'spinner' }))); this.countEl.textContent = ''; return; }
    if (this.error) {
      ul.replaceChildren(h('li', { style: { padding: '16px' } }, h('div', { class: 'alert' }, 'Could not load data: ' + this.error)));
      this.countEl.textContent = ''; return;
    }
    const rows = this.filtered();
    const all = this.rows().length;
    this.countEl.textContent = `${rows.length} of ${all} ${this.sectionNoun()}`;
    if (!rows.length) {
      ul.replaceChildren(h('li', { class: 'empty', style: { height: 'auto', padding: '40px 16px' } },
        all ? `No ${this.sectionNoun()} match.`
          : this.mode === 'public' ? (S.owner ? 'Nothing is public yet. Set an item\'s Visibility to Public to show it here.' : 'Nothing is public yet. Sign in to see the library.')
          : this.section === 'paper' ? 'No papers yet. Add one with + New, the CLI (hub add <doi>) or Claude.' : `Nothing here yet.`));
      return;
    }
    ul.replaceChildren(...rows.map((p) => {
      const st = this.statusOf(p.key);
      return h('li', null, h('button', { type: 'button', class: 'item' + (p.key === this.sel ? ' active' : ''), 'data-key': p.key, onclick: () => this.open(p.key) },
        h('div', { class: 't' }, p.props.title),
        h('div', { class: 'a' }, [shortAuthors(p.props), p.props.year].filter(Boolean).join(' · ')),
        h('div', { class: 'm' }, h('span', { class: 'grow' }, [this.section !== 'paper' && this.mainLabel(p.labels || []).label, statusText(st), p.props.venue].filter(Boolean).join(' · ')),
          p.has_file && icon('pdf', 16, 'faint'))));
    }));
    const active = ul.querySelector('.item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
  open(key, { replace = false } = {}) {
    if (this.view === 'list' && this.section !== 'all' && this.mode === 'private') { this.openKey(key, replace); return; }
    this.go({ key }, replace);
  }
  onKey(e) {
    if (e.key === 'Escape' && this.root.classList.contains('drawer-open')) { this.drawer(false); return; }
    if (e.key === 'Escape' && this.filterOpen) { this.toggleFilter(false); return; }
    if (this.view !== 'list' || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    if (['INPUT', 'SELECT', 'TEXTAREA', 'IFRAME'].includes(document.activeElement.tagName)) return;
    if (this.cview || this.section === 'review') return;
    const rows = this.filtered(); if (!rows.length) return;
    const i = rows.findIndex((p) => p.key === this.sel);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    e.preventDefault(); this.open(next.key, { replace: true });
  }
  showSelection() {
    if (this.view === 'graph') {
      if (this.sel && this.asideEl) { this.highlight(this.sel); if (this.network) this.network.focus(this.sel, { scale: 1.1, animation: { duration: 400 } }); this.renderDetail(this.asideEl, this.sel, 'graph'); }
      else if (this.asideEl) { this.highlight(null); this.graphPlaceholder(); }
      return;
    }
    if (!this.detailEl) return;
    if (this.loading) { this.detailEl.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'spinner' }))); return; }
    this.listEl.querySelectorAll('.item').forEach((b) => b.classList.toggle('active', b.dataset.key === this.sel));
    const active = this.listEl.querySelector('.item.active'); if (active) active.scrollIntoView({ block: 'nearest' });
    if (this.edit && this.section === 'paper' && this.mode === 'private') this.renderPaperForm(this.sel);
    else if (this.sel) this.renderDetail(this.detailEl, this.sel, 'library');
    else this.detailEl.replaceChildren(h('div', { class: 'empty' }, this.section === 'paper' ? 'Select a paper from the list' : 'Select an item from the list'));
  }

  /* ---------------------------------------------------------------- detail */
  relSection(title, items) {
    if (!items.length) return null;
    return h('section', { class: 'rel' }, h('div', { class: 'label' }, title),
      h('ul', null, items.map((r) => h('li', null, h('span', { class: 'muted small' }, relName(r.type)),
        h('a', { onclick: () => this.open(r.key) }, r.title || r.key)))));
  }
  async renderPaperForm(key) {
    const coll = this.coll('paper');
    this.detailEl.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
    let item = null;
    if (key) { try { item = await api('/api/items/' + keyQuery(key)); } catch (e) { this.detailEl.replaceChildren(h('div', { class: 'alert' }, e.message)); return; } }
    const done = async (res) => { toast(item ? 'Saved' : 'Added'); await this.loadData(); this.goSection('paper', { key: res.key }, true); this.renderList(); this.showSelection(); };
    this.detailEl.replaceChildren(h('div', { class: 'doc' }, itemForm(coll, item, this.formCtx(), { onDone: done, focus: this.focusField,
      onCancel: () => this.goSection('paper', { key }, true) })));
  }
  async renderDetail(container, key, where) {
    // a collection item (method, use case, case study) opened from All or the graph: the schema-driven page
    const c = this.mode === 'private' && this.collOfKey(key);
    if (c && c.name !== 'paper') {
      container.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
      try {
        const item = await api('/api/items/' + keyQuery(key));
        if (key !== this.sel) return;
        container.replaceChildren(itemDetail(this, c, item, { onChanged: () => this.renderDetail(container, key, where) }));
      } catch (e) { container.replaceChildren(h('div', { class: 'alert' }, e.message)); }
      return;
    }
    container.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
    let d;
    try { d = await this.detail(key); } catch (e) { container.replaceChildren(h('div', { class: 'alert' }, e.message)); return; }
    if (key !== this.sel) return; // selection moved on while loading
    const p = d.props;
    const lab = this.labels.find((l) => d.labels.includes(l.label)) || { label: 'Artifact', name: 'artifact' };
    const isPaper = lab.label === 'Paper';
    const wrap = h('article', { class: 'doc' + (where === 'graph' ? ' compact' : '') });
    const info = h('div');
    const eyebrow = [lab.label, isPaper && p.item_type && p.item_type.replace(/([A-Z])/g, ' $1').toLowerCase(), p.year].filter(Boolean).join(' · ');
    wrap.append(h('div', { class: 'eyebrow' }, h('span', { class: 'dot', style: { background: cssVar('--node-' + lab.name) || lab.color } }), eyebrow),
      h('h1', null, p.title || p.name || d.key));
    if (p.authors && p.authors.length) wrap.append(h('p', { class: 'byline', style: where === 'graph' ? { fontSize: '14px' } : null }, p.authors.join(', ')));

    // your personal status (separate layer; only for the signed-in owner, in the private library)
    const st = this.statusOf(d.key);
    const canEdit = this.mode === 'private' && S.owner && S.features.includes('personal');
    const badges = h('div', { class: 'row-flex', style: { marginTop: '12px' } },
      h('span', { class: 'muted', style: { fontSize: '14px' } }, [!canEdit && statusText(st), p.venue, p.visibility === 'public' && 'Public'].filter(Boolean).join(' · ')));
    if (canEdit) badges.prepend(this.statusSelect(d.key, st));
    wrap.append(badges);

    const actions = h('div', { class: 'actions' });
    if (isPaper) {
      if (this.mode === 'private') {
        const f = d.file;
        const noun = f && f.kind === 'drive' ? 'PDF' : 'file';
        if (f) actions.append(where === 'library'
          ? h('button', { class: 'btn btn-primary btn-sm', onclick: () => setTab('reader') }, icon('pdf', 15), 'Read ' + noun)
          : h('a', { class: 'btn btn-primary btn-sm', href: f.url, target: '_blank', rel: 'noopener' }, icon('pdf', 15), 'Open ' + noun));
        else actions.append(h('span', { class: 'btn btn-sm disabled' }, icon('pdf', 15), 'No file linked'));
      } else if (p.file_url) { // the full public view keeps open links (arXiv and the like), never Drive copies
        actions.append(h('a', { class: 'btn btn-primary btn-sm', href: p.file_url, target: '_blank', rel: 'noopener' }, icon('pdf', 15), 'Open file'));
      }
      const href = p.url || (p.doi ? 'https://doi.org/' + p.doi : null);
      if (href) actions.append(h('a', { class: 'btn btn-sm', href, target: '_blank', rel: 'noopener' }, icon('link', 15), p.doi ? 'DOI' : 'Source'));
    }
    if (where === 'graph' && isPaper) actions.append(h('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.goSection('paper', { key: d.key }) }, 'Open in library'));
    if (isPaper && where === 'library' && this.mode === 'private' && S.owner) {
      actions.append(h('button', { class: 'btn btn-sm', onclick: () => this.goSection('paper', { key: d.key, edit: true }) }, 'Edit'));
      const delBtn = h('button', { class: 'btn btn-sm btn-ghost', onclick: () => {
        if (actions.querySelector('.confirm')) return;
        delBtn.after(h('span', { class: 'confirm' }, 'Delete for good? ', h('button', { class: 'btn btn-sm danger', onclick: async () => {
          try { await api('/api/items/' + keyQuery(d.key), { method: 'DELETE' }); toast('Deleted'); await this.afterDelete('paper'); } catch (e) { toast(e.message, 'error'); }
        } }, 'Delete')));
      } }, 'Delete');
      actions.append(delBtn);
    }
    if (actions.children.length) wrap.append(actions);
    if (isPaper && key === this.uploadKey && where === 'library' && this.mode === 'private' && S.owner) wrap.append(this.dropZone(d));

    if (p.summary) info.append(h('p', { class: 'muted', style: { marginTop: '22px', lineHeight: '1.7' } }, p.summary));
    if (p.abstract) info.append(h('div', { class: 'abstract' }, h('div', { class: 'label' }, 'Abstract'), h('p', null, p.abstract)));
    const topics = (d.out || []).filter((r) => r.type === 'ABOUT');
    // topics as plain words, each a search in this list
    if (topics.length) info.append(h('p', { class: 'topics' }, h('span', { class: 'label' }, 'About'), ' ', topics.flatMap((t, i) => [i ? ', ' : '', h('a', { onclick: () => { this.q = t.title; this.go({ view: 'list', key: null }); if (this.view === 'list') { this.searchEl.value = this.q; this.renderList(); } } }, t.title)])));
    if (d.html) info.append(h('div', { class: 'prose', html: d.html }));
    const out = d.out || [], inc = d.in || [];
    const rel = (x) => x;
    if (this.mode === 'private' && S.owner && where === 'library') {
      // the owner manages links in Connections
    } else if (isPaper) {
      [this.relSection('Cites', out.filter((r) => r.type === 'CITES')), this.relSection('Cited by', inc.filter((r) => r.type === 'CITES'))].map(rel).forEach((x) => x && info.append(x));
    } else {
      [this.relSection('Links to', out.filter((r) => r.type !== 'AUTHORED_BY')), this.relSection('Linked from', inc)].forEach((x) => x && info.append(x));
    }
    if (isPaper && where === 'library' && this.mode === 'private' && S.owner) {
      info.append(this.fileEditor(d));
      info.append(thoughtsOn(this, d.key, (d.in || []).map((x) => ({ rel: x.type, key: x.key, name: x.title, labels: x.labels })),
        { onAdded: async () => { await this.loadData(); this.renderNav(); await this.renderDetail(this.detailEl, key, 'library'); } }));
    }
    // the full public view: every field of a collection item, laid out as on the owner's pages
    const full = this.mode === 'public' && this.graph.detail === 'full';
    const fc = full && this.collOfKey(key);
    if (fc) { const box = h('div', { class: 'analysis' }); info.append(box); this.fillPublicFields(box, key, fc); }
    const rows = Object.entries(p).filter(([k]) => !['title', 'name', 'summary', 'abstract', 'authors', 'body'].includes(k) && !(fc && k.endsWith('_json')));
    if (rows.length) info.append(h('details', { class: 'meta' }, h('summary', null, 'Metadata'),
      h('table', { class: 'kv' }, h('tbody', null, rows.map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, String(v))))))));
    wrap.append(info);

    let setTab = () => {};
    if (isPaper && where === 'library' && this.mode === 'private') {
      const reader = h('div', { class: 'reader hidden' });
      const analysis = h('div', { class: 'analysis hidden' });
      const conns = h('div', { class: 'connpane hidden' });
      const tabs = h('div', { class: 'tabs', role: 'tablist' });
      const btn = (id, label) => h('button', { class: 'tab', role: 'tab', 'data-tab': id, onclick: () => setTab(id) }, label);
      tabs.append(...[btn('info', 'Info'), btn('analysis', 'Analysis'), btn('connections', 'Connections'), d.file && btn('reader', 'Reader')].filter(Boolean));
      setTab = (id) => {
        if (id === 'reader' && !d.file) id = 'info';
        this.tab = id;
        tabs.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
        info.classList.toggle('hidden', id !== 'info'); reader.classList.toggle('hidden', id !== 'reader'); analysis.classList.toggle('hidden', id !== 'analysis'); conns.classList.toggle('hidden', id !== 'connections');
        wrap.style.maxWidth = id === 'reader' ? '1100px' : '';
        if (id === 'reader' && !reader.firstChild) reader.append(...this.readerContent(d.file, p.title)); // created on first view so arrowing through the list does not load every file
        if (id === 'analysis' && !analysis.firstChild) this.fillAnalysis(analysis, d.key);
        if (id === 'connections' && !conns.firstChild) this.fillConnections(conns, d.key, tabs.querySelector('[data-tab=connections]'));
      };
      wrap.insertBefore(tabs, info); wrap.append(analysis, conns, reader);
      setTab(this.tab);
    }
    container.replaceChildren(wrap);
    container.scrollTop = 0;
  }
  // A public item's fields for visitors (GET /api/public/items, only while the owner shows everything).
  async fillPublicFields(el, key, coll) {
    try {
      const item = await api('/api/public/items/' + keyQuery(key));
      if (key !== this.sel) return;
      el.append(renderFields(item, coll, { onRef: (k) => this.openKey(k), skip: ['title', 'summary', 'abstract'] }));
    } catch (e) { el.append(h('div', { class: 'alert' }, e.message)); }
  }
  // The paper's schema fields, grouped, with who wrote each (Claude / source / you), confidence and ungrounded flags.
  async fillAnalysis(el, key) {
    el.append(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
    try {
      const item = await api('/api/items/' + keyQuery(key));
      if (key !== this.sel) return;
      const coll = this.coll('paper');
      el.replaceChildren(
        h('div', { class: 'row-flex legendline' }, h('span', { class: 'faint small' }, 'Written by:'), h('span', { class: 'prov prov-claude' }, 'Claude'), h('span', { class: 'prov prov-source' }, 'source'), h('span', { class: 'prov prov-owner' }, 'you'),
          item.record_status && h('span', { class: 'faint small' }, '· ' + (item.record_status === 'reviewed' ? 'reviewed' : 'not reviewed'))),
        renderFields(item, coll, { onRef: (k) => this.openKey(k), showEmpty: true, skip: ['title'] }));
    } catch (e) { el.replaceChildren(h('div', { class: 'alert' }, e.message)); }
  }
  // A paper's Connections tab: every link, managed in one place (connections.js). The tab label shows the count.
  async fillConnections(el, key, tabBtn) {
    el.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
    try {
      const item = await api('/api/items/' + keyQuery(key));
      if (key !== this.sel) return;
      const conn = new Connections(this, this.coll('paper'), item, { onChanged: async () => { await this.loadData(); this.renderNav(); return this.fillConnections(el, key, tabBtn); } });
      el.replaceChildren(conn.render());
      if (tabBtn) tabBtn.textContent = `Connections · ${conn.count}`;
    } catch (e) { el.replaceChildren(h('div', { class: 'alert' }, e.message)); }
  }
  // Google Drive previews embed. Other sites often forbid embedding, so they get an "open" card and an optional try.
  readerContent(f, title) {
    const open = h('a', { class: 'btn btn-ghost btn-sm', href: f.url, target: '_blank', rel: 'noopener' }, 'Open in new tab');
    const bar = h('div', { class: 'row-flex', style: { justifyContent: 'flex-end', marginTop: '10px' } }, open);
    if (f.embed_url) return [bar, h('iframe', { src: f.embed_url, title: 'PDF: ' + title, allow: 'fullscreen' })];
    const holder = h('div');
    const host = (() => { try { return new URL(f.url).hostname; } catch { return f.url; } })();
    const card = h('div', { class: 'filecard' },
      h('p', { style: { margin: '0 0 10px' } }, `This file is on ${host}. Many sites do not allow embedding, so it opens in a new tab. You can try showing it here.`),
      h('div', { class: 'row-flex' },
        h('a', { class: 'btn btn-primary btn-sm', href: f.url, target: '_blank', rel: 'noopener' }, 'Open file'),
        h('button', { class: 'btn btn-sm', onclick: () => { card.remove(); holder.append(h('iframe', { src: f.url, title: 'File: ' + title })); } }, 'Try to show it here')));
    return [bar, card, holder];
  }
  // A large target for the PDF: drop it or choose it; it goes to the owner's Drive, linked to this paper
  dropZone(d) {
    const key = d.key;
    const status = h('p', { class: 'faint', role: 'status' }, d.file ? 'This paper already has a file: a new one replaces it.' : 'It goes to your Google Drive and is linked to this paper.');
    const send = async (f) => {
      if (!f) return;
      if (f.type && f.type !== 'application/pdf') { toast('Only PDF files', 'error'); return; }
      zone.classList.add('busy'); status.textContent = `Uploading ${f.name}…`;
      try {
        await api('/api/papers/file?key=' + keyQuery(key), { method: 'POST', raw: f, headers: { 'Content-Type': 'application/pdf' } });
        this.uploadKey = null; toast('Uploaded to Drive');
        const row = this.papers.find((x) => x.key === key); if (row) row.has_file = true;
        await this.renderDetail(this.detailEl, key, 'library');
      } catch (e) { status.textContent = e.message; zone.classList.remove('busy'); toast(e.message, 'error'); }
    };
    const picker = h('input', { type: 'file', accept: 'application/pdf', class: 'hidden', 'aria-label': 'PDF file', onchange: (e) => send(e.target.files[0]) });
    const zone = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Drop the PDF here or choose a file',
      onclick: () => picker.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } },
      ondragover: (e) => { e.preventDefault(); zone.classList.add('over'); }, ondragleave: () => zone.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); zone.classList.remove('over'); send(e.dataTransfer.files[0]); } },
    h('strong', null, 'Drop the PDF here'), h('span', { class: 'faint' }, 'or click to choose a file'), status, picker);
    return zone;
  }
  fileEditor(d) {
    const key = d.key;
    const input = h('input', { class: 'input', type: 'url', placeholder: 'https://drive.google.com/file/d/…/view  or any https link', value: (d.file && d.file.url) || '', 'aria-label': 'File link' });
    const refresh = (hasFile) => {
      const row = this.papers.find((x) => x.key === key); if (row) row.has_file = hasFile;
      if (this.view === 'list') this.renderList();
      return this.renderDetail(this.detailEl, key, 'library');
    };
    const act = async (fn, done) => { try { await fn(); toast(done); } catch (e) { toast(e.message, 'error'); } };
    const save = () => act(async () => { const v = input.value.trim(); if (!v) throw new Error('Paste a link first'); await api('/api/papers/file?key=' + keyQuery(key), { method: 'PUT', body: { file_url: v } }); await refresh(true); }, 'Link saved');
    const clear = () => act(async () => { await api('/api/papers/file?key=' + keyQuery(key), { method: 'DELETE' }); await refresh(false); }, 'Link removed');
    const picker = h('input', { type: 'file', accept: 'application/pdf', class: 'hidden', onchange: (e) => {
      const f = e.target.files[0]; if (!f) return;
      act(async () => { await api('/api/papers/file?key=' + keyQuery(key), { method: 'POST', raw: f, headers: { 'Content-Type': 'application/pdf' } }); await refresh(true); }, 'Uploaded to Drive');
    } });
    const legacy = d.props.legacy_pdf_uri && !d.file
      && h('p', { class: 'faint', style: { fontSize: '13px' } }, 'An earlier version of the hub stored a PDF for this paper. Add a link above, or upload it to Drive, to read it here.');
    return h('details', { class: 'meta', open: !d.file },
      h('summary', null, d.file ? 'File link' : 'Add a file'),
      h('div', { class: 'row-flex', style: { marginTop: '10px' } }, input,
        h('button', { class: 'btn btn-sm btn-primary', onclick: save }, 'Save link'),
        h('button', { class: 'btn btn-sm', onclick: () => picker.click(), title: 'Uploads to your Google Drive (needs Drive set up on the server)' }, 'Upload PDF'),
        d.file && h('button', { class: 'btn btn-sm btn-ghost', onclick: clear }, 'Remove'), picker),
      d.props.drive_file_id && h('p', { class: 'faint', style: { fontSize: '13px' } }, 'This file was uploaded by the hub; removing or replacing the link moves it to the Drive trash.'),
      legacy);
  }
  statusSelect(key, current) {
    const choices = [...new Set([...STATUS_CHOICES, ...(current ? [current] : [])])];
    return h('select', { class: 'select', 'aria-label': 'Your status', title: 'Your personal status (private layer)',
      onchange: async (e) => {
        const v = e.target.value || null;
        try {
          await api('/api/personal?key=' + keyQuery(key), { method: 'PUT', body: { status: v } });
          if (v) this.personal[key] = { ...(this.personal[key] || {}), status: v }; else delete this.personal[key];
          if (this.view === 'list') this.renderList();
          toast(v ? 'Status: ' + v : 'Status cleared');
        } catch (err) { toast(err.message, 'error'); e.target.value = current || ''; }
      } },
      h('option', { value: '' }, 'No status'), choices.map((s) => h('option', { value: s, selected: s === current }, s)));
  }

  /* ---------------------------------------------------------------- graph view */
  graphPlaceholder() {
    this.asideEl.replaceChildren(h('div', { class: 'empty' }, 'Click a node to inspect it and highlight its neighbours.'));
  }
  renderGraphView() {
    this.statsEl = h('span', { class: 'faint graphstats' });
    this.filterOpen = false;
    this.filterBtn = h('button', { type: 'button', class: 'btn btn-sm', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => this.toggleFilter() }, icon('filter', 15), 'Filter');
    this.filterEl = h('div', { class: 'popover graphfilter hidden', role: 'dialog', 'aria-label': 'Filter the graph' });
    this.filterScrim = h('button', { type: 'button', class: 'popscrim hidden', tabindex: '-1', 'aria-label': 'Close the filter', onclick: () => this.toggleFilter(false) });
    this.legendEl = h('div', { class: 'graphbar' }, this.filterBtn,
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => this.network && this.network.fit({ animation: { duration: 400 } }) }, 'Fit'),
      this.statsEl, this.filterScrim, this.filterEl);
    this.canvasEl = h('div', { class: 'canvas' }, h('div', { id: 'hub-graph' }));
    this.asideEl = h('aside', { class: 'graphaside' });
    this.bodyEl.append(h('div', { class: 'graphwrap' }, h('div', { class: 'graphmain' }, this.legendEl, this.canvasEl), this.asideEl));
    this.graphPlaceholder();
    if (this.loading) { this.canvasEl.firstChild.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'spinner' }))); return; }
    this.buildGraph();
  }
  mainLabel(labels) { return (this.labels.find((l) => labels.includes(l.label)) || { label: 'Artifact', name: 'artifact', big: false }); }
  colorOf(l) { return cssVar('--node-' + l.name) || l.color || '#999'; }
  // The graph filter: a popover of grouped checkboxes with counts, All / None overall and per group, and a type search.
  // It closes on a tap outside or Esc. The choice is remembered in this browser.
  toggleFilter(open = !this.filterOpen) {
    this.filterOpen = open;
    this.filterEl.classList.toggle('hidden', !open); this.filterScrim.classList.toggle('hidden', !open);
    this.filterBtn.setAttribute('aria-expanded', String(open));
    if (open) { this.filterQ = ''; this.renderFilter(); const f = this.filterEl.querySelector('input[type=search]'); if (f) f.focus(); } else this.filterBtn.focus();
  }
  setTypes(labels, on) {
    for (const l of labels) { if (on) this.enabled.add(l); else this.enabled.delete(l); }
    try { localStorage.setItem('hub-graph-off', JSON.stringify(this.labels.map((l) => l.label).filter((l) => !this.enabled.has(l)))); } catch { /* private mode */ }
    this.renderFilter(); this.buildGraph();
  }
  renderFilter() {
    if (!this.filterOpen) return;
    const counts = new Map();
    for (const n of this.graph.nodes) { const l = this.mainLabel(n.labels).label; counts.set(l, (counts.get(l) || 0) + 1); }
    const q = (this.filterQ || '').trim().toLowerCase();
    const groups = graphFilterGroups(this.labels, this.collections, (S.schema && S.schema.sections) || [], this.entities.map((e) => e.label))
      .map((g) => ({ ...g, items: g.items.filter((l) => !q || [l.label, l.plural].join(' ').toLowerCase().includes(q)) })).filter((g) => g.items.length);
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Find a type', 'aria-label': 'Find a type', value: this.filterQ || '',
      oninput: (e) => { this.filterQ = e.target.value; const pos = e.target.selectionStart; this.renderFilter(); const f = this.filterEl.querySelector('input[type=search]'); f.focus(); f.setSelectionRange(pos, pos); } });
    const all = this.labels.map((l) => l.label);
    this.filterEl.replaceChildren(
      h('div', { class: 'pophead' }, h('strong', null, 'Filter'), h('button', { type: 'button', class: 'iconbtn small', 'aria-label': 'Close the filter', onclick: () => this.toggleFilter(false) }, icon('close', 16))),
      h('div', { class: 'searchbox' }, icon('search', 15), search),
      h('div', { class: 'row-flex', style: { margin: '10px 0 2px' } },
        h('button', { type: 'button', class: 'btn btn-sm', 'data-all': 'on', onclick: () => this.setTypes(all, true) }, 'All'),
        h('button', { type: 'button', class: 'btn btn-sm', 'data-all': 'off', onclick: () => this.setTypes(all, false) }, 'None')),
      ...groups.map((g) => h('fieldset', { class: 'filtergroup', 'data-group': g.id },
        h('legend', null, h('span', null, g.label), h('span', { class: 'groupall' },
          h('button', { type: 'button', class: 'linkbtn', onclick: () => this.setTypes(g.items.map((l) => l.label), true) }, 'all'), ' · ',
          h('button', { type: 'button', class: 'linkbtn', onclick: () => this.setTypes(g.items.map((l) => l.label), false) }, 'none'))),
        g.items.map((l) => h('label', { class: 'checkrow' },
          h('input', { type: 'checkbox', 'data-label': l.label, checked: this.enabled.has(l.label), onchange: (e) => this.setTypes([l.label], e.target.checked) }),
          h('span', { class: 'dot', style: { background: this.colorOf(l) } }), h('span', { class: 'grow' }, l.plural || l.label),
          h('span', { class: 'faint small' }, String(counts.get(l.label) || 0)))))),
      !groups.length && h('p', { class: 'faint small' }, 'No type matches.'));
  }
  buildLegend() {
    this.filterBtn.textContent = '';
    const total = this.labels.length, on = this.labels.filter((l) => this.enabled.has(l.label)).length;
    this.filterBtn.append(icon('filter', 15), on === total ? 'Filter' : `Filter · ${on} of ${total}`);
  }
  async buildGraph() {
    if (!this.legendEl) return;
    await loadScript(BASE + '/vendor/vis-network.min.js');
    const vis = window.vis;
    this.buildLegend();
    const text = cssVar('--text'), halo = cssVar('--graph-bg'), edge = cssVar('--edge'), hi = cssVar('--edge-hi'), muted = cssVar('--text-muted');
    const keep = new Set(this.graph.nodes.filter((n) => this.enabled.has(this.mainLabel(n.labels).label)).map((n) => n.key));
    const edges = this.graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    const deg = new Map(); edges.forEach((e) => { deg.set(e.from, (deg.get(e.from) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1); });
    this.fullLabel = new Map(); this.baseLabel = new Map(); this.edgeBase = edge; this.edgeHi = hi;
    const font = (big) => ({ size: big ? 15 : 12, face: 'Inter, system-ui, sans-serif', color: text, strokeWidth: 4, strokeColor: halo });
    const nodes = this.graph.nodes.filter((n) => keep.has(n.key)).map((n) => {
      const l = this.mainLabel(n.labels), big = l.big, d = deg.get(n.key) || 0, c = this.colorOf(l);
      this.fullLabel.set(n.key, wrapLabel(n.props.title || n.props.name || n.key, big ? 24 : 18));
      this.baseLabel.set(n.key, big || d >= 4 ? this.fullLabel.get(n.key) : '');
      return { id: n.key, label: this.baseLabel.get(n.key), title: `${n.props.title || n.props.name} (${l.label})`, shape: 'dot', size: big ? 14 + Math.min(d, 8) * 2 : 6 + Math.min(d, 6),
        font: font(big), borderWidth: 2, color: { background: c, border: halo, highlight: { background: c, border: hi }, hover: { background: c, border: hi } },
        shadow: { enabled: big, size: 8, x: 0, y: 2, color: 'rgba(0,0,0,.2)' }, opacity: 1 };
    });
    const vedges = edges.map((e, i) => ({ id: i, from: e.from, to: e.to, type: e.type, label: '', arrows: { to: { enabled: true, scaleFactor: 0.45 } },
      color: { color: edge, highlight: hi, hover: hi, opacity: 1 }, width: 1, selectionWidth: 2,
      font: { size: 10, color: muted, strokeWidth: 3, strokeColor: halo, align: 'middle' }, smooth: { type: 'continuous' } }));
    this.statsEl.textContent = `Showing ${this.labels.filter((l) => this.enabled.has(l.label)).length} of ${this.labels.length} types · ${nodes.length} nodes · ${vedges.length} edges`;
    if (this.network) this.network.destroy();
    this.nodesDS = new vis.DataSet(nodes); this.edgesDS = new vis.DataSet(vedges);
    const el = this.canvasEl.firstChild;
    this.network = new vis.Network(el, { nodes: this.nodesDS, edges: this.edgesDS }, {
      physics: { solver: 'forceAtlas2Based', forceAtlas2Based: { gravitationalConstant: -120, centralGravity: 0.01, springLength: 150, springConstant: 0.05, damping: 0.55, avoidOverlap: 0.8 }, stabilization: { iterations: 250, fit: true } },
      interaction: { hover: true, tooltipDelay: 200 }, layout: { improvedLayout: nodes.length < 150 } });
    this.network.once('stabilizationIterationsDone', () => { this.network.setOptions({ physics: false }); this.network.fit({ animation: { duration: 500 } }); });
    this.network.on('click', (e) => { if (e.nodes.length) this.go({ view: 'graph', key: e.nodes[0] }, true); else this.go({ view: 'graph', key: null }, true); });
    if (this.sel) setTimeout(() => this.showSelection(), 0);
  }
  highlight(key) {
    if (!this.nodesDS) return;
    const adj = new Set(key ? [key] : []);
    if (key) this.edgesDS.get().forEach((e) => { if (e.from === key || e.to === key) { adj.add(e.from); adj.add(e.to); } });
    this.nodesDS.update(this.nodesDS.get().map((n) => { const on = !key || adj.has(n.id); return { id: n.id, opacity: on ? 1 : 0.15, label: key ? (on ? this.fullLabel.get(n.id) : '') : this.baseLabel.get(n.id) }; }));
    this.edgesDS.update(this.edgesDS.get().map((e) => { const on = key && (e.from === key || e.to === key);
      return { id: e.id, label: on ? relName(e.type) : '', width: on ? 2 : 1, color: { color: on ? this.edgeHi : this.edgeBase, opacity: !key || on ? 1 : 0.1, highlight: this.edgeHi, hover: this.edgeHi } }; }));
    if (key && this.network) this.network.selectNodes([key]);
  }
}

let current = null;
export default {
  async mount(ctx) { current = new Library(ctx); await current.start(); return () => { current.destroy(); current = null; }; },
  onRoute(ctx) { if (current) current.onRoute(ctx); },
  onTheme() { if (current) current.onTheme(); },
};
