// Reads schema/schema.json: the single definition of the graph model. check() refuses a malformed schema at start-up,
// validate() checks an item against its type's fields (missing required fields are errors, everything else a warning).
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./env');
const { HttpError } = require('./errors');

const SAFE = /^[A-Za-z][A-Za-z0-9_]*$/;
const FIELD = /^[a-z][a-z0-9_]*$/;
const MANAGED = ['db', 'markdown', 'api'];
const TIERS = ['core', 'standard', 'deep'];
const BY = ['S', 'C', 'Y', 'Sys'];
const MATCH_MODES = ['term', 'name', 'person']; // how web/core/vocab.js normalises names of that entity
const SCALARS = ['text', 'longtext', 'markdown', 'integer', 'date', 'datetime', 'url', 'boolean']; // allowed inside objects
// An object part is a type name ("text") or a small spec ({type: "enum", enum: [...]}, {type: "url", https: true}).
const partSpec = (t) => (typeof t === 'string' ? { type: t } : t || {});
const HTTPS_ONLY = 'must be an https link';

// Which labels a relation may point to from a given label. `pairs` narrows from x to when one relation joins
// different kinds of things (PART_OF: question to project, ontology to ontology); otherwise any from to any to.
function relTargetsIn(s, rel, fromLabel) {
  const r = (s.relation_types || {})[rel];
  if (!r) return [];
  if (r.pairs) return r.pairs[fromLabel] || [];
  return (r.from || []).includes(fromLabel) ? r.to || [] : [];
}

