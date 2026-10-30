// POST /api/enrich?limit=100&offset=0: add citation edges via OpenAlex. The CLI (`hub enrich`) loops over the batches.
const { requireOwner } = require('../../core/auth');
const openalex = require('../../core/openalex');

module.exports = {
  name: 'enrich',
  mount(app) {
    app.post('/api/enrich', requireOwner, (req, res, next) => {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      openalex.enrich({ limit, offset }).then((r) => res.json(r)).catch(next);
    });
  },
};
