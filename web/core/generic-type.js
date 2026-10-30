// Default type module for every type in schema.json that has no features/<name>/type.js of its own.
// Accepts the same fields as the Markdown front matter (title, summary, visibility, <relation>: [keys], concepts: [...])
// plus `body` (Markdown text) and an optional `slug`.
const { schema } = require('./schema');
const { HttpError } = require('./errors');

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const normRef = (r) => { r = String(r).trim(); return r.toLowerCase().startsWith('doi:') ? 'doi:' + r.slice(4).trim().toLowerCase() : r; };

module.exports = function makeGenericType(name, def) {
  return {
    name,
    label: def.label,
    parse(input) {
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title) throw new HttpError(400, 'title is required');
      const slug = slugify(input.slug || title);
      if (!slug) throw new HttpError(400, 'could not derive a slug from the title');
      const visibility = input.visibility || 'private';
      if (!['public', 'private'].includes(visibility)) throw new HttpError(400, 'visibility must be public or private');
      const props = { title, summary: input.summary ?? null, visibility, body: input.body ?? null };
      for (const p of def.props) props[p] = input[p] ?? null;
      const links = [];
      for (const [field, rel] of Object.entries(schema.relations)) {
        for (const target of asList(input[field])) links.push({ rel, match: normRef(target) });
      }
      for (const c of asList(input.concepts)) {
        links.push({ rel: 'ABOUT', merge: { label: 'Concept', key: 'concept:' + slugify(c), props: { name: String(c).replace(/-/g, ' ') } } });
      }
      return { key: `${name}:${slug}`, label: def.label, props, links };
    },
  };
};
