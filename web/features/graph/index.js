// Read side: schema for the UI, the whole graph (slim), one artifact with its neighbours, and the public preview.
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const matter = require('gray-matter');
const { run } = require('../../core/db');
const { publicView, entityLabels, safeLabel } = require('../../core/schema');
const types = require('../../core/types');
const migrate = require('../../core/migrate');
const { CONTENT_DIR } = require('../../core/env');
const { requireOwner, isOwner } = require('../../core/auth');
const registry = require('../../core/registry');
const publicExport = require('../../core/public-export');
const publishing = require('../../core/publishing');
const hooks = require('../../core/hooks');
const links = require('../../core/links');
const config = require('../../core/config');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The graph view only needs names and a few facts per node; abstracts, bodies and links load when you open a node.
const GRAPH_PROPS = ['title', 'name', 'year', 'visibility', 'item_type'];
// Every node the hub shows: items and the vocabulary labels in schema.json.
const NODES = ['Artifact', ...entityLabels.map(safeLabel)].join('|');

module.exports = {
  name: 'graph',
  mount(app) {
    // Anything that changes the graph can change the public preview.
    hooks.on('afterWrite', () => publicExport.invalidate());
    hooks.on('afterRemove', () => publicExport.invalidate());

    app.get('/api/schema', wrap(async (req, res) => {
      const out = { ...publicView(), features: registry.features };
      for (const c of out.collections) c.locked = types.get(c.name).locked || []; // fields owner edits may not change (papers: identity and sources)
      if (isOwner(req)) {
        try { out.migrations = await migrate.applied(); } catch { /* database not reachable yet */ }
        try { // new-item forms start on the owner's default visibility (Settings), not the schema's
          out.publishing = await publishing.get();
          for (const c of out.collections) if (c.fields.visibility) c.fields.visibility = { ...c.fields.visibility, default: out.publishing.default_visibility };
        } catch { /* database not reachable yet: the schema's default stands */ }
      }
      res.json(out);
    }));

    app.get('/api/graph', requireOwner, wrap(async (_req, res) => {
      const nodes = await run(`MATCH (n:${NODES}) RETURN n.key AS key, labels(n) AS labels, properties(n) AS props`);
      for (const n of nodes) n.props = Object.fromEntries(GRAPH_PROPS.filter((k) => n.props[k] != null).map((k) => [k, n.props[k]]));
      const edges = await run(`MATCH (a:${NODES})-[r]->(b:${NODES}) RETURN a.key AS \`from\`, b.key AS \`to\`, type(r) AS type`);
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
        `MATCH ${dir === 'out' ? `(n {key:$key})-[r]->(m:${NODES})` : `(m:${NODES})-[r]->(n {key:$key})`}
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
    app.get('/api/public', (req, res, next) => (config.get().publicAccess ? next() : requireOwner(req, res, next)), async (req, res, next) => {
      try {
        const c = await publicExport.read();
        const ttl = config.get().publicCacheSeconds;
        // owner-only while PUBLIC_ACCESS is off: then no shared cache (the site's CDN) may keep it
        if (config.get().publicAccess) res.set('Cache-Control', `public, max-age=${ttl}`);
        else res.set('Cache-Control', 'private, no-cache').vary('Authorization').vary('Cookie');
        res.set('ETag', c.etag);
        if (req.fresh) return res.status(304).end();
        res.type('json').send(c.text);
      } catch (e) { next(e); }
    });
  },
};
