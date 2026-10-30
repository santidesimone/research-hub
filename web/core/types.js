// Type registry. Every type in schema.json is available; a feature may supply its own module at features/<dir>/type.js
// ({ name, label, prepare?(body), parse(input), afterWrite?(key, input) }), otherwise the generic one is used.
const fs = require('fs');
const path = require('path');
const { schema } = require('./schema');
const { HttpError } = require('./errors');
const makeGeneric = require('./generic-type');

const registry = {};
// Custom modules: any features/<dir>/type.js, registered under the type name it exports.
const custom = {};
const featuresDir = path.join(__dirname, '..', 'features');
for (const dir of fs.readdirSync(featuresDir)) {
  const file = path.join(featuresDir, dir, 'type.js');
  if (fs.existsSync(file)) { const mod = require(file); custom[mod.name] = mod; }
}
for (const [name, def] of Object.entries(schema.types)) registry[name] = custom[name] || makeGeneric(name, def);

function get(name) {
  const t = registry[name];
  if (!t) throw new HttpError(404, `Unknown artifact type "${name}". Known: ${Object.keys(registry).join(', ')}`);
  return t;
}

module.exports = { get, names: () => Object.keys(registry) };
