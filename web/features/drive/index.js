// Google Drive status and a connectivity check (`hub drive`). The upload itself lives in core/drive.js.
const { requireOwner } = require('../../core/auth');
const drive = require('../../core/drive');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  name: 'drive',
  mount(app) {
    app.get('/api/drive', requireOwner, (_req, res) => res.json({ configured: drive.configured() }));
    app.post('/api/drive/check', requireOwner, wrap(async (_req, res) => res.json(await drive.check())));
  },
};
