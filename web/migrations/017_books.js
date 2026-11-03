// Books (schema v5). Their keys are covered by the Artifact key constraint (001). The artifact_text full-text index
// must cover the Book label: 016's check rebuilds it when any type label or text field is missing, else leaves it.
const m016 = require('./016_reports');

module.exports = {
  id: '017_books',
  description: 'full-text index over every type label (now Book)',
  async up(db) {
    await m016.up(db);
  },
};
