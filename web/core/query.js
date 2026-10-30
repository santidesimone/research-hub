// Read-only Cypher for the owner (REST, MCP and CLI all use this). Defence in depth, because Neo4j Community has no read-only user:
//   1. text guard: one statement, no procedures (CALL name(...)), no LOAD CSV
//   2. EXPLAIN first: the planner must classify the query as read-only
//   3. executed in a READ transaction with a timeout, and the result is capped
const neo4j = require('neo4j-driver');
const db = require('./db');
const { driver } = db;
const { HttpError } = require('./errors');

const MAX_ROWS = 500;
const TIMEOUT_MS = 15000;

function guard(q) {
  if (typeof q !== 'string' || !q.trim()) throw new HttpError(400, 'cypher is required');
  if (q.length > 10000) throw new HttpError(400, 'query too long');
  if (/;\s*\S/.test(q)) throw new HttpError(400, 'one statement only');
  if (/\bLOAD\s+CSV\b/i.test(q)) throw new HttpError(400, 'LOAD CSV is not allowed');
  if (/\bCALL\b(?!\s*\{)/i.test(q)) throw new HttpError(400, 'procedure calls are not allowed (CALL { subquery } is fine)');
}

function ser(v) {
  if (neo4j.isInt(v)) return neo4j.integer.inSafeRange(v) ? v.toNumber() : v.toString();
  if (neo4j.isNode(v)) return { _node: v.labels.filter((l) => l !== 'Artifact'), ...ser(v.properties) };
  if (neo4j.isRelationship(v)) return { _rel: v.type, ...ser(v.properties) };
  if (neo4j.isPath(v)) return { _path: v.segments.map((s) => [ser(s.start), ser(s.relationship), ser(s.end)]) };
  if (neo4j.isDateTime(v) || neo4j.isDate(v) || neo4j.isLocalDateTime(v)) return v.toString();
  if (Array.isArray(v)) return v.map(ser);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x)]));
  return v;
}

async function readOnly(cypher, params = {}) {
  guard(cypher);
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    let type;
    try { type = (await session.run('EXPLAIN ' + cypher, params)).summary.queryType; }
    catch (e) { throw new HttpError(400, 'Cypher error: ' + e.message); }
    if (type !== 'r') throw new HttpError(400, 'Only read-only queries are allowed here.');
    let result;
    try { result = await session.executeRead((tx) => tx.run(cypher, params), { timeout: TIMEOUT_MS }); }
    catch (e) { throw new HttpError(400, 'Cypher error: ' + e.message); }
    const rows = result.records.slice(0, MAX_ROWS).map((r) => Object.fromEntries(r.keys.map((k) => [k, ser(r.get(k))])));
    return { columns: result.records.length ? result.records[0].keys : [], rows, count: result.records.length, truncated: result.records.length > MAX_ROWS };
  } finally {
    await session.close();
  }
}

