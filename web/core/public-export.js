// The public preview: nodes marked public, computed from the graph on demand. How much of each node goes out is the
// owner's publishing setting (core/publishing.js): 'basic' keeps the whitelist (schema.public_props; a type's own
// public_props can only narrow it, and vocabulary nodes, only the labels marked public in schema.entities, export
// entity_public_props); 'full' keeps every property except the hidden bookkeeping and Drive links, and adds the
// note text as HTML.
// There is no file and no bucket: the result is cached in memory for PUBLIC_CACHE_SECONDS and dropped whenever the hub
// writes, so one instance is always current and other Cloud Run instances catch up within the TTL.
const crypto = require('crypto');
const { marked } = require('marked');
const { run } = require('./db');
const { publicProps, publicEntityLabels } = require('./schema');
const config = require('./config');
const publishing = require('./publishing');

const whitelist = (props, labels) => { const allowed = publicProps(labels); return Object.fromEntries(Object.entries(props).filter(([k]) => allowed.has(k))); };
const VOCAB = 'any(l IN labels(b) WHERE l IN $vocab)';
// A case study marked confidential stays out of the preview even if its visibility says public.
const OPEN = (n) => `coalesce(${n}.sensitivity, 'public') <> 'confidential'`;

async function build() {
  const { public_detail: detail } = await publishing.get();
  const [nodes, extra, edges] = await Promise.all([
    run(`MATCH (a:Artifact {visibility:'public'}) WHERE ${OPEN('a')} RETURN a.key AS key, labels(a) AS labels, properties(a) AS props`),
    run(`MATCH (a:Artifact {visibility:'public'})-[]->(b) WHERE ${OPEN('a')} AND ${VOCAB} RETURN DISTINCT b.key AS key, labels(b) AS labels, properties(b) AS props`, { vocab: publicEntityLabels }),
    run(`MATCH (a:Artifact {visibility:'public'})-[r]->(b) WHERE ${OPEN('a')} AND (${VOCAB} OR (b:Artifact AND b.visibility = 'public' AND ${OPEN('b')})) RETURN a.key AS \`from\`, b.key AS \`to\`, type(r) AS type`, { vocab: publicEntityLabels }),
  ]);
  const seen = new Set();
  const outNodes = [];
  for (const n of [...nodes, ...extra]) {
    if (seen.has(n.key)) continue;
    seen.add(n.key);
    if (detail !== 'full') { outNodes.push({ key: n.key, labels: n.labels, props: whitelist(n.props, n.labels) }); continue; }
    const props = publishing.fullProps(n.props);
    outNodes.push({ key: n.key, labels: n.labels, props, ...(props.body ? { html: marked.parse(String(props.body)) } : {}) });
  }
  outNodes.sort((a, b) => (a.key < b.key ? -1 : 1));
  edges.sort((a, b) => (`${a.from}|${a.to}|${a.type}` < `${b.from}|${b.to}|${b.type}` ? -1 : 1));
  return { detail, nodes: outNodes, edges };
}

let cache = null;
let inflight = null;

// -> { text, etag, nodes, edges, at }
async function read() {
  const ttl = config.get().publicCacheSeconds * 1000;
  if (cache && Date.now() - cache.at < ttl) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const data = await build();
    const etag = '"' + crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 16) + '"'; // stable while the data is unchanged
    cache = { at: Date.now(), etag, nodes: data.nodes.length, edges: data.edges.length, text: JSON.stringify({ exported_at: new Date().toISOString(), ...data }) };
    return cache;
  })();
  try { return await inflight; } finally { inflight = null; }
}

const invalidate = () => { cache = null; };

module.exports = { read, invalidate, build };
