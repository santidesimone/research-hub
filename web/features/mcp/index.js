// MCP server (Streamable HTTP, stateless) so Claude can use the hub: POST <base>/mcp with Authorization: Bearer <HUB_API_TOKEN>,
// or with an OAuth access token (the claude.ai connector; features/oauth). Without either, the 401 says where to get one.
// Tools call the same code as the REST API. Tools whose feature folder is missing are simply not offered.
const express = require('express');
// The MCP SDK uses the Web Crypto global, which Node only provides by default from version 20 (package.json allows 18).
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { requireOwner, isOwner, bearer } = require('../../core/auth');
const oauth = require('../../core/oauth');
const { BASE } = require('../../core/env');
const { run } = require('../../core/db');
const { schema, fieldsOf, relationsFrom } = require('../../core/schema');
const artifacts = require('../../core/artifacts');
const query = require('../../core/query');
const links = require('../../core/links');
const config = require('../../core/config');

const tryRequire = (p) => { try { return require(p); } catch { return null; } };
const files = tryRequire('../papers/files');
const personal = tryRequire('../personal');
const items = tryRequire('../../core/items');
const analysis = tryRequire('../../core/analysis');
const curation = tryRequire('../../core/curation');
const pkg = require('../../package.json');

const COLLECTIONS = Object.keys(schema.types).filter((t) => schema.types[t].collection);
const ANALYSIS_RULES = [
  'Fill only fields you are confident about. Leave a field empty rather than guess: empty beats wrong.',
  'Every key finding needs a location (page or section). Findings without one are saved but flagged "ungrounded".',
  'Interpretive links (builds_on, critiques, contradicts, supports, replicates, tests) need the justifying passage as evidence, or they are not saved. A TESTS link (paper to hypothesis) also needs its result: supported, refuted, mixed or inconclusive.',
  'Do not send source facts for papers (authors, year, venue, abstract, DOI metadata): the hub fills them from Crossref and OpenAlex.',
  'Pass vocabulary (topics, domains, organisations) as names; the hub matches them to existing nodes. Link other items by key.',
  'Saving fills empty fields only. It never overwrites the owner\'s edits or reviewed values; force replaces only values you wrote earlier.',
];
const PAPER_EXTRACT = 'For a paper, use extract to record what it contains: frameworks it uses ({title or name, framework_kind, ...}), research questions it states ({text, kind}) and hypotheses it tests ({statement, direction, result, evidence, location}). Each is matched to an existing item by its exact title or created, then linked (FRAMED_BY, ASKED_IN, TESTS). A hypothesis status is derived from all papers that tested it.';

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
  const relations = relationsFrom(t.label);
  return { collection, schema_version: t.schema_version, rules: collection === 'paper' ? [...ANALYSIS_RULES, PAPER_EXTRACT] : ANALYSIS_RULES,
    fields, filled_by_the_hub: sourceOnly, relations, ...(t.title_from ? { title: `optional: derived from ${t.title_from}` } : {}) };
}

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2).slice(0, 100000) }] });
const log = require('../../core/log');
// Our own errors (HttpError, status < 500) are meant for the caller. Anything else is logged, and in production only a
// short message reaches the client, as with the REST API (driver messages can name hosts and queries).
const fail = (e) => {
  const ours = e && e.status && e.status < 500;
  if (!ours) log.error('mcp tool failed: ' + ((e && e.stack) || String(e)));
  const text = ours || !config.get().production ? (e.message || String(e)) : 'Internal error (see the server log)';
  return { isError: true, content: [{ type: 'text', text }] };
};
const safe = (fn) => async (args) => { try { return text(await fn(args)); } catch (e) { return fail(e); } };

