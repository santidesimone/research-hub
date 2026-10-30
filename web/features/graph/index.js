// Read side: schema for the UI, the whole graph (slim), one artifact with its neighbours, and the public preview.
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const matter = require('gray-matter');
const { run } = require('../../core/db');
const { publicView } = require('../../core/schema');
const migrate = require('../../core/migrate');
const { CONTENT_DIR } = require('../../core/env');
const { requireOwner, isOwner } = require('../../core/auth');
const registry = require('../../core/registry');
const publicExport = require('../../core/public-export');
const hooks = require('../../core/hooks');
const links = require('../../core/links');
const config = require('../../core/config');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The graph view only needs names and a few facts per node; abstracts, bodies and links load when you open a node.
const GRAPH_PROPS = ['title', 'name', 'year', 'visibility', 'item_type'];

module.exports = {
  name: 'graph',
  mount(app) {
    // Anything that changes the graph can change the public preview.
    hooks.on('afterWrite', () => publicExport.invalidate());
    hooks.on('afterRemove', () => publicExport.invalidate());

    app.get('/api/schema', wrap(async (req, res) => {
      const out = { ...publicView(), features: registry.features };
      if (isOwner(req)) { try { out.migrations = await migrate.applied(); } catch { /* database not reachable yet */ } }
      res.json(out);
    }));

    app.get('/api/graph', requireOwner, wrap(async (_req, res) => {
      const nodes = await run('MATCH (n:Artifact|Person|Concept) RETURN n.key AS key, labels(n) AS labels, properties(n) AS props');
      for (const n of nodes) n.props = Object.fromEntries(GRAPH_PROPS.filter((k) => n.props[k] != null).map((k) => [k, n.props[k]]));
      const edges = await run('MATCH (a:Artifact|Person|Concept)-[r]->(b:Artifact|Person|Concept) RETURN a.key AS `from`, b.key AS `to`, type(r) AS type');
      // revalidate with the ETag instead of re-downloading when nothing changed
      res.set('Cache-Control', 'private, no-cache').vary('Authorization').vary('Cookie');
      res.json({ nodes, edges });
    }));

    app.get('/api/artifact', requireOwner, wrap(async (req, res) => {
      const key = String(req.query.key || '');
      const [node] = await run('MATCH (n {key:$key}) RETURN n.key AS key, labels(n) AS labels, properties(n) AS props', { key });
      if (!node) return res.status(404).json({ error: 'not found' });
      node.file = links.describe(node.props.file_url);
      node.has_file = Boolean(node.file);
      const q = (dir) => run(
        `MATCH ${dir === 'out' ? '(n {key:$key})-[r]->(m:Artifact|Person|Concept)' : '(m:Artifact|Person|Concept)-[r]->(n {key:$key})'}
         RETURN type(r) AS type, m.key AS key, labels(m) AS labels, coalesce(m.title, m.name) AS title`, { key });
      const [out, inc] = await Promise.all([q('out'), q('in')]);
      let html = null;
      if (node.props.body) { // text stored on the node (notes created through the API, Claude or `hub sync-notes`)
        html = marked.parse(String(node.props.body));
      } else if (node.props.path) { // older Markdown nodes that still point into a local content folder
        const file = path.resolve(CONTENT_DIR, node.props.path);
        if (file.startsWith(CONTENT_DIR + path.sep) && fs.existsSync(file)) html = marked.parse(matter(fs.readFileSync(file, 'utf8')).content);
      }
      res.json({ ...node, out, in: inc, html });
    }));

    // Public preview: cached and revalidated, so a CDN or the browser can answer most requests.
    app.get('/api/public', async (req, res, next) => {
      try {
        const c = await publicExport.read();
        const ttl = config.get().publicCacheSeconds;
        res.set('Cache-Control', `public, max-age=${ttl}`).set('ETag', c.etag);
        if (req.fresh) return res.status(304).end();
        res.type('json').send(c.text);
      } catch (e) { next(e); }
    });
  },
};
