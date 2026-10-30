// Default type module for every type in schema.json that has no features/<name>/type.js of its own.
// Accepts the same fields as the Markdown front matter (title, summary, visibility, <relation>: [keys], concepts: [...])
// plus `body` (Markdown text), an optional `slug`, and the type's schema fields. The schema validator runs on every write:
// missing required fields are a 400, other problems come back as warnings, and fields the schema does not know are kept.
const { schema, fieldsOf, keyPrefix, validate } = require('./schema');
const { HttpError } = require('./errors');
const { scalar } = require('./notes');

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const normRef = (r) => { r = String(r).trim(); return r.toLowerCase().startsWith('doi:') ? 'doi:' + r.slice(4).trim().toLowerCase() : r; };

// Properties the hub manages itself; input can never set them, even as an "unknown" field.
const RESERVED = new Set(['key', 'source', 'created_at', 'updated_at', 'collection', 'managed', 'schema_version', 'provenance',
  'record_status', 'source_path', 'imported_from', 'path', 'file_url', 'drive_file_id', 'legacy_pdf_uri']);
const UNKNOWN_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_UNKNOWN = 50;

module.exports = function makeGenericType(name, def) {
  const fields = fieldsOf(name);
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
      const { errors, warnings, unknown } = validate(name, { ...input, title });
      if (errors.length) throw new HttpError(400, errors.join('; '), { errors, warnings });
      const props = { title, summary: input.summary ?? null, visibility, body: input.body ?? null };
      for (const p of def.props) props[p] = scalar(input[p]);
      for (const [f, spec] of Object.entries(fields)) {
        if (f in props || RESERVED.has(f) || (spec.by.length === 1 && spec.by[0] === 'Sys')) continue;
        if (spec.type === 'object') { props[`${f}_json`] = input[f] == null ? null : JSON.stringify(input[f]); props[f] = null; } // same storage as /api/items
        else props[f] = scalar(input[f]);
      }
      // your reading status belongs to the personal layer, unless the type has a status field of its own
      const reserved = (k) => RESERVED.has(k) || (k === 'status' && !fields.status) || (k.endsWith('_json') && fields[k.slice(0, -5)]);
      const kept = unknown.filter((k) => UNKNOWN_NAME.test(k) && !reserved(k));
      // the validator reports every unknown field; say only what actually happened to each
      for (let i = warnings.length - 1; i >= 0; i--) if (warnings[i].startsWith(`not in the ${name} schema`)) warnings.splice(i, 1);
      if (kept.length) warnings.push(`not in the ${name} schema (kept as is): ${kept.slice(0, MAX_UNKNOWN).join(', ')}`);
      for (const k of kept.slice(0, MAX_UNKNOWN)) props[k] = scalar(input[k]);
      if (kept.length > MAX_UNKNOWN) warnings.push(`only the first ${MAX_UNKNOWN} unknown fields were kept`);
      const dropped = unknown.filter((k) => !kept.includes(k) && k !== 'status');
      if (unknown.includes('status') && !kept.includes('status')) warnings.push('status: saved as your personal status, not on the item');
      if (dropped.length) warnings.push(`ignored (reserved or not a valid field name): ${dropped.join(', ')}`);
      const links = [];
      for (const [field, rel] of Object.entries(schema.relations)) {
        for (const target of asList(input[field])) links.push({ rel, match: normRef(target) });
      }
      for (const c of asList(input.concepts)) {
        links.push({ rel: 'ABOUT', merge: { label: 'Concept', key: 'concept:' + slugify(c), props: { name: String(c).replace(/-/g, ' ') } } });
      }
      return { key: keyPrefix(name) + slug, label: def.label, props, links, warnings };
    },
  };
};
