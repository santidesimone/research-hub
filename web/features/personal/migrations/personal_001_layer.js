// Creates the personal layer's storage and moves any `status` that earlier versions kept on the artifact itself.
module.exports = {
  id: 'personal_001_layer',
  description: 'personal layer: constraint, and move status off artifacts into it',
  async up(db) {
    await db.run('CREATE CONSTRAINT personal_key IF NOT EXISTS FOR (s:Personal) REQUIRE s.key IS UNIQUE');
    await db.run(
      `MATCH (a:Artifact) WHERE a.status IS NOT NULL
       MERGE (s:Personal {key: 'personal:' + a.key})
       SET s.status = a.status, s.updated_at = datetime()
       MERGE (s)-[:FOR]->(a)
       REMOVE a.status`
    );
  },
};
