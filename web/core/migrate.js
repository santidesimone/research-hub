// Graph migrations. Files in web/migrations/NNN_name.js export { id, description, up(db) }.
// Applied ids are recorded on a (:SchemaMeta {id:'graph'}) node, so each runs once. Migrations must be idempotent
// (a crash between `up` and the record would re-run it). `db` has run(query, params) as an auto-commit write.
const fs = require('fs');
const path = require('path');
const { exec } = require('./db');

const DIR = path.join(__dirname, '..', 'migrations');

// Core migrations (NNN_name.js) run first; then each feature's own (features/<dir>/migrations/<feature>_NNN_name.js).
function scan(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^[a-z0-9]*_?\d+_.+\.js$/.test(f)).sort().map((f) => require(path.join(dir, f)));
}

function available() {
  const features = path.join(__dirname, '..', 'features');
  const own = fs.readdirSync(features).sort().flatMap((d) => scan(path.join(features, d, 'migrations')));
  return [...scan(DIR), ...own];
}

async function applied() {
  const rows = await exec("MERGE (m:SchemaMeta {id:'graph'}) ON CREATE SET m.applied = [] RETURN m.applied AS applied");
  return rows[0].applied;
}

async function run() {
  const done = new Set(await applied());
  const ran = [];
  for (const m of available()) {
    if (done.has(m.id)) continue;
    await m.up({ run: exec });
    await exec("MATCH (m:SchemaMeta {id:'graph'}) SET m.applied = m.applied + $id, m.updated_at = datetime()", { id: m.id });
    ran.push(m.id);
    console.log(`migration applied: ${m.id} (${m.description})`);
  }
  return ran;
}

module.exports = { run, applied, available };
