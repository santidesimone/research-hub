// Files are now links. Earlier versions copied PDFs into hub storage (gs://... or local://...) and recorded the
// reference as `pdf_uri`. Nothing is deleted: the old reference is kept as `legacy_pdf_uri` (read-only, shown in the UI
// as a hint) and the paper simply has no file link until you add one.
module.exports = {
  id: '003_files_are_links',
  description: 'rename Paper.pdf_uri to legacy_pdf_uri (files are links now)',
  async up(db) {
    await db.run('MATCH (p:Paper) WHERE p.pdf_uri IS NOT NULL SET p.legacy_pdf_uri = p.pdf_uri REMOVE p.pdf_uri');
  },
};
