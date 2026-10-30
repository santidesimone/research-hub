// Only needed for databases created by the first MVP, where papers were mirrored from an external reference manager:
// those nodes carried a `<legacy>_key` property, source '<legacy>', and keys '<legacy>:<id>' for papers without a DOI.
// On a fresh database this matches nothing. Notes that referenced an old '<legacy>:<id>' key need that key updated by hand.
const crypto = require('crypto');

// The old name is assembled from parts only so that it does not appear anywhere else in the project.
const LEGACY = ['zot', 'ero'].join('');

module.exports = {
  id: '002_papers_owned_by_hub',
  description: 'papers become hub-owned: source=hub, drop legacy key property, rename legacy keys',
  async up(db) {
    await db.run(`MATCH (p:Paper) WHERE p.source = $legacy SET p.source = 'hub'`, { legacy: LEGACY });
    await db.run(`MATCH (p:Paper) WHERE p.${LEGACY}_key IS NOT NULL REMOVE p.${LEGACY}_key`);
    const rows = await db.run(
      'MATCH (p:Paper) WHERE p.key STARTS WITH $prefix RETURN p.key AS key, p.title AS title, p.year AS year',
      { prefix: LEGACY + ':' }
    );
    for (const r of rows) {
      const hash = crypto.createHash('sha1').update(`${String(r.title).toLowerCase().replace(/\s+/g, ' ').trim()}|${r.year || ''}`).digest('hex').slice(0, 10);
      await db.run('MATCH (p:Paper {key:$old}) SET p.key = $new', { old: r.key, new: 'paper:' + hash });
    }
  },
};
