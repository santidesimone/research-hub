// Citation edges from OpenAlex: for each paper with a DOI, record its OpenAlex id and citation count and add
// (:Paper)-[:CITES {source:'openalex'}]->(:Paper) between papers that are both in your library. On demand (`hub enrich`).
const neo4j = require('neo4j-driver');
const { run, writeTx } = require('./db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let http = (url, opts) => fetch(url, opts); // replaceable so tests never touch the network
const setHttp = (fn) => { http = fn; };
const config = require('./config');
const workUrl = (doi) => { const email = config.get().openalexEmail; return `https://api.openalex.org/works/https://doi.org/${encodeURI(doi)}${email ? '?mailto=' + encodeURIComponent(email) : ''}`; };

// One work by DOI -> the OpenAlex record, or null when OpenAlex does not know it. Throws on network or server errors.
async function lookupWork(doi) {
  const res = await http(workUrl(doi), { signal: AbortSignal.timeout(15000) });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function enrich({ limit = 100, offset = 0, delayMs = 150 } = {}) {
  const papers = await run(
    'MATCH (p:Paper) WHERE p.doi IS NOT NULL RETURN p.key AS key, p.doi AS doi ORDER BY p.key SKIP $offset LIMIT $limit',
    { offset: neo4j.int(offset), limit: neo4j.int(limit) });
  const refs = new Map();
  const errors = [];
  for (const p of papers) {
    try {
      const res = await http(workUrl(p.doi), { signal: AbortSignal.timeout(15000) });
      if (res.status !== 200) { errors.push(`${p.doi}: HTTP ${res.status}`); }
      else {
        const w = await res.json();
        const oa = String(w.id).split('/').pop();
        await writeTx((tx) => tx.run('MATCH (p:Paper {key:$k}) SET p.openalex_id = $oa, p.cited_by_count = $c', { k: p.key, oa, c: neo4j.int(w.cited_by_count || 0) }));
        refs.set(p.key, (w.referenced_works || []).map((x) => String(x).split('/').pop()));
      }
    } catch (e) { errors.push(`${p.doi}: ${e.message}`); }
    await sleep(delayMs);
  }
  let edges = 0;
  for (const [key, list] of refs) {
    const res = await writeTx((tx) => tx.run(
      `MATCH (a:Paper {key:$k}) MATCH (b:Paper) WHERE b.openalex_id IN $refs AND b.key <> a.key
       MERGE (a)-[r:CITES]->(b) SET r.source = 'openalex' RETURN count(r) AS c`, { k: key, refs: list }));
    edges += res.records[0].get('c').toNumber();
  }
  return { processed: papers.length, matched: refs.size, cites_edges: edges, errors, next_offset: papers.length === limit ? offset + limit : null };
}

module.exports = { enrich, lookupWork, setHttp };
