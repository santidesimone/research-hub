// PUT /api/notes/sync was the target of `hub sync-notes` (Markdown notes and projects). Retired in Task 11: notes are
// thoughts in the database (migration 015 imported them), and projects are gone. The route answers 410 so an old
// CLI says why instead of failing obscurely.
const { HttpError } = require('../../core/errors');
const { requireOwner } = require('../../core/auth');

module.exports = {
  name: 'notes',
  mount(app) {
    app.put('/api/notes/sync', requireOwner, (_req, _res, next) => next(new HttpError(410, 'sync-notes is retired: notes are now thoughts in the hub (add them in the Library, or ask Claude)')));
  },
};
