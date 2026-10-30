// A full-text index so search is ranked and fast instead of scanning every paper with CONTAINS.
// Safe to re-run (IF NOT EXISTS). If the index is ever missing, search falls back to the slower scan.
module.exports = {
  id: '004_fulltext_search',
  description: 'full-text index over title, abstract, summary, authors, venue and body',
  async up(db) {
    await db.run(
      'CREATE FULLTEXT INDEX artifact_text IF NOT EXISTS FOR (n:Paper|Method|Note|Project) ON EACH [n.title, n.abstract, n.summary, n.authors, n.venue, n.body]'
    );
  },
};
