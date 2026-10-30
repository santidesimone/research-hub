// Name matching for vocabulary nodes (web/core/vocab.js). Idempotent and additive:
//   * indexes on `norm` and `letters` per vocabulary label, and the `vocab_text` full-text index over norm and aliases;
//   * one (:VocabLock {label}) node per label (unique), which resolve() locks while it creates a node;
//   * derived fields (norm, letters, aliases_norm, aliases_letters, aliases_text) on vocabulary nodes that do not have them yet.
const { entityLabels, safeLabel } = require('../core/schema');
const { derived } = require('../core/vocab');

const BATCH = 500;

module.exports = {
  id: '006_vocab_matching',
  description: 'vocabulary name matching: norm and letters indexes, vocab_text full-text index, per-label locks, backfill of derived fields',
  async up(db) {
    for (const label of entityLabels) {
      await db.run(`CREATE INDEX ${label.toLowerCase()}_norm IF NOT EXISTS FOR (n:${safeLabel(label)}) ON (n.norm)`);
      await db.run(`CREATE INDEX ${label.toLowerCase()}_letters IF NOT EXISTS FOR (n:${safeLabel(label)}) ON (n.letters)`);
    }
    await db.run(`CREATE FULLTEXT INDEX vocab_text IF NOT EXISTS FOR (n:${entityLabels.map(safeLabel).join('|')}) ON EACH [n.norm, n.aliases_text]`);
    await db.run('CREATE CONSTRAINT vocablock_label IF NOT EXISTS FOR (l:VocabLock) REQUIRE l.label IS UNIQUE');
    await db.run('UNWIND $labels AS label MERGE (:VocabLock {label: label})', { labels: entityLabels });

    for (const label of entityLabels) {
      const L = safeLabel(label);
      for (;;) {
        const rows = await db.run(
          `MATCH (n:${L}) WHERE n.norm IS NULL RETURN n.key AS key, coalesce(n.name, n.key) AS name, coalesce(n.aliases, []) AS aliases LIMIT ${BATCH}`);
        if (!rows.length) break;
        const out = rows.map((r) => {
          const d = derived(label, String(r.name).replace(/^[a-z]+:/, ''), r.aliases);
          return { key: r.key, props: { ...d, norm: d.norm || r.key } }; // never leave norm null, or the loop would not end
        });
        await db.run(`UNWIND $rows AS r MATCH (n:${L} {key: r.key}) SET n += r.props`, { rows: out });
        if (rows.length < BATCH) break;
      }
    }
  },
};