// What a model (or you) needs to write correct Cypher for this graph.
async function overview() {
  const q = async (c) => (await readOnly(c)).rows;
  const [labels, rels, props, patterns] = await Promise.all([
    q('MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY count DESC'),
    q('MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY count DESC'),
    q('MATCH (n) UNWIND labels(n) AS label UNWIND keys(n) AS k RETURN label, collect(DISTINCT k) AS properties ORDER BY label'),
    q("MATCH (a)-[r]->(b) RETURN DISTINCT [l IN labels(a) WHERE l <> 'Artifact'][0] AS from, type(r) AS rel, [l IN labels(b) WHERE l <> 'Artifact'][0] AS to ORDER BY from, rel"),
  ]);
  return {
    labels, relationship_types: rels, properties_by_label: props, patterns,
    notes: [
      'Every paper/method/note/project node has labels :Artifact and its type (:Paper, :Method, :Note, :Project). Person and Concept are separate labels.',
      "Keys: papers 'doi:<lowercase doi>' or 'paper:<hash>'; others '<type>:<slug>'; people 'person:<slug>'; concepts 'concept:<slug>'.",
      "Your personal layer (status such as to-read/reading/read/canonical/critique-target) is NOT on the paper: it is (:Personal {key:'personal:<artifact key>', status})-[:FOR]->(:Artifact).",
      'Papers have: title, year, doi, venue, url, abstract, authors[], author_lasts[], item_type, visibility, file_url (link to the PDF, usually Google Drive), drive_file_id (set only when the hub uploaded the file), openalex_id, cited_by_count. Relationships: AUTHORED_BY, ABOUT, CITES, ANNOTATES, USES, EXTENDS, SUPPORTS, CONTRADICTS, CRITIQUES, INSPIRED.',
      'Queries are read-only, return at most 500 rows, and must be a single statement without procedure calls.',
    ],
    examples: [
      'MATCH (p:Paper)-[:AUTHORED_BY]->(x:Person) RETURN x.name, count(p) AS papers ORDER BY papers DESC',
      "MATCH (s:Personal {status:'to-read'})-[:FOR]->(p:Paper) RETURN p.title, p.year ORDER BY p.year DESC",
      'MATCH (p1:Paper)-[:ABOUT]->(c:Concept)<-[:ABOUT]-(p2:Paper) WHERE p1.key < p2.key RETURN p1.title, p2.title, collect(c.name) AS shared',
    ],
  };
}

// Full-text search (ranked) over the artifact_text index, plus papers whose topics match. Falls back to a plain scan if the
// index does not exist yet. This runs fixed, server-written Cypher, so it does not go through the owner-query guard.
const LUCENE_SPECIAL = /[+\-!(){}\[\]^"~*?:\\/&|]/g;
function luceneQuery(text) {
  const terms = String(text || '').toLowerCase().replace(LUCENE_SPECIAL, ' ').split(/\s+/).filter(Boolean).slice(0, 8);
  return terms.map((t) => t + '*').join(' AND ');
}
const SEARCH_COLUMNS = ['key', 'title', 'year', 'authors', 'topics', 'has_file', 'status'];
const SEARCH_RETURN = `RETURN p.key AS key, p.title AS title, p.year AS year, p.authors AS authors,
            [(p)-[:ABOUT]->(c:Concept) | c.name] AS topics,
            p.file_url IS NOT NULL AS has_file,
            head([(s:Personal {key: 'personal:' + p.key}) | s.status]) AS status`;

async function searchPapers(text, limit = 20) {
  const n = neo4j.int(Math.min(Number(limit) || 20, 100));
  const q = String(text || '').toLowerCase().trim();
  const lucene = luceneQuery(q);
  if (lucene) {
    try {
      const rows = await db.run(
        `CALL {
           CALL db.index.fulltext.queryNodes('artifact_text', $lucene) YIELD node, score
           WITH node, score WHERE node:Paper RETURN node AS p, score
           UNION
           MATCH (p:Paper)-[:ABOUT]->(c:Concept) WHERE toLower(c.name) CONTAINS $q RETURN p, 1.0 AS score
         }
         WITH p, max(score) AS score
         ${SEARCH_RETURN}
         ORDER BY score DESC, p.year DESC LIMIT $limit`,
        { lucene, q, limit: n });
      return { columns: SEARCH_COLUMNS, rows, count: rows.length, truncated: false };
    } catch (e) { /* index missing or not online yet: use the scan below */ }
  }
  return readOnly(
    `MATCH (p:Paper)
     WHERE toLower(p.title) CONTAINS $q OR any(a IN p.authors WHERE toLower(a) CONTAINS $q)
        OR toLower(coalesce(p.venue, '')) CONTAINS $q
        OR EXISTS { MATCH (p)-[:ABOUT]->(c:Concept) WHERE toLower(c.name) CONTAINS $q }
     ${SEARCH_RETURN}
     ORDER BY p.year DESC LIMIT $limit`,
    { q, limit: n });
}

module.exports = { readOnly, overview, searchPapers, guard, luceneQuery, MAX_ROWS };
