// Questions and hypotheses are the owner's (Task 11 step 5, docs/UI_REDESIGN.md section 3). Sources now INFORM them.
// - (q)-[:ADDRESSED_BY]->(x) becomes (x)-[:INFORMS]->(q), with the same properties.
// - (q)-[:ASKED_IN]->(p) becomes (p)-[:INFORMS]->(q), and the question's text is added to the paper's stated_question
//   (written as Claude's value, so an owner value is never overwritten).
// - Questions an analysis extracted (origin: extracted) and that nothing else uses are not deleted here: a curation
//   plan proposes deleting them, for the owner to apply, reject or undo in Review.
// Copies first, then removes the old relationship; idempotent (a second run finds nothing to move).
module.exports = {
  id: '014_informs',
  description: 'sources INFORM questions and hypotheses: ADDRESSED_BY and ASKED_IN become INFORMS; stated questions move to the paper',
  async up(db) {
    for (const [rel, src, dst] of [['ADDRESSED_BY', 'x', 'q'], ['ASKED_IN', 'x', 'q']]) {
      await db.run(`MATCH (q:ResearchQuestion)-[r:${rel}]->(x)
        MERGE (${src})-[n:INFORMS]->(${dst})
        ON CREATE SET n = properties(r), n.migrated_from = '${rel}'
        DELETE r`);
    }
    // the paper's own question: every migrated ASKED_IN question's text, as the paper's stated_question
    const rows = await db.run(`MATCH (p:Paper)-[n:INFORMS {migrated_from: 'ASKED_IN'}]->(q:ResearchQuestion)
      RETURN p.key AS paper, collect(coalesce(q.text, q.title)) AS texts, p.stated_question AS current`);
    if (rows.length) {
      const items = require('../core/items');
      for (const r of rows) {
        const texts = r.texts.filter((t) => t && !(r.current || '').includes(t));
        if (!texts.length) continue;
        await items.write(r.paper, { stated_question: [r.current, ...texts].filter(Boolean).join('\n') }, { by: 'claude', model: 'migration-014', confidence: 'medium' });
      }
    }
    // extracted questions nothing but their papers' INFORMS (and topics) use: propose deleting them, once
    const done = await db.run("MATCH (c:CurationPlan) WHERE c.reason STARTS WITH 'Migration 014' RETURN count(c) AS n");
    if (done.length && Number(done[0].n) > 0) return;
    const orphans = await db.run(`MATCH (q:ResearchQuestion {origin: 'extracted'})
      WHERE NOT EXISTS { MATCH (q)-[r]-() WHERE NOT type(r) IN ['INFORMS', 'ABOUT'] }
        AND NOT EXISTS { MATCH (q)-[:INFORMS]->() }
      RETURN q.key AS key ORDER BY key LIMIT 50`);
    if (orphans.length) {
      await require('../core/curation').propose(orphans.map((o) => ({ op: 'delete', key: o.key })), {
        by: 'hub', reason: 'Migration 014: questions taken from papers before they became your own. Their text is now on each paper (its own research question). Apply to delete them; Reject keeps them as your questions.',
      });
    }
  },
};
