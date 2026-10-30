// The public preview: nodes marked public, whitelisted fields only (schema.public_props), computed from the graph on demand.
// There is no file and no bucket: the result is cached in memory for PUBLIC_CACHE_SECONDS and dropped whenever the hub
// writes, so one instance is always current and other Cloud Run instances catch up within the TTL.
const crypto = require('crypto');
const { run } = require('./db');
const { schema } = require('./schema');
const config = require('./config');

const PUBLIC = new Set(schema.public_props);
const keep = (props) => Object.fromEntries(Object.entries(props).filter(([k]) => PUBLIC.has(k)));

async function build() {
  const [nodes, extra, edges] = await Promise.all([
    run("MATCH (a:Artifact {visibility:'public'}) RETURN a.key AS key, labels(a) AS labels, properties(a) AS props"),
    run("MATCH (:Artifact {visibility:'public'})-[]->(b) WHERE b:Person OR b:Concept RETURN DISTINCT b.key AS key, labels(b) AS labels, properties(b) AS props"),
    run("MATCH (a:Artifact {visibility:'public'})-[r]->(b) WHERE b:Person OR b:Concept OR (b:Artifact AND b.visibility = 'public') RETURN a.key AS `from`, b.key AS `to`, type(r) AS type"),
  ]);
  const seen = new Set();
  const outNodes = [];
  for (const n of [...nodes, ...extra]) {
    if (seen.has(n.key)) continue;
    seen.add(n.key);
    outNodes.push({ key: n.key, labels: n.labels, props: keep(n.props) });
  }
  outNodes.sort((a, b) => (a.key < b.key ? -1 : 1));
  edges.sort((a, b) => (`${a.from}|${a.to}|${a.type}` < `${b.from}|${b.to}|${b.type}` ? -1 : 1));
  return { nodes: outNodes, edges };
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
