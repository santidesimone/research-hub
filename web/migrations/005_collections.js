// Schema v3: Collections. Idempotent, and it only adds: nothing is deleted except the full-text index, which is rebuilt
// over every type label (search falls back to a scan while it populates).
//   * unique keys for the vocabulary labels (Topic, Domain, Venue, Organisation, Dataset) and an index on `collection`;
//   * every artifact gets `managed` and `schema_version` from schema.json, collection items `collection` and record_status;
//   * methods that came from Markdown become database-managed: `source` goes from 'markdown' to 'hub' (so sync-notes can
//     never prune them) and `imported_from: 'markdown'` plus the existing `source_path` record where they came from;
//   * the owner's Domain list from docs/SCHEMA_DESIGN.md is seeded (MERGE, so edits and additions are kept).
const { schema, entityLabels, typeLabels, safeLabel } = require('../core/schema');

const DOMAINS = [
  { name: 'digital currency', aliases: ['CBDC', 'central bank digital currency'] },
  { name: 'payments', aliases: [] },
  { name: 'digital identity', aliases: [] },
  { name: 'privacy-enhancing technology', aliases: ['PET', 'privacy-enhancing technologies'] },
  { name: 'cryptography', aliases: [] },
  { name: 'financial regulation', aliases: [] },
  { name: 'governance and policy', aliases: [] },
  { name: 'distributed systems', aliases: [] },
  { name: 'research methodology', aliases: [] },
  { name: 'software engineering', aliases: [] },
];
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const FULLTEXT_PROPS = ['title', 'tldr', 'abstract', 'summary', 'authors', 'venue', 'body'];

module.exports = {
  id: '005_collections',
  description: 'collections: vocabulary constraints, managed/schema_version on every artifact, Markdown methods to the database, Domain seed',
  DOMAINS,
  async up(db) {
    for (const label of entityLabels) {
      await db.run(`CREATE CONSTRAINT ${label.toLowerCase()}_key IF NOT EXISTS FOR (n:${safeLabel(label)}) REQUIRE n.key IS UNIQUE`);
    }
    await db.run('CREATE INDEX artifact_collection IF NOT EXISTS FOR (n:Artifact) ON (n.collection)');

    const [ft] = await db.run("SHOW FULLTEXT INDEXES YIELD name, labelsOrTypes, properties WHERE name = 'artifact_text' RETURN labelsOrTypes, properties");
    const covers = ft && typeLabels.every((l) => ft.labelsOrTypes.includes(l)) && FULLTEXT_PROPS.every((p) => ft.properties.includes(p));
    if (!covers) {
      if (ft) await db.run('DROP INDEX artifact_text IF EXISTS');
      await db.run(`CREATE FULLTEXT INDEX artifact_text IF NOT EXISTS FOR (n:${typeLabels.map(safeLabel).join('|')}) ON EACH [${FULLTEXT_PROPS.map((p) => 'n.' + p).join(', ')}]`);
    }

    for (const [name, t] of Object.entries(schema.types)) {
      const label = safeLabel(t.label);
      if (t.managed !== 'markdown') {
        // edges first: the hub's writer replaces only edges with source 'hub', so the imported ones become editable too
        await db.run(`MATCH (n:${label})-[r]->() WHERE (n.source = 'markdown' OR n.imported_from = 'markdown') AND r.source = 'markdown' SET r.source = 'hub'`);
        await db.run(`MATCH (n:${label} {source:'markdown'}) SET n.source = 'hub', n.imported_from = 'markdown'`);
      }
      await db.run(
        `MATCH (n:${label}) SET n.managed = $managed, n.schema_version = coalesce(n.schema_version, $version)
         ${t.collection ? ', n.collection = $name, n.record_status = coalesce(n.record_status, \'auto\')' : ''}`,
        { managed: t.managed, version: t.schema_version, name });
    }

    await db.run(
      `UNWIND $rows AS r
       MERGE (d:Domain {key: r.key})
       ON CREATE SET d.name = r.name, d.aliases = r.aliases, d.by = 'owner', d.seeded = true, d.created_at = datetime()`,
      { rows: DOMAINS.map((d) => ({ key: schema.entities.Domain.key_prefix + slugify(d.name), name: d.name, aliases: d.aliases })) });
  },
};
