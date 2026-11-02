// Settings (owner only): the publishing switches in core/publishing.js, and a one-click "make every item public/private".
import { h, api, toast } from '../../shell/ui.js';

const CHOICES = {
  default_visibility: {
    title: 'New items are',
    help: 'What a paper, note or other item gets when you do not choose. You can still set any single item to Public or Private.',
    options: [['public', 'Public'], ['private', 'Private']],
  },
  public_detail: {
    title: 'Visitors see',
    help: 'Basic: title, authors, year, venue, DOI, link and summary. Full: every field, including the abstract, Claude\'s analysis, note text and open file links (arXiv and the like). Copies in your Google Drive, Drive file ids and paths on your computer are never shown, and neither is your reading status.',
    options: [['basic', 'Basic details'], ['full', 'Everything']],
  },
};

export default {
  async mount(ctx) {
    const body = h('div', null, h('div', { class: 'center' }, h('span', { class: 'spinner' })));
    ctx.el.replaceChildren(h('div', { class: 'console' },
      h('h1', { class: 'page-title', style: { fontSize: '32px' } }, 'Settings'),
      h('p', { class: 'lead' }, 'What visitors see of your library. Changes apply right away.'),
      body));
    let current;
    try { current = await api('/api/settings/publishing'); } catch (e) { body.replaceChildren(h('div', { class: 'alert' }, e.message)); return; }
    if (!current.public_access) {
      body.replaceChildren(h('section', { class: 'card', style: { marginTop: '18px' } },
        h('div', { class: 'label' }, 'Public access is off'),
        h('p', { class: 'muted small', style: { marginTop: '10px' } }, 'Everything is behind your token: visitors only get the sign-in page, whatever an item\'s visibility says. To publish items, start the hub with PUBLIC_ACCESS=1; these settings then decide what visitors see.')));
      return;
    }

    const row = (name) => {
      const spec = CHOICES[name];
      const seg = h('div', { class: 'seg' });
      const draw = () => seg.replaceChildren(...spec.options.map(([value, label]) => h('button', {
        class: current[name] === value ? 'on' : '', 'aria-pressed': String(current[name] === value), 'data-setting': name, 'data-value': value,
        onclick: async () => {
          if (current[name] === value) return;
          try { current = await api('/api/settings/publishing', { method: 'PUT', body: { [name]: value } }); draw(); toast('Saved'); }
          catch (e) { toast(e.message, 'error'); }
        },
      }, label)));
      draw();
      return h('section', { class: 'card', style: { marginTop: '18px' } },
        h('div', { class: 'label' }, spec.title), h('div', { style: { margin: '10px 0' } }, seg), h('p', { class: 'muted small' }, spec.help));
    };

    const applyBtn = (visibility, label) => h('button', { class: 'btn btn-sm', 'data-apply': visibility, onclick: async (e) => {
      const btn = e.currentTarget;
      if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Click again to confirm'; return; }
      delete btn.dataset.armed; btn.textContent = label;
      try { const r = await api('/api/settings/publishing/apply', { method: 'POST', body: { visibility } }); toast(`${r.changed} item${r.changed === 1 ? '' : 's'} now ${visibility}`); }
      catch (err) { toast(err.message, 'error'); }
    } }, label);

    body.replaceChildren(row('default_visibility'), row('public_detail'),
      h('section', { class: 'card', style: { marginTop: '18px' } },
        h('div', { class: 'label' }, 'Items you already have'),
        h('div', { class: 'row-flex', style: { margin: '10px 0', gap: '8px' } }, applyBtn('public', 'Make all public'), applyBtn('private', 'Make all private')),
        h('p', { class: 'muted small' }, 'Sets every item at once. Case studies marked confidential stay hidden from visitors either way.')));
  },
};
