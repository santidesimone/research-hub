// Rebuild the public preview now (it also refreshes by itself after every write and every PUBLIC_CACHE_SECONDS).
const { requireOwner } = require('../../core/auth');
const publicExport = require('../../core/public-export');

module.exports = {
  name: 'sync',
  mount(app) {
    app.post('/api/sync', requireOwner, async (_req, res, next) => {
      try {
        publicExport.invalidate();
        const c = await publicExport.read();
        res.json({ ok: true, public: { nodes: c.nodes, edges: c.edges } });
      } catch (e) { next(e); }
    });
  },
};
