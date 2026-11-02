// The top of a research question's and a hypothesis's Info tab (docs/UI_REDESIGN.md section 3). Questions and
// hypotheses are the owner's; sources inform them. A question shows its broader question, the hypotheses that answer
// it (each with its verdict), its narrower questions and the sources that inform it. A hypothesis shows its verdict
// and evidence bar, the papers that tested it, the other sources that inform it and the questions it answers.
// Link… opens the same picker as Connections. Everything is plain words and links; colours carry the result.
import { h, api } from '../../shell/ui.js';
import { hypothesisVerdict } from './model.js';

const words = (s) => String(s || '').replace(/_/g, ' ');
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const STATUS_TONE = { supported: 'agree', refuted: 'disagree', mixed: 'mixed', inconclusive: 'mixed' };

function section(title, conn, kids) {
  const anchor = conn && h('div', { class: 'popanchor' }, h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'link', onclick: (e) => conn.openPicker(e.currentTarget.parentNode) }, 'Link…'));
  return h('section', { class: 'inqsec' }, h('div', { class: 'inqhead' }, h('div', { class: 'label' }, title), anchor), kids);
}
const linkTo = (lib, l) => h('a', { class: 'ref', onclick: () => lib.openKey(l.key) }, l.name || l.key);
const noteOf = (l) => [l.evidence, l.location].filter(Boolean).join(' · ');
const empty = (text) => h('p', { class: 'faint inqempty' }, text);

function bar(counts, n) {
  if (!n) return null;
  const w = (k) => `${(100 * k) / n}%`;
  return h('div', { class: 'evbar', role: 'img', 'aria-label': `${counts.supported} supported, ${counts.mixed + counts.inconclusive} mixed or inconclusive, ${counts.refuted} refuted` },
    h('span', { class: 'ev-agree', style: { width: w(counts.supported) } }), h('span', { class: 'ev-mixed', style: { width: w(counts.mixed + counts.inconclusive) } }),
    h('span', { class: 'ev-disagree', style: { width: w(counts.refuted) } }));
}

export function hypothesisOverview(lib, item, conn) {
  const tests = item.links.in.filter((l) => l.rel === 'TESTS');
  const informs = item.links.in.filter((l) => l.rel === 'INFORMS');
  const answers = item.links.out.filter((l) => l.rel === 'ANSWERS');
  const v = hypothesisVerdict(tests.map((l) => l.result));
  const status = item.fields.status || 'untested';
  return h('div', { class: 'inquiry' },
    h('p', { class: 'verdict' }, h('strong', { class: 'tone-' + (STATUS_TONE[status] || 'neutral') }, cap(words(status)) + '.'), ' ', v.text),
    bar(v.counts, v.n),
    section('Papers that tested it', conn, tests.length ? h('ul', { class: 'inqlist' }, tests.map((l) => h('li', { 'data-key': l.key },
      h('span', { class: 'res tone-' + (STATUS_TONE[l.result] || 'neutral') }, l.result === 'supported' ? 'Supports it' : l.result === 'refuted' ? 'Refutes it' : cap(l.result || '')),
      h('span', { class: 'grow' }, linkTo(lib, l), l.evidence && h('small', null, l.evidence)), l.location && h('span', { class: 'faint small' }, l.location))))
      : empty('None yet. Ask Claude to look for papers that test it.')),
    informs.length ? section('Other relevant sources', null, h('ul', { class: 'inqlist' }, informs.map((l) => h('li', { 'data-key': l.key },
      h('span', { class: 'res tone-' + (l.role === 'supports' ? 'agree' : l.role === 'challenges' ? 'disagree' : 'neutral') }, cap(l.role || 'informs')),
      h('span', { class: 'grow' }, linkTo(lib, l), noteOf(l) && h('small', null, noteOf(l))))))) : null,
    section('Questions it answers', conn, answers.length ? h('ul', { class: 'inqlist plain' }, answers.map((l) => h('li', { 'data-key': l.key }, '→ ', linkTo(lib, l))))
      : empty('Not linked to a question.')));
}

// The hypotheses answering a question, each with its verdict (one request each, in parallel).
async function verdicts(keys) {
  const out = new Map();
  await Promise.all(keys.map(async (k) => {
    try {
      const it = await api('/api/items/' + encodeURIComponent(k));
      out.set(k, { status: it.fields.status || 'untested', v: hypothesisVerdict(it.links.in.filter((l) => l.rel === 'TESTS').map((l) => l.result)) });
    } catch { /* shown without a verdict */ }
  }));
  return out;
}

export function questionOverview(lib, item, conn) {
  const broader = item.links.out.filter((l) => l.rel === 'SUB_QUESTION_OF');
  const narrower = item.links.in.filter((l) => l.rel === 'SUB_QUESTION_OF');
  const hyps = item.links.in.filter((l) => l.rel === 'ANSWERS');
  const sources = item.links.in.filter((l) => l.rel === 'INFORMS');
  const cards = h('div', { class: 'hypcards' }, hyps.map((l) => h('button', { type: 'button', class: 'hypcard', 'data-key': l.key, onclick: () => lib.openKey(l.key) },
    h('span', { class: 'hyptitle' }, l.name || l.key), h('span', { class: 'hypverdict faint' }, ' '))));
  if (hyps.length) {
    verdicts(hyps.map((l) => l.key)).then((m) => {
      for (const card of cards.querySelectorAll('.hypcard')) {
        const x = m.get(card.dataset.key); if (!x) continue;
        card.querySelector('.hypverdict').replaceChildren(h('strong', { class: 'tone-' + (STATUS_TONE[x.status] || 'neutral') }, cap(words(x.status)) + '.'), ' ', x.v.text);
      }
    });
  }
  return h('div', { class: 'inquiry' },
    broader.length ? h('p', { class: 'partof muted' }, 'Part of: ', broader.flatMap((l, i) => [i ? ', ' : '', linkTo(lib, l)])) : null,
    section('Hypotheses', conn, hyps.length ? cards : empty('No hypothesis yet. Link one, or turn a thought into one.')),
    narrower.length ? section('Narrower questions', null, h('ul', { class: 'inqlist plain' }, narrower.map((l) => h('li', { 'data-key': l.key }, '→ ', linkTo(lib, l))))) : null,
    section('Sources that inform it', conn, sources.length ? h('ul', { class: 'inqlist' }, sources.map((l) => h('li', { 'data-key': l.key },
      h('span', { class: 'res tone-' + (l.role === 'supports' ? 'agree' : l.role === 'challenges' ? 'disagree' : 'neutral') }, cap(l.role || 'informs')),
      h('span', { class: 'grow' }, linkTo(lib, l), noteOf(l) && h('small', null, noteOf(l))))))
      : empty('No source yet. Link the papers and books that bear on it.')));
}
