// Reports (schema v4): grey literature from vendors, consultancies, governments. Their keys are covered by the Artifact
// key constraint (001). The artifact_text full-text index was built over the type labels of its day (011), so this
// rebuilds it when a type label (Report, and Thought from 015) or a text field is missing, and indexes the fields
// reports are filtered by. Idempotent: an index that already covers all of this is left alone.
const { typeLabels, safeLabel } = require('../core/schema');
const { FULLTEXT_PROPS: BASE } = require('./011_frameworks_questions_ontologies');

const FULLTEXT_PROPS = [...BASE, 'methodology', 'credibility_reason'];

module.exports = {
  id: '016_reports',
  description: 'full-text index over every type label (now Report) and report text; report kind and credibility indexes',
  FULLTEXT_PROPS,
  async up(db) {
    const [ft] = await db.run("SHOW FULLTEXT INDEXES YIELD name, labelsOrTypes, properties WHERE name = 'artifact_text' RETURN labelsOrTypes, properties");
    const covers = ft && typeLabels.every((l) => ft.labelsOrTypes.includes(l)) && FULLTEXT_PROPS.every((p) => ft.properties.includes(p));
    if (!covers) {
      if (ft) await db.run('DROP INDEX artifact_text IF EXISTS');
      await db.run(`CREATE FULLTEXT INDEX artifact_text IF NOT EXISTS FOR (n:${typeLabels.map(safeLabel).join('|')}) ON EACH [${FULLTEXT_PROPS.map((p) => 'n.' + p).join(', ')}]`);
    }
    await db.run('CREATE INDEX report_kind IF NOT EXISTS FOR (n:Report) ON (n.report_kind)');
    await db.run('CREATE INDEX report_credibility IF NOT EXISTS FOR (n:Report) ON (n.credibility_tier)');
  },
};