// -> list of problems (empty when the schema is usable)
function check(s) {
  const out = [];
  if (!Number.isInteger(s.version)) out.push('version must be an integer');
  const fieldTypes = s.field_types || [];
  const entities = Object.keys(s.entities || {});
  const typeLabels = Object.values(s.types || {}).map((t) => t.label);
  const labels = new Set([...entities, ...typeLabels]);
  const relTypes = s.relation_types || {};
  const global = new Set(s.public_props || []);
  for (const l of labels) if (!SAFE.test(l)) out.push(`label ${l} is not a safe identifier`);
  const checkFields = (where, fields) => {
    for (const [name, f] of Object.entries(fields || {})) {
      const at = `${where}.${name}`;
      if (!FIELD.test(name)) out.push(`${at}: field names are lower_snake_case`);
      if (!fieldTypes.includes(f.type)) out.push(`${at}: unknown type ${f.type}`);
      if (f.type === 'enum' && !(Array.isArray(f.enum) && f.enum.length)) out.push(`${at}: enum needs values`);
      if (f.type === 'ref' && !labels.has(f.ref)) out.push(`${at}: ref ${f.ref} is not an entity or type label`);
      if (f.type === 'ref' && f.rel && !relTypes[f.rel]) out.push(`${at}: rel ${f.rel} is not in relation_types`);
      if (f.type === 'object') {
        for (const [k, t] of Object.entries(f.props || {})) {
          const ps = partSpec(t);
          if (![...SCALARS, 'enum'].includes(ps.type)) out.push(`${at}.${k}: unknown type ${ps.type}`);
          if (ps.type === 'enum' && !(Array.isArray(ps.enum) && ps.enum.length)) out.push(`${at}.${k}: enum needs values`);
          if (ps.https && ps.type !== 'url') out.push(`${at}.${k}: https applies to url parts only`);
        }
      }
      if (f.https && f.type !== 'url') out.push(`${at}: https applies to url fields only`);
      if (f.normalize != null && (f.normalize !== 'iri' || f.type !== 'text')) out.push(`${at}: normalize "iri" applies to text fields only`);
      if (f.default != null && badValue(f.type, f.default, f)) out.push(`${at}: default ${JSON.stringify(f.default)} is not a valid value`);
      if (!TIERS.includes(f.tier)) out.push(`${at}: tier must be one of ${TIERS.join(', ')}`);
      if (!Array.isArray(f.by) || !f.by.length || f.by.some((b) => !BY.includes(b))) out.push(`${at}: by must list ${BY.join(', ')}`);
    }
  };
  checkFields('common_fields', s.common_fields);
  // the Library sidebar groups; every collection names one (ui_section)
  const sections = Array.isArray(s.ui_sections) ? s.ui_sections : [];
  // an empty label is a group without a heading (Thoughts, at the top)
  if (!sections.length || sections.some((x) => !x || !/^[a-z_]+$/.test(x.id || '') || typeof x.label !== 'string')) out.push('ui_sections: a list of {id, label}');
  const sectionIds = new Set(sections.map((x) => x && x.id));
  if (sectionIds.size !== sections.length) out.push('ui_sections: ids must be unique');
  for (const [name, t] of Object.entries(s.types || {})) {
    const at = `types.${name}`;
    if (!MANAGED.includes(t.managed)) out.push(`${at}: managed must be one of ${MANAGED.join(', ')}`);
    if (!Number.isInteger(t.schema_version) || t.schema_version < 1) out.push(`${at}: schema_version must be a positive integer`);
    if (t.label_plural != null && (typeof t.label_plural !== 'string' || !t.label_plural.trim())) out.push(`${at}: label_plural must be text`);
    if (t.key_prefix != null && !/^[a-z]+:$/.test(t.key_prefix)) out.push(`${at}: key_prefix looks like "word:"`);
    if (t.managed === 'markdown' && !t.folder) out.push(`${at}: Markdown-managed types need a folder`);
    if (t.collection && !t.fields) out.push(`${at}: collections need fields`);
    if (t.collection && !sectionIds.has(t.ui_section)) out.push(`${at}: ui_section must be one of ${[...sectionIds].join(', ')}`);
    if (t.ui_count != null && !((t.fields || {})[t.ui_count.field] && ((t.fields[t.ui_count.field].enum || []).includes(t.ui_count.value)))) out.push(`${at}: ui_count needs an enum field of this type and one of its values`);
    if (t.retired != null && t.retired !== true && !(s.types || {})[t.retired]) out.push(`${at}: retired is true or names the type that replaces it`);
    if (t.retired && t.collection) out.push(`${at}: a retired type cannot be a collection`);
    if (t.reader != null && (typeof t.reader !== 'boolean' || (t.reader && !t.collection))) out.push(`${at}: reader is true or false, and only for collections`);
    if (t.title_from != null && !['text', 'longtext'].includes(((t.fields || {})[t.title_from] || {}).type)) out.push(`${at}: title_from must name a text field of this type`);
    checkFields(at + '.fields', t.fields);
    const known = new Set([...Object.keys(s.common_fields || {}), ...Object.keys(t.fields || {})]);
    if (t.collection) {
      for (const f of [...(t.list_columns || []), ...(t.filters || []), ...(t.detail_groups || []).flatMap((g) => g.fields || [])]) {
        if (!known.has(f)) out.push(`${at}: layout names unknown field ${f}`);
      }
    }
    // link fields must read back unambiguously (one field per relationship and target) and be allowed by relation_types
    const seenRefs = new Map();
    for (const [f, spec] of Object.entries({ ...(t.collection ? s.common_fields : {}), ...(t.fields || {}) })) {
      if (spec.type !== 'ref') continue;
      if (!spec.rel) { out.push(`${at}.${f}: ref fields need a rel`); continue; }
      const id = `${spec.rel}->${spec.ref}`;
      if (seenRefs.has(id)) out.push(`${at}: ${seenRefs.get(id)} and ${f} both link ${id}`);
      seenRefs.set(id, f);
      if (relTypes[spec.rel] && t.collection && !relTargetsIn(s, spec.rel, t.label).includes(spec.ref)) out.push(`${at}.${f}: relation_types.${spec.rel} does not allow ${t.label} -> ${spec.ref}`);
    }
    for (const p of t.public_props || []) if (!global.has(p)) out.push(`${at}.public_props: ${p} is not in the global public_props whitelist`);
  }
  for (const [label, e] of Object.entries(s.entities || {})) {
    if (!/^[a-z]+:$/.test(e.key_prefix || '')) out.push(`entities.${label}: key_prefix looks like "word:"`);
    if (!MATCH_MODES.includes(e.match)) out.push(`entities.${label}: match must be one of ${MATCH_MODES.join(', ')}`);
    if (e.label_plural != null && (typeof e.label_plural !== 'string' || !e.label_plural.trim())) out.push(`entities.${label}: label_plural must be text`);
  }
  for (const p of s.entity_public_props || []) if (!global.has(p)) out.push(`entity_public_props: ${p} is not in the global public_props whitelist`);
  for (const [field, rel] of Object.entries(s.relations || {})) if (!relTypes[rel]) out.push(`relations.${field}: ${rel} is not in relation_types`);
  for (const [rel, r] of Object.entries(relTypes)) {
    if (!/^[A-Z][A-Z_]*$/.test(rel)) out.push(`relation_types.${rel}: use UPPER_SNAKE_CASE`);
    if (r.retired != null && (!relTypes[r.retired] || relTypes[r.retired].retired)) out.push(`relation_types.${rel}: retired must name the relation that replaces it`);
    for (const l of [...(r.from || []), ...(r.to || [])]) if (!labels.has(l)) out.push(`relation_types.${rel}: unknown label ${l}`);
    for (const [from, tos] of Object.entries(r.pairs || {})) {
      if (!(r.from || []).includes(from)) out.push(`relation_types.${rel}.pairs: ${from} is not in from`);
      for (const l of tos) if (!(r.to || []).includes(l)) out.push(`relation_types.${rel}.pairs.${from}: ${l} is not in to`);
    }
    for (const [k, ps] of Object.entries(r.props || {})) {
      if (!/^[a-z][a-z0-9_]*$/.test(k)) out.push(`relation_types.${rel}.props: ${k} is not lower_snake_case`);
      if (!['text', 'enum', 'integer'].includes(ps.type)) out.push(`relation_types.${rel}.props.${k}: type must be text, enum or integer`);
      if (ps.type === 'enum' && !(Array.isArray(ps.enum) && ps.enum.length)) out.push(`relation_types.${rel}.props.${k}: enum needs values`);
    }
  }
  return out;
}

