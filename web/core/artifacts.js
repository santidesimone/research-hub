// Generic artifact persistence: any type described in schema/schema.json is written, listed and deleted here.
// A type module turns request input into {key, label, props, links}; this file turns that into Cypher.
const { writeTx, run } = require('./db');
const { schema, safeLabel, safeRel, orphanLabels, entityLabels } = require('./schema');
const { HttpError } = require('./errors');
const types = require('./types');
const vocab = require('./vocab');
const hooks = require('./hooks');

// The hub's own bookkeeping, from the type's schema entry: how it is managed, its schema version, its collection.
function systemProps(label) {
  const [name, def] = Object.entries(schema.types).find(([, t]) => t.label === label) || [];
  if (!def) return { props: {}, onCreate: {} };
  return {
    props: { managed: def.managed, schema_version: def.schema_version, ...(def.collection ? { collection: name } : {}) },
    onCreate: def.collection ? { record_status: 'auto' } : {}, // never reset an owner's "reviewed"
  };
}

// Vocabulary nodes written here (authors, concepts) carry the matcher's fields too, so vocab.resolve() finds them.
const vocabFields = (m) => (entityLabels.includes(m.label) && m.props && m.props.name ? vocab.nameProps(m.label, m.props.name) : {});

// art = { key, label, props: {..}, links: [ {rel, merge:{label,key,props}} | {rel, match:key} ], warnings?: [] }
async function upsertArtifact(tx, art, { overwrite = false } = {}) {
  const label = safeLabel(art.label);
  const sys = systemProps(art.label);
  const found = await tx.run('MATCH (n:Artifact {key:$key}) RETURN labels(n) AS labels', { key: art.key });
  if (found.records.length) {
    const labels = found.records[0].get('labels');
    if (!labels.includes(label)) throw new HttpError(409, `Key ${art.key} already belongs to a ${labels.filter((l) => l !== 'Artifact').join(', ')}`, { key: art.key });
    if (!overwrite) throw new HttpError(409, 'Already in the library (use ?overwrite=true to replace it)', { key: art.key });
  }
  await tx.run(
    `MERGE (n:Artifact {key:$key})
     ON CREATE SET n.created_at = datetime(), n += $onCreate
     SET n:${label}, n += $props, n += $sys, n.source = 'hub', n.updated_at = datetime()`,
    { key: art.key, props: art.props, sys: sys.props, onCreate: sys.onCreate }
  );
  await tx.run("MATCH (n:Artifact {key:$key})-[r]->() WHERE r.source = 'hub' DELETE r", { key: art.key });
  const warnings = [...(art.warnings || [])];
  for (const link of art.links || []) {
    const rel = safeRel(link.rel);
    if (link.merge) {
      await tx.run(
        `MATCH (n:Artifact {key:$key})
         MERGE (t:${safeLabel(link.merge.label)} {key:$tkey}) SET t += $tprops, t += $tderived
         MERGE (n)-[r:${rel}]->(t) SET r.source = 'hub'`,
        { key: art.key, tkey: link.merge.key, tprops: link.merge.props || {}, tderived: vocabFields(link.merge) }
      );
    } else {
      const res = await tx.run(
        `MATCH (n:Artifact {key:$key}), (t:Artifact {key:$tkey})
         MERGE (n)-[r:${rel}]->(t) SET r.source = 'hub' RETURN count(r) AS c`,
        { key: art.key, tkey: link.match }
      );
      if (res.records[0].get('c').toNumber() === 0) warnings.push(`${rel} -> ${link.match}: target not found, skipped`);
    }
  }
  return { key: art.key, created: !found.records.length, warnings };
}

async function add(typeName, body, { overwrite = false } = {}) {
  const type = types.get(typeName);
  const input = type.prepare ? await type.prepare(body || {}) : body || {};
  const art = type.parse(input);
  const result = await writeTx((tx) => upsertArtifact(tx, art, { overwrite }));
  const extra = type.afterWrite ? await type.afterWrite(result.key, input) : {};
  await hooks.emit('afterWrite', { key: result.key, type: typeName, input, created: result.created });
  return { ...result, ...extra };
}

async function remove(key) {
  const [row] = await run('MATCH (n:Artifact {key:$key}) RETURN n.key AS key', { key });
  if (!row) throw new HttpError(404, 'No such artifact');
  await hooks.emit('beforeRemove', { key });
  await writeTx(async (tx) => {
    await tx.run('MATCH (n:Artifact {key:$key}) DETACH DELETE n', { key });
    for (const l of orphanLabels) await tx.run(`MATCH (x:${safeLabel(l)}) WHERE NOT (x)--() DELETE x`);
  });
  await hooks.emit('afterRemove', { key });
  return { deleted: key };
}

async function list(typeName) {
  const label = safeLabel(schema.types[typeName].label);
  return run(`MATCH (n:${label}) RETURN n.key AS key, properties(n) AS props ORDER BY n.title`);
}

module.exports = { upsertArtifact, add, remove, list, systemProps };
