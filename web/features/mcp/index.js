// MCP server (Streamable HTTP, stateless) so Claude can use the hub: POST <base>/mcp with Authorization: Bearer <HUB_API_TOKEN>.
// Tools call the same code as the REST API. Tools whose feature folder is missing are simply not offered.
const express = require('express');
// The MCP SDK uses the Web Crypto global, which Node only provides by default from version 20 (package.json allows 18).
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { requireOwner } = require('../../core/auth');
const { run } = require('../../core/db');
const { schema, fieldsOf } = require('../../core/schema');
const artifacts = require('../../core/artifacts');
const query = require('../../core/query');
const links = require('../../core/links');
const config = require('../../core/config');

const tryRequire = (p) => { try { return require(p); } catch { return null; } };
const files = tryRequire('../papers/files');
const personal = tryRequire('../personal');
const items = tryRequire('../../core/items');
const analysis = tryRequire('../../core/analysis');
const pkg = require('../../package.json');

const COLLECTIONS = Object.keys(schema.types).filter((t) => schema.types[t].collection);
const ANALYSIS_RULES = [
  'Fill only fields you are confident about. Leave a field empty rather than guess: empty beats wrong.',
  'Every key finding needs a location (page or section). Findings without one are saved but flagged "ungrounded".',
  'Interpretive paper-to-paper links (builds_on, critiques, contradicts, supports, replicates) need the justifying passage as evidence, or they are not saved.',
  'Do not send source facts for papers (authors, year, venue, abstract, DOI metadata): the hub fills them from Crossref and OpenAlex.',
  'Pass vocabulary (topics, domains, organisations) as names; the hub matches them to existing nodes. Link other items by key.',
  'Saving fills empty fields only. It never overwrites the owner\'s edits or reviewed values; force replaces only values you wrote earlier.',
];

// The fields of a collection as Claude needs them: what it may fill, enums, tiers, and what the hub fills itself.
function schemaFor(collection) {
  const t = schema.types[collection];
  const fields = {};
  const sourceOnly = [];
  for (const [name, f] of Object.entries(fieldsOf(collection))) {
    if (f.by.length === 1 && f.by[0] === 'Sys') continue;
    if (!f.by.includes('C')) { if (f.by.includes('S')) sourceOnly.push(name); continue; }
    fields[name] = Object.fromEntries(Object.entries({ type: f.type, list: f.list || undefined, enum: f.enum, ref: f.ref, props: f.props, min: f.min, max: f.max, tier: f.tier, label: f.label, help: f.help }).filter(([, v]) => v !== undefined));
  }
  const relations = Object.entries(schema.relation_types).filter(([, r]) => r.from.includes(t.label))
    .map(([rel, r]) => ({ rel, to: r.to, interpretive: Boolean(r.interpretive) }));
  return { collection, schema_version: t.schema_version, rules: ANALYSIS_RULES, fields, filled_by_the_hub: sourceOnly, relations };
}

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2).slice(0, 100000) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e.message || String(e) }] });
const safe = (fn) => async (args) => { try { return text(await fn(args)); } catch (e) { return fail(e); } };

