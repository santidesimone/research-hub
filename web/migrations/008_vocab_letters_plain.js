// A word written in capitals ("ZERO KNOWLEDGE proofs") may be an acronym or just a word, so vocabulary nodes keep a
// second letter signature, `letters_plain`, and aliases keep every signature. Adds the index and recomputes the derived
// fields of every vocabulary node from its name and aliases (keys and names are unchanged). Idempotent.
const { entityLabels, safeLabel } = require('../core/schema');
const { derived } = require('../core/vocab');

const BATCH = 500;

module.exports = {
  id: '008_vocab_letters_plain',
  description: 'vocabulary: letters_plain index, recompute derived matching fields',
  async up(db) {
    for (const label of entityLabels) {
      const L = safeLabel(label);
      await db.run(`CREATE INDEX ${label.toLowerCase()}_letters_plain IF NOT EXISTS FOR (n:${L}) ON (n.letters_plain)`);
      for (let skip = 0; ; skip += BATCH) {
        const rows = await db.run(
          `MATCH (n:${L}) RETURN n.key AS key, coalesce(n.name, n.key) AS name, coalesce(n.aliases, []) AS aliases ORDER BY n.key SKIP ${skip} LIMIT ${BATCH}`);
        if (!rows.length) break;
        const out = rows.map((r) => {
          const d = derived(label, String(r.name).replace(/^[a-z]+:/, ''), r.aliases);
          return { key: r.key, props: { ...d, norm: d.norm || r.key } };
        });
        await db.run(`UNWIND $rows AS r MATCH (n:${L} {key: r.key}) SET n += r.props`, { rows: out });
        if (rows.length < BATCH) break;
      }
    }
  },
};