function load(file = path.join(ROOT, 'schema', 'schema.json')) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = check(s);
  if (problems.length) throw new Error(`schema/schema.json is invalid:\n  ${problems.join('\n  ')}`);
  return s;
}

const schema = load();

const relationTypes = new Set(Object.keys(schema.relation_types));
const entityLabels = Object.keys(schema.entities);
const typeLabels = Object.values(schema.types).map((t) => t.label);
const publicEntityLabels = entityLabels.filter((l) => schema.entities[l].public);
const orphanLabels = entityLabels.filter((l) => schema.entities[l].prune_orphans); // only these are deleted when nothing links to them
// collections read from a file (papers, reports, books): a file link, a Reader tab, the reading-list view
const readerLabels = Object.values(schema.types).filter((t) => t.reader).map((t) => t.label);
const typeByLabel = Object.fromEntries(Object.entries(schema.types).map(([n, t]) => [t.label, n]));

// Labels and relationship types cannot be Cypher parameters, so every one that reaches a query goes through here.
function safeLabel(label) {
  if (!SAFE.test(label) || ![...entityLabels, ...typeLabels].includes(label)) throw new Error(`label not in schema: ${label}`);
  return label;
}
function safeRel(rel) {
  if (!relationTypes.has(rel)) throw new Error(`relationship not in schema: ${rel}`);
  return rel;
}
const relTargets = (rel, fromLabel) => relTargetsIn(schema, rel, fromLabel);
const relAllows = (rel, fromLabel, toLabels) => relTargets(rel, fromLabel).some((l) => toLabels.includes(l));
// The relations an item of this label can start, with where they may point and their own properties.
// what a type can link to now (a retired relation stays readable, for old data and backups, but is never offered)
// (nor is a retired type: notes and projects stay readable until removed, but nothing new links to them)
const retiredLabels = () => Object.values(schema.types).filter((t) => t.retired).map((t) => t.label);
const relationsFrom = (label) => Object.entries(schema.relation_types)
  .map(([rel, r]) => [rel, r, relTargets(rel, label).filter((l) => !retiredLabels().includes(l))])
  .filter(([, r, to]) => !r.retired && to.length)
  .map(([rel, r, to]) => ({ rel, to, interpretive: Boolean(r.interpretive), ...(r.props ? { props: r.props } : {}) }));

