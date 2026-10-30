// Query: run read-only Cypher against the graph (owner only). Same endpoint the CLI and Claude use.
import { h, api } from '../../shell/ui.js';

const EXAMPLES = {
  'Co-author pairs': 'MATCH (a:Person)<-[:AUTHORED_BY]-(p:Paper)-[:AUTHORED_BY]->(b:Person)\nWHERE a.key < b.key\nRETURN a.name AS author_a, b.name AS author_b, count(p) AS papers_together\nORDER BY papers_together DESC',
  'Papers sharing 2+ topics': 'MATCH (p1:Paper)-[:ABOUT]->(c:Concept)<-[:ABOUT]-(p2:Paper)\nWHERE p1.key < p2.key\nWITH p1, p2, collect(c.name) AS shared\nWHERE size(shared) >= 2\nRETURN p1.title, p2.title, shared ORDER BY size(shared) DESC',
  'My reading backlog': "MATCH (s:Personal)-[:FOR]->(p:Paper)\nWHERE s.status IN ['to-read', 'reading']\nRETURN s.status AS status, p.title AS title, p.year AS year\nORDER BY status, year DESC",
  'Papers by author': 'MATCH (p:Paper)-[:AUTHORED_BY]->(x:Person)\nRETURN x.name AS author, count(p) AS papers\nORDER BY papers DESC',
};
const cell = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export default {
  mount(ctx) {
    const ta = h('textarea', { class: 'textarea', spellcheck: 'false', placeholder: 'MATCH (p:Paper) RETURN p.title, p.year LIMIT 10' });
    ta.value = EXAMPLES['Papers by author'];
    const out = h('div');
    const run = async () => {
      out.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
      try {
        const r = await api('/api/query', { method: 'POST', body: { cypher: ta.value } });
        out.replaceChildren(
          h('div', { class: 'results' }, h('table', null,
            h('thead', null, h('tr', null, r.columns.map((c) => h('th', null, c)))),
            h('tbody', null, r.rows.map((row) => h('tr', null, r.columns.map((c) => h('td', null, cell(row[c])))))))),
          h('p', { class: 'muted', style: { fontSize: '13px' } }, `${r.count} row${r.count === 1 ? '' : 's'}${r.truncated ? ` (showing first ${r.rows.length})` : ''}`));
      } catch (e) { out.replaceChildren(h('div', { class: 'alert' }, e.message)); }
    };
    const schemaBox = h('div');
    const showSchema = async () => {
      if (schemaBox.firstChild) return schemaBox.replaceChildren();
      try { schemaBox.replaceChildren(h('pre', { class: 'json' }, JSON.stringify(await api('/api/query/schema'), null, 2))); }
      catch (e) { schemaBox.replaceChildren(h('div', { class: 'alert' }, e.message)); }
    };
    ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
    const examples = h('select', { class: 'select', onchange: (e) => { if (e.target.value) ta.value = EXAMPLES[e.target.value]; e.target.value = ''; } },
      h('option', { value: '' }, 'Examples…'), Object.keys(EXAMPLES).map((k) => h('option', { value: k }, k)));
    ctx.el.replaceChildren(h('div', { class: 'console' },
      h('h1', { class: 'page-title', style: { fontSize: '32px' } }, 'Query'),
      h('p', { class: 'lead' }, 'Read-only Cypher. One statement, no procedure calls, at most 500 rows. The CLI and Claude use the same endpoint.'),
      h('div', { style: { marginTop: '18px' } }, ta),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', onclick: run }, 'Run (Ctrl/Cmd+Enter)'), examples,
        h('button', { class: 'btn btn-ghost', onclick: showSchema }, 'Graph schema')),
      schemaBox, out));
  },
};