// A paper saved without a file gets upload_url: a Library page with a drop zone for its PDF. Files attached in a chat
// never reach the hub, so this is how the owner adds a private PDF in one step.
const UPLOAD_HINT = 'This paper has no file yet. If the owner attached the PDF in the chat, give them upload_url: they drop the file there and it goes to their Google Drive, linked to this paper.';
async function withUpload(result, uploadUrl) {
  if (!uploadUrl || !result || !result.key) return result;
  const [p] = await run('MATCH (p:Paper {key:$key}) RETURN p.file_url AS file', { key: result.key });
  return p && !p.file ? { ...result, upload_url: uploadUrl(result.key), upload_hint: UPLOAD_HINT } : result;
}

function buildServer({ uploadUrl = null } = {}) {
  const s = new McpServer({ name: 'research-hub', version: pkg.version }, {
    instructions: 'Tools for the owner\'s research hub: a Neo4j knowledge graph with collections (papers, methods, use cases, case studies, frameworks, research questions, hypotheses, ontologies and standards) plus notes and projects. '
      + 'To analyse something, call get_schema for its collection, then save_analysis once with every field you are confident about: it saves directly. '
      + 'Use search_items and get_item to read collections; call describe_graph before writing Cypher. '
      + 'When the owner shares a paper (a PDF in the chat, a link, a DOI): find its DOI, call get_schema for papers, then save_analysis once (doi, your analysis). '
      + 'For the file: if there is a public PDF URL on an allow-listed host (arXiv), pass it as file_url with copy_to_drive true, or call copy_pdf_to_drive. '
      + 'Files attached in the chat do not reach the hub: when the reply has upload_url, give it to the owner so they can drop the PDF there. '
      + 'To fix the graph (merge duplicates, remove a wrong link, delete junk, rename a concept), call propose_changes, show the owner the plan, and call apply_plan only after the owner says yes; revert_plan undoes an applied plan.',
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
      rel('(n {key:$key})-[r]->(m:Artifact|Person|Concept|Topic|Domain)'), rel('(m:Artifact|Person|Concept|Topic|Domain)-[r]->(n {key:$key})'),
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
  }, safe(async ({ overwrite, ...item }) => withUpload(await artifacts.add('paper', item, { overwrite: Boolean(overwrite) }), uploadUrl)));

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
        extract: z.object({
          frameworks: z.array(z.record(z.any())).optional(), research_questions: z.array(z.record(z.any())).optional(), hypotheses: z.array(z.record(z.any())).optional(),
        }).optional().describe('papers only: frameworks used, research questions stated, hypotheses tested (see get_schema rules)'),
        model: z.string().describe('your model id'), tier: z.enum(['standard', 'deep']).optional(),
        confidence: z.union([confidence, z.record(confidence)]).optional().describe('one level for all fields, or {field: level}; default medium'),
        force: z.boolean().optional().describe('replace values you (Claude) wrote earlier; never touches the owner\'s'),
        file_url: z.string().optional(), copy_to_drive: z.boolean().optional(),
      },
    }, safe(async (args) => (args.collection === 'paper' ? withUpload(await analysis.save(args), uploadUrl) : analysis.save(args))));

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

    if (uploadUrl) {
      s.registerTool('request_upload', {
        description: 'A link where the owner drops a PDF for an existing paper; the file goes to their Google Drive and is linked to the paper. '
          + 'Use it when the owner attached the PDF in the chat (attachments do not reach the hub) and there is no public PDF URL to copy with copy_pdf_to_drive. Give the owner the returned upload_url.',
        inputSchema: { key: z.string().describe('Paper key') },
      }, safe(async ({ key }) => {
        const [p] = await run('MATCH (p:Paper {key:$key}) RETURN p.file_url AS file', { key });
        if (!p) throw Object.assign(new Error('No such paper: ' + key), { status: 404 });
        return { key, upload_url: uploadUrl(key), has_file: Boolean(p.file), note: p.file ? 'The paper already has a file; uploading replaces it (a hub-uploaded one goes to the Drive trash).' : undefined };
      }));
    }

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

  if (curation) {
    const OP = z.object({
      op: z.enum(['merge', 'unlink', 'delete', 'rename']),
      keep: z.string().optional().describe('merge: the key that survives'),
      drop: z.string().optional().describe('merge: the key merged into keep, then deleted'),
      take: z.array(z.string()).optional().describe('merge: fields where drop\'s value should replace keep\'s (otherwise keep\'s wins)'),
      from: z.string().optional().describe('unlink: start of the relationship'),
      rel: z.string().optional().describe('unlink: relationship type, e.g. ABOUT'),
      to: z.string().optional().describe('unlink: end of the relationship'),
      key: z.string().optional().describe('delete or rename: the node'),
      name: z.string().optional().describe('rename: the new name (vocabulary only)'),
    });
    s.registerTool('propose_changes', {
      description: 'Propose a change plan to fix the graph; NOTHING changes yet. Operations: merge {keep, drop, take?} (duplicates of the same kind: relationships, empty fields, '
        + 'the file link and the owner\'s status move to keep; vocabulary keeps drop\'s name as an alias; two vocabulary kinds, e.g. a Concept into a Topic, merge when the schema allows every moved link), unlink {from, rel, to}, delete {key} (with the vocabulary only it used), '
        + 'rename {key, name} (vocabulary only; the old name stays as an alias). Several ops may go in one plan; they apply together or not at all. '
        + 'The reply lists every change, field conflicts and Drive files that would go to the trash. Show it to the owner in plain words and ask; call apply_plan only after a clear yes.',
      inputSchema: { ops: z.array(OP).min(1).max(50), reason: z.string().max(2000).describe('Why, in one or two sentences (it goes in the curation log)'), model: z.string().optional() },
    }, safe(async ({ ops, reason, model }) => curation.propose(ops, { reason, by: 'claude', model: model || null })));
    s.registerTool('apply_plan', {
      description: 'Apply a proposed plan, in one transaction. ONLY after the owner has approved this exact plan in the conversation. Refused if the data changed since it was proposed (propose again).',
      inputSchema: { id: z.string() },
    }, safe(async ({ id }) => curation.apply(id)));
    s.registerTool('revert_plan', {
      description: 'Undo an applied plan: the data goes back exactly as it was. Refused if it was changed again since (revert the later plans first).',
      inputSchema: { id: z.string() },
    }, safe(async ({ id }) => curation.revert(id)));
    s.registerTool('list_plans', {
      description: 'The curation log: plans with their status (proposed, applied, rejected, reverted), newest first.',
      inputSchema: { status: z.enum(['proposed', 'applied', 'rejected', 'reverted']).optional() },
    }, safe(async ({ status }) => curation.list({ status })));
  }
  return s;
}

// The owner token or cookie (requireOwner), or an OAuth access token, which is accepted here and nowhere else.
// A 401 carries WWW-Authenticate with the protected-resource metadata, which is how an OAuth client discovers the hub.
async function mcpAuth(req, res, next) {
  const b = bearer(req);
  if (oauth.isAccessToken(b)) {
    try { if (await oauth.verifyAccess(b)) return next(); } catch (e) { return next(e); }
  }
  if (config.get().token && !isOwner(req)) {
    const base = config.get().publicUrl || `${req.protocol}://${req.get('host')}`;
    res.set('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${BASE}/mcp"`);
    return res.status(401).json({ error: oauth.isAccessToken(b) ? 'The access token is invalid, expired or revoked.' : 'Sign in required (Bearer token or OAuth).' });
  }
  return requireOwner(req, res, next);
}

module.exports = {
  name: 'mcp',
  mcpAuth,
  withUpload,
  toolError: fail,
  mount(app) {
    app.post('/mcp', mcpAuth, express.json({ limit: '2mb' }), async (req, res) => {
      const server = buildServer({ uploadUrl: (key) => `${oauth.baseUrl(req)}/library/papers?key=${encodeURIComponent(key)}&upload=1` });
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