// Every field of a type: the common ones (collections only) plus its own.
function fieldsOf(typeName) {
  const t = schema.types[typeName];
  if (!t) return {};
  return { ...(t.collection ? schema.common_fields : {}), ...(t.fields || {}) };
}
const keyPrefix = (typeName) => schema.types[typeName].key_prefix || `${typeName}:`;
const managedBy = (typeName) => schema.types[typeName].managed;

// Which properties of a node may appear in the public preview. A type's own list can only narrow the global whitelist.
const GLOBAL_PUBLIC = new Set(schema.public_props);
function publicProps(labels) {
  const typeName = labels.map((l) => typeByLabel[l]).find(Boolean);
  if (typeName) {
    const own = schema.types[typeName].public_props;
    return own ? new Set(own.filter((p) => GLOBAL_PUBLIC.has(p))) : GLOBAL_PUBLIC;
  }
  if (labels.some((l) => publicEntityLabels.includes(l))) return new Set((schema.entity_public_props || []).filter((p) => GLOBAL_PUBLIC.has(p)));
  return new Set();
}

const empty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

// One value against a scalar or field type -> problem text or null.
function badValue(type, v, f = {}) {
  switch (type) {
    case 'text': case 'longtext': case 'markdown': return typeof v === 'string' ? null : 'expected text';
    case 'integer':
      if (!Number.isInteger(v)) return 'expected a whole number';
      if (f.min != null && v < f.min) return `must be at least ${f.min}`;
      if (f.max != null && v > f.max) return `must be at most ${f.max}`;
      return null;
    case 'boolean': return typeof v === 'boolean' ? null : 'expected true or false';
    case 'date': return typeof v === 'string' && DATE.test(v) ? null : 'expected a date (YYYY, YYYY-MM or YYYY-MM-DD)';
    case 'datetime': return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? null : 'expected a date and time';
    case 'url':
      if (!(typeof v === 'string' && /^https?:\/\/\S+$/i.test(v))) return 'expected an http(s) link';
      return f.https && !/^https:\/\//i.test(v) ? HTTPS_ONLY : null;
    case 'enum': return f.enum.includes(v) ? null : `expected one of ${f.enum.join(', ')}`;
    case 'ref': return typeof v === 'string' || (v && typeof v === 'object' && typeof v.name === 'string') ? null : 'expected a name or key';
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return 'expected an object';
      for (const [k, x] of Object.entries(v)) {
        if (!f.props || !f.props[k]) return `unknown part "${k}" (expected ${Object.keys(f.props || {}).join(', ')})`;
        const ps = partSpec(f.props[k]);
        if (x != null && badValue(ps.type, x, ps)) return `${k}: ${badValue(ps.type, x, ps)}`;
      }
      return null;
    }
    default: return `unknown field type ${type}`;
  }
}

// Inputs that are not fields but are understood by the writers.
// title, summary, visibility and body are stored for every type, collection or not.
const INPUT_EXTRAS = new Set(['slug', 'concepts', 'kind', 'title', 'summary', 'visibility', 'body', ...Object.keys(schema.relations)]);

