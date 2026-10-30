// Reads schema/schema.json: the single definition of the graph model (shared with the Python ingest).
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./env');

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'schema.json'), 'utf8'));

const SAFE = /^[A-Za-z][A-Za-z0-9_]*$/;
const relationTypes = new Set([...Object.values(schema.relations), 'AUTHORED_BY', 'CITES']);
const entityLabels = Object.keys(schema.entities);
const typeLabels = Object.values(schema.types).map((t) => t.label);

// Labels and relationship types cannot be Cypher parameters, so every one that reaches a query goes through here.
function safeLabel(label) {
  if (!SAFE.test(label) || ![...entityLabels, ...typeLabels].includes(label)) throw new Error(`label not in schema: ${label}`);
  return label;
}
function safeRel(rel) {
  if (!relationTypes.has(rel)) throw new Error(`relationship not in schema: ${rel}`);
  return rel;
}

// What the UI needs: labels, colours and which ones are drawn large.
function publicView() {
  const labels = [
    ...Object.entries(schema.types).map(([name, t]) => ({ name, label: t.label, color: t.color, big: Boolean(t.big) })),
    ...Object.entries(schema.entities).map(([label, e]) => ({ name: label.toLowerCase(), label, color: e.color, big: false })),
  ];
  return { version: schema.version, labels };
}

module.exports = { schema, safeLabel, safeRel, entityLabels, publicView };