function buildServer() {
  const s = new McpServer({ name: 'research-hub', version: pkg.version }, {
    instructions: 'Tools for the owner\'s research hub: a Neo4j knowledge graph with four collections (papers, methods, use cases, case studies) plus notes and projects. '
      + 'To analyse something, call get_schema for its collection, then save_analysis once with every field you are confident about: it saves directly. '
      + 'Use search_items and get_item to read collections; call describe_graph before writing Cypher.',
  });

  s.registerTool('describe_graph', { description: 'Describe the graph: labels, relationship types, properties, patterns, conventions and example queries. Call this before run_cypher.', inputSchema: {} },
    safe(() => query.overview()));

  s.registerTool('run_cypher', {
    description: 'Run a READ-ONLY Cypher query (single statement, no procedure calls, max 500 rows). Returns columns and rows.',
    inputSchema: { cypher: z.string().describe('The Cypher query'), params: z.record(z.any()).optional().describe('Query parameters') },
  }, safe(({ cypher, params }) => query.readOnly(cypher, params || {})));

  s.registerTool('search_papers', {
    description: 'Find papers by text in title, author, venue or topic.',
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(100).optional() },
  }, safe(({ query: q, limit }) => query.searchPapers(q, limit)));

  s.registerTool('get_artifact', {
    description: 'Get one artifact (paper, method, note, project, person, concept) by key, with its relationships and your personal status.',
    inputSchema: { key: z.string().describe("e.g. 'doi:10.1007/978-1-4757-0602-4_18' or 'method:tdd'") },
  }, safe(async ({ key }) => {
    const [node] = await run('MATCH (n {key:$key}) RETURN labels(n) AS labels, properties(n) AS props', { key });
    if (!node) throw new Error('No such artifact');
    const file = links.describe(node.props.file_url);
    const rel = (pattern) => run(`MATCH ${pattern} RETURN type(r) AS type, m.key AS key, coalesce(m.title, m.name) AS title`, { key });
    const [out, inc, st] = await Promise.all([
      rel('(n {key:$key})-[r]->(m:Artifact|Person|Concept)'), rel('(m:Artifact|Person|Concept)-[r]->(n {key:$key})'),
      run("MATCH (s:Personal {key:'personal:' + $key}) RETURN properties(s) AS p", { key }),
    ]);
    return { key, labels: node.labels, props: node.props, file, links_out: out, links_in: inc, personal: st[0] ? st[0].p : null };
  }));

  s.registerTool('add_paper', {
    description: 'Add a paper. Send a full item, or only {DOI} and the hub looks up the metadata. file_url is a link to the PDF (Google Drive, arXiv, a publisher) and is stored as given; nothing is downloaded unless copy_to_drive is true, which copies a PDF from an allow-listed host (arXiv, UCL Discovery by default) into the owner\'s Drive.',
    inputSchema: {
      DOI: z.string().optional(), title: z.string().optional(),
      itemType: z.enum(['journalArticle', 'conferencePaper', 'preprint', 'book', 'bookSection', 'report', 'thesis', 'webpage', 'document', 'presentation']).optional(),
      creators: z.array(z.string()).optional().describe('"First Last"'), date: z.string().optional(), url: z.string().optional(),
      abstractNote: z.string().optional(), publicationTitle: z.string().optional(), repository: z.string().optional(),
      tags: z.array(z.string()).optional().describe('topic:<name>, public, status:<value>'),
      file_url: z.string().optional().describe('https link to the PDF'), pdf_url: z.string().optional().describe('older name for file_url'),
      copy_to_drive: z.boolean().optional().describe('download the PDF (allow-listed hosts only) and store it in Drive'), overwrite: z.boolean().optional(),
    },
  }, safe(({ overwrite, ...item }) => artifacts.add('paper', item, { overwrite: Boolean(overwrite) })));

  s.registerTool('add_artifact', {
    description: 'Add a method, note or project (any non-paper type in schema.json). Relation arrays take artifact keys.',
    inputSchema: {
      type: z.enum(Object.keys(schema.types).filter((t) => t !== 'paper')), title: z.string(), summary: z.string().optional(), body: z.string().optional().describe('Markdown'),
      visibility: z.enum(['public', 'private']).optional(), concepts: z.array(z.string()).optional(),
      relations: z.record(z.array(z.string())).optional().describe('e.g. {"annotates": ["doi:10.1/x"], "uses": ["method:tdd"]}'),
      overwrite: z.boolean().optional(),
    },
  }, safe(({ type, relations, overwrite, ...rest }) => artifacts.add(type, { ...rest, ...(relations || {}) }, { overwrite: Boolean(overwrite) })));

  if (items && analysis) {
    const confidence = z.enum(['low', 'medium', 'high']);
    s.registerTool('get_schema', {
      description: 'The fields of a collection that you may fill (types, enums, tiers), the relations it can have, and the rules for saving an analysis. Call this before save_analysis.',
      inputSchema: { collection: z.enum(COLLECTIONS) },
    }, safe(async ({ collection }) => schemaFor(collection)));

    s.registerTool('save_analysis', {
      description: 'Save your analysis of a paper, method, use case or case study in ONE call. It is saved immediately (no approval step) with provenance (you, the model, a confidence) and can be audited later. '
        + 'Identify the item by key, or a paper by doi or url, or a new method/use case/case study by fields.title. For papers the hub fills the source facts itself (Crossref, OpenAlex). '
        + 'Only empty fields are filled; the owner\'s values are never overwritten. Leave a field out rather than guess. Every key finding needs a location. Returns what was filled, skipped, still empty and flagged.',
      inputSchema: {
        collection: z.enum(COLLECTIONS), key: z.string().optional(), doi: z.string().optional(), url: z.string().optional(),
        fields: z.record(z.any()).describe('Field name -> value, from get_schema. Objects as JSON objects; vocabulary as names.'),
        links: z.array(z.object({
          rel: z.string().describe('e.g. INTRODUCES, USES, ADDRESSES, BUILDS_ON, CRITIQUES, ABOUT'), target: z.string().describe('a key, or a name'),
          kind: z.string().optional().describe('when target is a name: Topic, Concept, Domain, Method, Paper ...'),
          evidence: z.string().optional().describe('the justifying passage (required for interpretive links)'), location: z.string().optional().describe('page or section'),
          confidence: confidence.optional(),
        })).optional(),
        model: z.string().describe('your model id'), tier: z.enum(['standard', 'deep']).optional(),
        confidence: z.union([confidence, z.record(confidence)]).optional().describe('one level for all fields, or {field: level}; default medium'),
        force: z.boolean().optional().describe('replace values you (Claude) wrote earlier; never touches the owner\'s'),
        file_url: z.string().optional(), copy_to_drive: z.boolean().optional(),
      },
    }, safe((args) => analysis.save(args)));

    s.registerTool('search_items', {
      description: 'List a collection: full-text query, filters (the collection\'s filters from get_schema, e.g. {"kind": "technique", "domain": "payments"}), sort, cursor paging.',
      inputSchema: {
        collection: z.enum(COLLECTIONS), q: z.string().optional(), filters: z.record(z.string()).optional(),
        sort: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(),
      },
    }, safe(({ filters, limit, ...rest }) => items.list({ ...rest, ...(filters || {}), ...(limit ? { limit: String(limit) } : {}) })));

    s.registerTool('get_item', {
      description: 'One collection item by key: every field, per-field provenance (who wrote it, model, confidence, reviewed or not) and its links.',
      inputSchema: { key: z.string() },
    }, safe(({ key }) => items.get(key)));
  }

  if (files) {
    s.registerTool('set_file_link', {
      description: 'Set the file link of an existing paper (any https URL, e.g. a Google Drive share link or an arXiv PDF). Nothing is downloaded. A Drive file the hub uploaded earlier is moved to the Drive trash.',
      inputSchema: { key: z.string().describe('Paper key'), file_url: z.string() },
    }, safe(async ({ key, file_url }) => ({ key, ...(await files.setLink(key, file_url)) })));

    s.registerTool('copy_pdf_to_drive', {
      description: "Download a PDF from an allow-listed https host (arXiv, UCL Discovery by default) and upload it to the owner's Google Drive, then store the Drive link on the paper. Needs Drive to be configured on the server.",
      inputSchema: { key: z.string().describe('Paper key'), pdf_url: z.string() },
    }, safe(async ({ key, pdf_url }) => ({ key, ...(await files.uploadPdf(key, await files.fetchPdf(pdf_url))) })));

    s.registerTool('remove_file_link', {
      description: 'Remove the file link from a paper. A Drive file the hub uploaded is moved to the Drive trash.',
      inputSchema: { key: z.string().describe('Paper key') },
    }, safe(async ({ key }) => ({ key, ...(await files.removeLink(key)) })));
  }

  if (personal) {
    s.registerTool('set_status', {
      description: "Set the owner's personal status for an artifact (e.g. to-read, reading, read, canonical, critique-target). null clears it.",
      inputSchema: { key: z.string(), status: z.string().nullable() },
    }, safe(async ({ key, status }) => { await personal.setState(key, { status }); return { key, status }; }));
  }
  return s;
}

module.exports = {
  name: 'mcp',
  mount(app) {
    app.post('/mcp', requireOwner, express.json({ limit: '2mb' }), async (req, res) => {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e) {
        console.error('mcp error', e);
        if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    });
    for (const m of ['get', 'delete']) {
      app[m]('/mcp', (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST).' }, id: null }));
    }
  },
};
