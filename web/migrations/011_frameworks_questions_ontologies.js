// Frameworks, research questions, hypotheses, ontologies (Task 8, docs/ADDENDUM_frameworks_questions_ontologies.md).
// Their keys are covered by the Artifact key constraint (001). This rebuilds the artifact_text full-text index over every
// type label with the new types' text fields (a question's text, a hypothesis's statement, an ontology's acronym), and
// adds an index for listing hypotheses by status. Idempotent: an index that already covers all of this is left alone.
const { typeLabels, safeLabel } = require('../core/schema');

const FULLTEXT_PROPS = ['title', 'tldr', 'abstract', 'summary', 'authors', 'venue', 'body', 'text', 'statement', 'acronym'];

module.exports = {
  id: '011_frameworks_questions_ontologies',
  description: 'full-text index over the new types (text, statement, acronym); hypothesis status index',
  FULLTEXT_PROPS,
  async up(db) {
    const [ft] = await db.run("SHOW FULLTEXT INDEXES YIELD name, labelsOrTypes, properties WHERE name = 'artifact_text' RETURN labelsOrTypes, properties");
    const covers = ft && typeLabels.every((l) => ft.labelsOrTypes.includes(l)) && FULLTEXT_PROPS.every((p) => ft.properties.includes(p));
    if (!covers) {
      if (ft) await db.run('DROP INDEX artifact_text IF EXISTS');
      await db.run(`CREATE FULLTEXT INDEX artifact_text IF NOT EXISTS FOR (n:${typeLabels.map(safeLabel).join('|')}) ON EACH [${FULLTEXT_PROPS.map((p) => 'n.' + p).join(', ')}]`);
    }
    await db.run('CREATE INDEX hypothesis_status IF NOT EXISTS FOR (n:Hypothesis) ON (n.status)');
  },
};
