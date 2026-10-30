// The "paper" artifact type: how API input becomes a Paper node. (Loaded by core/types.js.)
const { normalizeItem, nodeFields } = require('./item');
const { resolveDoi } = require('./crossref');
const files = require('./files');
const links = require('../../core/links');
const { HttpError } = require('../../core/errors');

const fileLink = (input) => input.file_url || input.pdf_url || null; // pdf_url is the older name for the same thing

// The schema's item_type values (docs/SCHEMA_DESIGN.md) <-> what papers store (reference-manager item types, used by the
// CSL export). The items API converts at its boundary, so stored data does not change.
const ITEM_TYPE = { journal_article: 'journalArticle', conference_paper: 'conferencePaper', preprint: 'preprint', thesis: 'thesis', report: 'report', book_chapter: 'bookSection', standard: 'document', talk: 'presentation' };
const ITEM_TYPE_BACK = Object.fromEntries(Object.entries(ITEM_TYPE).map(([a, b]) => [b, a]));

module.exports = {
  name: 'paper',
  label: 'Paper',
  codec: { item_type: { write: (v) => ITEM_TYPE[v] || v, read: (v) => ITEM_TYPE_BACK[v] || v } },
  // identity and source facts the items API does not edit: the DOI is the key, authors and venue come from the source
  locked: ['doi', 'authors', 'venue'],

  // DOI alone: look the rest up.
  async prepare(body) {
    if (body.title || !body.DOI) return body;
    const found = await resolveDoi(body.DOI);
    if (!found || !found.title) throw new HttpError(422, 'Could not look up that DOI. Send the title and other fields yourself.');
    return { ...found, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v != null)) };
  },

  parse(input) {
    const link = fileLink(input);
    if (link) links.normalize(link); // reject a bad link before anything is written
    const f = nodeFields(normalizeItem(input));
    return {
      key: f.key,
      label: 'Paper',
      props: {
        title: f.title, year: f.year, doi: f.doi, venue: f.venue, url: f.url, abstract: f.abstract,
        item_type: f.item_type, authors: f.authors, author_lasts: f.author_lasts, visibility: f.visibility,
      },
      links: [
        ...f.people.map((p) => ({ rel: 'AUTHORED_BY', merge: { label: 'Person', key: p.key, props: { name: p.name } } })),
        ...f.topics.map((t) => ({ rel: 'ABOUT', merge: { label: 'Concept', key: t.key, props: { name: t.name } } })),
      ],
    };
  },

  // The link is stored once the node exists. By default nothing is downloaded; copy_to_drive: true fetches the PDF from an
  // allow-listed host and uploads it to Drive, falling back to keeping the original link if that fails.
  async afterWrite(key, input) {
    const link = fileLink(input);
    if (!link) return {};
    try {
      if (input.copy_to_drive) {
        try { return await files.uploadPdf(key, await files.fetchPdf(link)); }
        catch (e) { return { ...(await files.setLink(key, link)), file_error: `${e.message} (kept the original link instead)` }; }
      }
      return await files.setLink(key, link);
    } catch (e) { return { file_error: e.message }; }
  },
};
