// Input format for papers: a reference-manager style item (itemType, creators, DOI, date, tags, ...).
const crypto = require('crypto');
const { HttpError } = require('../../core/errors');

const ITEM_TYPES = ['journalArticle', 'conferencePaper', 'preprint', 'book', 'bookSection', 'report', 'thesis', 'webpage', 'document', 'presentation'];

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const cleanDoi = (doi) => String(doi || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
const yearOf = (date) => { const m = /(\d{4})/.exec(String(date || '')); return m ? Number(m[1]) : null; };
const sha = (s, n) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);

// Accept friendly input (strings for creators/tags) and return a normalized item.
function normalizeItem(raw) {
  const item = { ...raw };
  item.itemType = item.itemType || 'journalArticle';
  if (!ITEM_TYPES.includes(item.itemType)) throw new HttpError(400, `itemType must be one of: ${ITEM_TYPES.join(', ')}`);
  if (typeof item.title !== 'string' || !item.title.trim()) throw new HttpError(400, 'title is required (or send just a DOI and the hub will look it up)');
  item.title = item.title.trim();
  const role = item.itemType === 'presentation' ? 'presenter' : 'author';
  item.creators = (item.creators || []).map((c) => {
    if (typeof c === 'string') {
      const parts = c.trim().split(/\s+/);
      return parts.length === 1
        ? { creatorType: role, name: parts[0] }
        : { creatorType: role, firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) };
    }
    return { creatorType: role, ...c };
  });
  item.tags = (item.tags || []).map((t) => (typeof t === 'string' ? { tag: t } : t));
  if (item.DOI) item.DOI = cleanDoi(item.DOI);
  return item;
}

// Identity: the DOI when there is one, otherwise a stable hash of title + year (so re-adding the same paper is detected).
function paperKey(item) {
  if (item.DOI) return 'doi:' + cleanDoi(item.DOI).toLowerCase();
  return 'paper:' + sha(String(item.title).toLowerCase().replace(/\s+/g, ' ').trim() + '|' + (yearOf(item.date) || ''), 10);
}

// A "public" or "private" tag sets the visibility; with neither, it is left to the owner's default for new papers.
function parseTags(tags) {
  let visibility = null;
  const topics = [];
  for (const { tag } of tags) {
    const t = String(tag).trim(), low = t.toLowerCase();
    if (low.startsWith('topic:')) topics.push(t.slice(6).trim());
    else if (low === 'public' || low === 'private') visibility = low;
  }
  return { topics, visibility };
}

// Flatten a normalized item into the fields stored on the graph.
function nodeFields(item) {
  const { topics, visibility } = parseTags(item.tags);
  const people = item.creators.filter((c) => ['author', 'presenter'].includes(c.creatorType));
  const named = (people.length ? people : item.creators).map((c) => ({
    name: c.name || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    last: c.lastName || (c.name ? c.name.split(/\s+/).at(-1) : ''),
  })).filter((p) => p.name);
  return {
    key: paperKey(item),
    title: item.title,
    year: yearOf(item.date),
    doi: item.DOI || null,
    venue: item.publicationTitle || item.proceedingsTitle || item.bookTitle || item.meetingName || item.repository || null,
    url: item.url || null,
    abstract: item.abstractNote || null,
    item_type: item.itemType,
    authors: named.map((p) => p.name),
    author_lasts: named.map((p) => p.last),
    people: named.map((p) => ({ key: 'person:' + slugify(p.name), name: p.name })),
    topics: topics.map((t) => ({ key: 'concept:' + slugify(t), name: t.replace(/-/g, ' ') })),
    visibility,
  };
}

module.exports = { ITEM_TYPES, normalizeItem, paperKey, nodeFields, cleanDoi, yearOf, sha };
