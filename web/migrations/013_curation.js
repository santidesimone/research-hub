// Curation plans (Task 10, core/curation.js): one (:CurationPlan) per proposed change set, kept as the curation log.
// Not part of the library: backup, the public export and the collections never include them. Idempotent.
module.exports = {
  id: '013_curation',
  description: 'curation plans: unique ids, and an index on status for the review list',
  async up(db) {
    await db.run('CREATE CONSTRAINT curation_plan_id IF NOT EXISTS FOR (p:CurationPlan) REQUIRE p.id IS UNIQUE');
    await db.run('CREATE INDEX curation_plan_status IF NOT EXISTS FOR (p:CurationPlan) ON (p.status)');
  },
};
