// Serves the single HTML page (the "shell") for every non-API URL under BASE, with the skin and base path filled in.
// Apps live in web/apps/<id>/, skins in web/skins/<id>/. Both are plain folders: add one and it is available.
const fs = require('fs');
const path = require('path');
const { BASE } = require('./env');

const WEB = path.join(__dirname, '..');
const TEMPLATE = path.join(WEB, 'public', 'index.html');
const SKINS = path.join(WEB, 'skins');

const skinNames = () => fs.readdirSync(SKINS, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(SKINS, d.name, 'skin.json'))).map((d) => d.name);

// -> { html, csp }: the page and the Content-Security-Policy extras this skin needs (extra font/style hosts).
function render(req, nonce) {
  const names = skinNames();
  const wanted = String(req.query.skin || process.env.HUB_SKIN || 'paper');
  const skin = names.includes(wanted) ? wanted : names[0];
  const meta = JSON.parse(fs.readFileSync(path.join(SKINS, skin, 'skin.json'), 'utf8'));
  const fonts = (meta.fonts || []).map((u) => `<link rel="stylesheet" href="${u}">`).join('\n');
  const hub = JSON.stringify({ base: BASE, skin, skins: names }).replace(/</g, '\\u003c');
  const html = fs.readFileSync(TEMPLATE, 'utf8')
    .replace(/\{\{BASE\}\}/g, BASE).replace(/\{\{SKIN\}\}/g, skin).replace(/\{\{NONCE\}\}/g, nonce)
    .replace('{{FONTS}}', () => fonts).replace('{{HUB}}', () => hub);
  return { html, csp: meta.csp || {} };
}

module.exports = { render };
