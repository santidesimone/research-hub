// Curation: change plans proposed by Claude (MCP propose_changes) or by you (POST /api/curation/plans). Each plan lists
// exactly what it will change; Apply runs it in one transaction, Reject drops it, Undo reverts an applied plan.
import { h, api, toast } from '../../shell/ui.js';

const FILTERS = [['proposed', 'To review'], ['applied', 'Applied'], ['', 'All']];
const STATUS_TEXT = { proposed: 'To review', applied: 'Applied', rejected: 'Rejected', reverted: 'Undone' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const linkCounts = (o) => Object.entries(o || {}).map(([t, n]) => `${t} ×${n}`).join(', ');

export class CurationView {
  // embedded: inside Review, which has the page title and tabs
  constructor(lib, { embedded = false, onCounts } = {}) { this.lib = lib; this.filter = 'proposed'; this.embedded = embedded; this.onCounts = onCounts; }
  async mount(bodyEl) {
    this.el = h('div', { class: this.embedded ? 'audit curation' : 'page audit curation' });
    bodyEl.append(this.embedded ? this.el : h('div', { class: 'scroll' }, this.el));
    await this.load();
  }
  async load() {
    this.el.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
    let r;
    try { r = await api('/api/curation/plans' + (this.filter ? '?status=' + this.filter : '')); } catch (e) { this.el.replaceChildren(h('div', { class: 'alert' }, e.message)); return; }
    const seg = h('div', { class: 'seg' }, FILTERS.map(([id, label]) => h('button', { class: this.filter === id ? 'on' : '', 'data-filter': id, onclick: () => { this.filter = id; this.load(); } }, label)));
    if (this.onCounts && this.filter === 'proposed') this.onCounts(r.plans.length);
    this.el.replaceChildren(...[ // the DOM would print false
      !this.embedded && h('h1', { class: 'page-title' }, 'Curation'),
      h('p', { class: 'lead' }, 'Fixes to the graph, proposed by Claude or by you: merging duplicates, removing wrong links, deleting junk, renaming concepts. Nothing changes until you apply a plan, and an applied plan can be undone.'),
      h('div', { style: { marginTop: '18px' } }, seg),
      r.plans.length ? h('div', { class: 'plans' }, r.plans.map((p) => this.plan(p)))
        : h('p', { class: 'muted', style: { marginTop: '18px' } }, this.filter === 'proposed' ? 'Nothing to review. Ask Claude in the chat to check the graph and propose fixes.' : 'No plans yet.')].filter(Boolean));
  }
  key(k) { return h('a', { class: 'keylink', onclick: () => this.lib.openKey(k) }, k); }
  change(c) {
    if (c.op === 'merge') {
      return h('div', { class: 'change' },
        h('p', null, h('strong', null, 'Merge '), this.key(c.drop), ' into ', this.key(c.keep), c.from_kind ? ` (a ${c.from_kind} into a ${c.to_kind}; ${c.drop} is then deleted)` : ` (${c.drop} is then deleted)`),
        h('ul', { class: 'facts' }, [
          Object.keys(c.moved_links).length && h('li', null, `Links moved: ${linkCounts(c.moved_links)}`),
          c.dropped_links && h('li', null, `${plural(c.dropped_links, 'link')} not moved (already on ${c.keep}, or pointing at itself)`),
          c.copied.length && h('li', null, `Fields copied (empty on ${c.keep}): ${c.copied.join(', ')}`),
          c.taken.length && h('li', null, `Fields replaced with ${c.drop}'s value: ${c.taken.join(', ')}`),
          c.aliases_added.length && h('li', null, `New aliases on ${c.keep}: ${c.aliases_added.join(', ')}`),
          c.not_copied && c.not_copied.length && h('li', null, `Not carried over (${c.from_kind} fields): ${c.not_copied.join(', ')}`),
          c.personal && h('li', null, `Status: ${c.personal}`),
          c.file && h('li', null, `File: ${c.file}`),
        ].filter(Boolean)),
        c.conflicts.length ? h('table', { class: 'kv conflicts' },
          h('thead', null, h('tr', null, h('th', null, 'Field'), h('th', null, `${c.keep} (kept)`), h('th', null, c.drop))),
          h('tbody', null, c.conflicts.map((x) => h('tr', null, h('td', null, x.field), h('td', null, x.keep), h('td', { class: 'faint' }, x.drop))))) : null);
    }
    if (c.op === 'unlink') return h('div', { class: 'change' }, h('p', null, h('strong', null, 'Remove link '), this.key(c.from), ` —${c.rel}→ `, this.key(c.to)));
    if (c.op === 'delete') {
      return h('div', { class: 'change' },
        h('p', null, h('strong', null, 'Delete '), `${c.title} (`, this.key(c.key), ')'),
        h('ul', { class: 'facts' }, [
          Object.keys(c.links).length && h('li', null, `Links removed: ${linkCounts(c.links)}`),
          c.orphans.length && h('li', null, `Also deleted, nothing else uses them: ${c.orphans.join(', ')}`),
          c.personal && h('li', null, 'Your status on it is removed'),
          c.file && h('li', null, `File: ${c.file}`),
        ].filter(Boolean)));
    }
    if (c.op === 'rename') return h('div', { class: 'change' }, h('p', null, h('strong', null, 'Rename '), this.key(c.key), `: “${c.from}” → “${c.to}” (the old name stays as an alias)`));
    return h('pre', { class: 'json' }, JSON.stringify(c, null, 2));
  }
  plan(p) {
    const who = p.by === 'claude' ? `Claude${p.model ? ' (' + p.model + ')' : ''}` : p.by === 'hub' ? 'the hub' : 'you';
    const when = (p.applied_at || p.reverted_at || p.rejected_at || p.at || '').slice(0, 16).replace('T', ' ');
    const actions = h('div', { class: 'actions' });
    const act = (label, path, cls, confirmLabel) => {
      const b = h('button', { class: 'btn btn-sm ' + cls, 'data-action': path, onclick: async () => {
        if (confirmLabel && !b.dataset.armed) { b.dataset.armed = '1'; b.textContent = confirmLabel; return; }
        b.disabled = true;
        try { await api(`/api/curation/plans/${encodeURIComponent(p.id)}/${path}`, { method: 'POST' }); toast({ apply: 'Applied', reject: 'Rejected', revert: 'Undone' }[path]); await this.load(); }
        catch (e) { toast(e.message, 'error'); b.disabled = false; delete b.dataset.armed; b.textContent = label; }
      } }, label);
      return b;
    };
    if (p.status === 'proposed') actions.append(act('Apply', 'apply', 'btn-primary', 'Click again to apply'), act('Reject', 'reject', 'btn-ghost'));
    if (p.status === 'applied') actions.append(act('Undo', 'revert', '', 'Click again to undo'));
    return h('section', { class: 'card plan', 'data-plan': p.id, style: { marginTop: '14px' } },
      h('div', { class: 'row-flex' }, h('span', { class: 'planstatus small', 'data-status': p.status }, STATUS_TEXT[p.status] || p.status), h('span', { class: 'faint small' }, `${who} · ${when}`)),
      p.reason && h('p', { style: { margin: '10px 0 0' } }, p.reason),
      ...p.changes.map((c) => this.change(c)),
      p.drive_trash.length ? h('div', { class: 'alert', style: { marginTop: '10px' } }, `${plural(p.drive_trash.length, 'file')} in your Google Drive will go to the Drive trash (Undo takes them out again).`) : null,
      actions.children.length ? actions : null);
  }
}
