// Review: the owner's one place for checking and fixing the graph. Two tabs: "Check Claude's work" (the audit) and
// "Proposed fixes" (curation plans). Each tab keeps its own address: /library/review and /library/review?tab=fixes.
import { h, api } from '../../shell/ui.js';
import { AuditView, auditWaiting } from './audit.js';
import { CurationView } from './curation.js';

export const REVIEW_TABS = [['check', "Check Claude's work"], ['fixes', 'Proposed fixes']];

// How much is waiting in each tab, for the tab labels and the sidebar.
export async function reviewCounts() {
  const [a, c] = await Promise.all([api('/api/audit?limit=1'), api('/api/curation/plans?status=proposed')]);
  return { check: auditWaiting(a.counts), fixes: c.plans.length };
}

export class ReviewView {
  constructor(lib) { this.lib = lib; this.counts = { ...(lib.reviewWaiting || {}) }; }
  async mount(bodyEl) {
    const tab = this.lib.reviewTab === 'fixes' ? 'fixes' : 'check';
    this.tabsEl = h('div', { class: 'tabs', role: 'tablist' });
    this.paneEl = h('div', { class: 'reviewpane' });
    bodyEl.append(h('div', { class: 'scroll' }, h('div', { class: 'page review' },
      h('h1', { class: 'page-title' }, 'Review'),
      h('p', { class: 'lead' }, 'Check what Claude saved, and decide on proposed fixes to the graph.'),
      this.tabsEl, this.paneEl)));
    this.drawTabs(tab);
    const onCounts = (k) => (n) => { this.counts[k] = n; this.drawTabs(tab); this.lib.setReviewWaiting(this.counts); };
    const View = tab === 'fixes' ? CurationView : AuditView;
    await new View(this.lib, { embedded: true, onCounts: onCounts(tab) }).mount(this.paneEl);
    // the other tab's count, for its label
    try { const c = await reviewCounts(); this.counts = c; this.drawTabs(tab); this.lib.setReviewWaiting(c); } catch { /* the labels keep what they had */ }
  }
  drawTabs(current) {
    this.tabsEl.replaceChildren(...REVIEW_TABS.map(([id, label]) => h('button', { type: 'button', class: 'tab' + (id === current ? ' on' : ''), role: 'tab', 'data-tab': id,
      'aria-selected': id === current ? 'true' : 'false', onclick: () => id !== current && this.lib.goReview(id) },
    label, this.counts[id] != null ? ` · ${this.counts[id]}` : '')));
  }
}
