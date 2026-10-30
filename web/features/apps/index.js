// Lists the apps found in web/apps/*/app.json (each app is a folder: app.json + app.js, loaded by the shell).
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'apps');

function load() {
  return fs.readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory())
    .map((d) => path.join(DIR, d.name, 'app.json')).filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

module.exports = {
  name: 'apps',
  mount(app) {
    app.get('/api/apps', (_req, res) => res.json({ apps: load() }));
  },
};
