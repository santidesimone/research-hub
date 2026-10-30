// CSL JSON: the interchange format reference managers import and export. Used for library backup, import and export.
const TO_CSL = { journalArticle: 'article-journal', conferencePaper: 'paper-conference', preprint: 'article', book: 'book',
  bookSection: 'chapter', report: 'report', thesis: 'thesis', webpage: 'webpage', document: 'document', presentation: 'speech' };
const FROM_CSL = Object.fromEntries(Object.entries(TO_CSL).map(([k, v]) => [v, k]));
const dateOf = (parts) => parts.filter((x) => x != null).map((x, i) => (i ? String(x).padStart(2, '0') : String(x))).join('-');

// row = { key, props, topics }
function toCsl(row) {
  const p = row.props;
  const lasts = p.author_lasts || [];
  const author = (p.authors || []).map((name, i) => {
    const family = lasts[i] || name.split(/\s+/).at(-1);
    const given = name.endsWith(family) ? name.slice(0, name.length - family.length).trim() : '';
    return given ? { family, given } : { literal: name };
  });
  const out = { id: row.key, type: TO_CSL[p.item_type] || 'article-journal', title: p.title, author };
  if (p.year) out.issued = { 'date-parts': [[p.year]] };
  if (p.doi) out.DOI = p.doi;
  if (p.url) out.URL = p.url;
  if (p.venue) out['container-title'] = p.venue;
  if (p.abstract) out.abstract = p.abstract;
  const tags = [p.visibility === 'public' && 'public', ...(row.topics || []).map((t) => `topic:${t}`)].filter(Boolean);
  if (tags.length) out.keyword = tags.join(', ');
  return out;
}

function fromCsl(c) {
  const itemType = FROM_CSL[c.type] || 'journalArticle';
  const parts = c.issued && c.issued['date-parts'] && c.issued['date-parts'][0];
  const venueField = { conferencePaper: 'proceedingsTitle', bookSection: 'bookTitle', preprint: 'repository' }[itemType] || 'publicationTitle';
  const item = {
    itemType,
    title: Array.isArray(c.title) ? c.title[0] : c.title,
    creators: (c.author || []).map((a) => (a.family
      ? { creatorType: 'author', firstName: a.given || '', lastName: a.family }
      : { creatorType: 'author', name: a.literal || a.name || '' })),
    date: parts ? dateOf(parts) : undefined,
    DOI: c.DOI, url: c.URL, abstractNote: c.abstract,
    tags: String(c.keyword || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
  if (c['container-title']) item[venueField] = Array.isArray(c['container-title']) ? c['container-title'][0] : c['container-title'];
  return item;
}
module.exports = { toCsl, fromCsl };