// -> { errors, warnings, unknown }. Hub-set fields (by Sys only) are ignored: the writer sets them.
// partial: only the fields present in input are checked (a PATCH); a required field may not be emptied.
function validate(typeName, input = {}, { partial = false } = {}) {
  const t = schema.types[typeName];
  if (!t) return { errors: [`unknown type ${typeName}`], warnings: [], unknown: [] };
  const fields = fieldsOf(typeName);
  const errors = [];
  const warnings = [];
  for (const [name, f] of Object.entries(fields)) {
    if (f.by.length === 1 && f.by[0] === 'Sys') continue;
    if (partial && !(name in input)) continue;
    const v = input[name];
    if (empty(v)) {
      if (f.required) errors.push(`${name} is required`);
      else if (f.tier === 'core' && t.collection && f.default == null) warnings.push(`${name} is empty (Core field)`);
      continue;
    }
    if (f.list && !Array.isArray(v)) { warnings.push(`${name}: expected a list`); continue; }
    for (const x of f.list ? v : [v]) {
      const bad = badValue(f.type, x, f);
      // a link that must be https is refused; any other problem is a warning and the value is kept as sent
      if (bad) { (bad.endsWith(HTTPS_ONLY) ? errors : warnings).push(`${name}: ${bad}`); break; }
    }
  }
  const legacy = new Set(t.props || []);
  const unknown = Object.keys(input).filter((k) => !fields[k] && !legacy.has(k) && !INPUT_EXTRAS.has(k));
  if (unknown.length) warnings.push(`not in the ${typeName} schema (kept as is): ${unknown.join(', ')}`);
  return { errors, warnings, unknown };
}

const FIELD_KEYS = ['type', 'enum', 'list', 'ref', 'rel', 'props', 'min', 'max', 'tier', 'by', 'label', 'help', 'required', 'default', 'https', 'normalize'];
const slugOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// What the UI needs: labels, colours and which ones are drawn large; and for the Library, each collection's fields,
// layout hints and the relations it can have. This describes the model only, never any data.
function publicView() {
  const labels = [
    ...Object.entries(schema.types).map(([name, t]) => ({ name, label: t.label, plural: t.label_plural || t.label, color: t.color, big: Boolean(t.big) })),
    ...Object.entries(schema.entities).map(([label, e]) => ({ name: label.toLowerCase(), label, plural: e.label_plural || label, color: e.color, big: false })),
  ];
  const collections = Object.entries(schema.types).filter(([, t]) => t.collection).map(([name, t]) => ({
    name, label: t.label, plural: t.label_plural || t.label, slug: slugOf(t.label_plural || t.label), schema_version: t.schema_version, managed: t.managed,
    list_columns: t.list_columns || [], filters: t.filters || [], detail_groups: t.detail_groups || [],
    ui_section: t.ui_section, ui_count: t.ui_count || null, title_from: t.title_from || null, reader: Boolean(t.reader),
    fields: Object.fromEntries(Object.entries(fieldsOf(name)).filter(([, f]) => !(f.by.length === 1 && f.by[0] === 'Sys'))
      .map(([f, spec]) => [f, Object.fromEntries(FIELD_KEYS.filter((k) => spec[k] !== undefined).map((k) => [k, spec[k]]))])),
    relations: relationsFrom(t.label),
  }));
  const entities = Object.entries(schema.entities).map(([label, e]) => ({ label, key_prefix: e.key_prefix }));
  return { version: schema.version, labels, sections: schema.ui_sections.map(({ id, label }) => ({ id, label })), collections, entities };
}

// A retired type (notes, projects) can still be read, but nothing new is made of it through the API or Claude.
function assertNotRetired(typeName) {
  const t = schema.types[typeName];
  if (t && t.retired) throw new HttpError(410, `${typeName} is retired${t.retired === true ? '' : `: use ${t.retired}`}`);
}

module.exports = {
  assertNotRetired,
  schema, check, load, safeLabel, safeRel, entityLabels, typeLabels, readerLabels, publicEntityLabels, orphanLabels, relationTypes,
  fieldsOf, keyPrefix, managedBy, publicProps, validate, publicView, relTargets, relAllows, relationsFrom, partSpec,
};
