// The audit: what Claude saved that is worth a look (GET /api/audit), with one-click Accept (POST /api/audit/accept)
// and Edit (opens the item's form at that field). Accepting protects a value from re-runs like your own edits.
import { h, api, toast } from '../../shell/ui.js';

const BUCKETS = [
  ['low_confidence', 'Low-confidence fields', 'Fields Claude filled with low confidence.'],
  ['low_confidence_links', 'Links to check', 'Links Claude saved with low confidence, or interpretive links without a location.'],
  ['ungrounded', 'Ungrounded findings', 'Key findings without a page or section.'],
  ['vocab_by_claude', 'New vocabulary', 'Topics, domains, organisations and people Claude created.'],
  ['outdated', 'Older schema version', 'Items analysed before their collection\'s fields last changed.'],
  ['empty_fields', 'Empty Core and Standard fields', 'Fields a full analysis would fill.'],
  ['unreviewed_items', 'Not reviewed', 'Items with values nobody has reviewed yet.'],
];

export class AuditView {
  constructor(lib) { this.lib = lib; }
  async mount(bodyEl) {
    this.el = h('div', { class: 'page audit' });
    bodyEl.append(h('div', { class: 'scroll' }, this.el));
    await this.load();
  }
  async load() {
    this.el.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
    let r;
    try { r = await api('/api/audit?limit=200'); } catch (e) { this.el.replaceChildren(h('div', { class: 'alert' }, e.message)); return; }
    const total = Object.entries(r.counts).filter(([k]) => k !== 'empty_fields' && k !== 'unreviewed_items').reduce((a, [, n]) => a + n, 0);
    this.el.replaceChildren(
      h('h1', { class: 'page-title' }, 'Audit'),
      h('p', { class: 'lead' }, 'Claude saves directly. This is the optional review: accept what is right (it is then protected from re-runs), edit what is not.'),
      h('div', { class: 'row-flex counts' }, BUCKETS.map(([k, label]) => h('a', { class: 'badge ' + (r.counts[k] ? (k === 'empty_fields' || k === 'unreviewed_items' ? 'outline' : 'warn') : 'ok'), href: '#audit-' + k }, `${label}: ${r.counts[k]}`))),
      ...[!total && h('p', { class: 'muted' }, 'Nothing needs a look.'),
        ...BUCKETS.map(([k, label, help]) => this.bucket(k, label, help, r[k] || [], r.counts[k]))].filter(Boolean)); // DOM append prints null/false
  }
  bucket(k, label, help, rows, count) {
    if (!rows.length) return null;
    return h('section', { class: 'auditbucket', id: 'audit-' + k },
      h('h2', { class: 'section-title' }, `${label} (${count})`), h('p', { class: 'faint small' }, help),
      h('ul', { class: 'auditlist' }, rows.map((row) => h('li', null, ...this.row(k, row)))));
  }
  title(row) {
    return h('a', { onclick: () => this.lib.openKey(row.key) }, row.title || row.name || row.key);
  }
  row(k, x) {
    const accept = (body, done) => h('button', { class: 'btn btn-sm', onclick: async (e) => {
      e.target.disabled = true;
      try { await api('/api/audit/accept', { method: 'POST', body }); toast(done); await this.load(); } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
    } }, 'Accept');
    const editAt = (field) => h('button', { class: 'btn btn-sm btn-ghost', onclick: () => this.lib.editItem(x.key, field) }, 'Edit');
    switch (k) {
      case 'low_confidence': return [this.title(x), h('span', { class: 'badge outline' }, x.field), x.model && h('span', { class: 'faint small' }, x.model), h('span', { class: 'grow' }),
        accept({ key: x.key, fields: [x.field] }, 'Accepted'), editAt(x.field)];
      case 'low_confidence_links': return [this.title(x), h('span', { class: 'badge outline' }, x.rel.toLowerCase().replace(/_/g, ' ')), h('span', null, '→ ', x.target),
        x.evidence && h('span', { class: 'evidence' }, '“' + String(x.evidence).slice(0, 60) + '”'), !x.location && h('span', { class: 'flag' }, 'no location'), h('span', { class: 'grow' }),
        accept({ key: x.key, links: [{ rel: x.rel, target: x.target }] }, 'Link accepted'), editAt(null)];
      case 'ungrounded': return [this.title(x), h('span', { class: 'flag' }, `finding ${x.index + 1}`), h('span', { class: 'faint small grow' }, x.text || ''), editAt('key_findings')];
      case 'vocab_by_claude': return [h('span', { class: 'badge outline' }, x.label), h('a', { onclick: () => this.lib.openKey(x.key) }, x.name || x.key), h('span', { class: 'faint small' }, `${x.uses} link${x.uses === 1 ? '' : 's'}`), h('span', { class: 'grow' }),
        accept({ vocab: x.key }, 'Accepted')];
      case 'outdated': return [this.title(x), h('span', { class: 'faint small' }, `version ${x.schema_version ?? 'none'} of ${x.current}`), h('span', { class: 'grow' }), editAt(null)];
      case 'empty_fields': return [this.title(x), h('span', { class: 'faint small grow' }, x.fields.map((f) => f.field).join(', ')), editAt(x.fields[0] && x.fields[0].field)];
      case 'unreviewed_items': return [this.title(x), h('span', { class: 'badge outline' }, x.collection), h('span', { class: 'grow' }), accept({ key: x.key }, 'All fields accepted'), editAt(null)];
      default: return [this.title(x)];
    }
  }
}
