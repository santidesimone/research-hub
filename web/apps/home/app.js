// Home: the launcher. Lists every installed app (web/apps/*/app.json).
import { h, icon, link } from '../../shell/ui.js';

export default {
  mount(ctx) {
    const apps = ctx.state.apps.filter((a) => !a.default);
    ctx.el.replaceChildren(h('div', { class: 'page' },
      h('h1', { class: 'page-title' }, 'Research Hub'),
      h('p', { class: 'lead' }, ctx.state.owner
        ? 'Your research, as a graph. Pick an app to continue.'
        : 'A knowledge graph of papers, methods and notes. You are viewing the public side; sign in to open the private library.'),
      h('h2', { class: 'section-title' }, 'Apps'),
      h('div', { class: 'cards' }, apps.map((a) => {
        const locked = a.auth === 'owner' && !ctx.state.owner;
        return link('/' + a.id, [
          h('span', { class: 'tile big' }, icon(a.icon || 'grid', 22)),
          h('div', null, h('h3', null, a.title, locked && ' ', locked && icon('lock', 14, 'faint')), h('p', null, a.description || ''))], 'appcard');
      }))));
  },
};
