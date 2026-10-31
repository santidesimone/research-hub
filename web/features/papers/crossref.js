// DOI -> metadata through Crossref (a public service), so a paper can be added from a DOI alone.
const { cleanDoi } = require('./item');
const config = require('../../core/config');

const TYPES = { 'journal-article': 'journalArticle', 'proceedings-article': 'conferencePaper', 'book-chapter': 'bookSection',
  book: 'book', 'posted-content': 'preprint', report: 'report', dissertation: 'thesis' };
const dateOf = (parts) => parts.filter((x) => x != null).map((x, i) => (i ? String(x).padStart(2, '0') : String(x))).join('-') || undefined;

let http = (url, opts) => fetch(url, opts); // replaceable so tests never touch the network
const setHttp = (fn) => { http = fn; };

async function resolveDoi(doi) {
  const res = await http('https://api.crossref.org/works/' + encodeURIComponent(cleanDoi(doi)), {
    headers: { 'User-Agent': `research-hub/0.7 (mailto:${config.get().openalexEmail || 'unknown@example.com'})` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const m = (await res.json()).message;
  return {
    itemType: TYPES[m.type] || 'document',
    title: (m.title || [])[0],
    creators: (m.author || []).map((a) => ({ creatorType: 'author', firstName: a.given || '', lastName: a.family || a.name || '' })),
    date: dateOf((m.issued && m.issued['date-parts'] && m.issued['date-parts'][0]) || []),
    publicationTitle: (m['container-title'] || [])[0],
    volume: m.volume, issue: m.issue, pages: m.page, DOI: m.DOI, url: m.URL,
    abstractNote: m.abstract ? String(m.abstract).replace(/<[^>]+>/g, '').trim() : undefined,
  };
}
module.exports = { resolveDoi, setHttp };
