// MCP server (Streamable HTTP, stateless) so Claude can use the hub: POST <base>/mcp with Authorization: Bearer <HUB_API_TOKEN>.
// Tools call the same code as the REST API. Tools whose feature folder is missing are simply not offered.
const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { requireOwner } = require('../../core/auth');
const { run } = require('../../core/db');
const { schema } = require('../../core/schema');
const artifacts = require('../../core/artifacts');
const query = require('../../core/query');
const links = require('../../core/links');
const config = require('../../core/config');

const tryRequire = (p) => { try { return require(p); } catch { return null; } };
const files = tryRequire('../papers/files');
const personal = tryRequire('../personal');

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2).slice(0, 100000) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e.message || String(e) }] });
const safe = (fn) => async (args) => { try { return text(await fn(args)); } catch (e) { return fail(e); } };

function buildServer() {
  const s = new McpServer({ name: 'research-hub', version: '0.6.0' }, {
    instructions: 'Tools for the owner\'s research hub: a Neo4j knowledge graph of papers, methods, notes and projects. Call describe_graph before writing Cypher.',
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
