const { entityLabels } = require('../core/schema');

module.exports = {
  id: '001_constraints',
  description: 'unique keys for Artifact and the entity labels in schema.json',
  async up(db) {
    for (const label of ['Artifact', ...entityLabels]) {
      await db.run(`CREATE CONSTRAINT ${label.toLowerCase()}_key IF NOT EXISTS FOR (n:${label}) REQUIRE n.key IS UNIQUE`);
    }
  },
};
