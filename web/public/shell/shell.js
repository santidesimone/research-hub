// The shell: top bar with an app switcher, session (owner sign-in), theme, and path routing under BASE.
// Apps are loaded on demand from <BASE>/apps/<id>/app.js and receive a ctx object. They never touch the URL directly.
import { h, icon, api, state, BASE, toast, link } from './ui.js';

const root = document.getElementById('shell');
let mounted = null; // { id, mod, cleanup }
let menuOpen = false;

/* ---------------------------------------------------------------- routing */
function parseRoute() {
  const path = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : location.pathname;
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const def = state.apps.find((a) => a.default) || state.apps[0];
  return { app: parts[0] || (def && def.id), atRoot: !parts[0], rest: parts.slice(1), query: new URLSearchParams(location.search), path };
}
export function navigate(to, { replace = false } = {}) {
  const target = BASE + to;
  if (target === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', target);
  route();
}
addEventListener('popstate', () => route());
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[data-nav]');
  if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  e.preventDefault();
  menuOpen = false;
  navigate(a.getAttribute('data-nav'));
});
document.addEventListener('click', (e) => { if (menuOpen && !e.target.closest('.menu, #menubtn')) { menuOpen = false; renderTopbar(); } });

/* ---------------------------------------------------------------- theme + session */
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('hub-theme', t); } catch { /* private mode */ }
  document.dispatchEvent(new CustomEvent('hub:theme'));
  renderTopbar();
}
const theme = () => document.documentElement.getAttribute('data-theme');

async function refreshSession() {
  const me = await api('/api/me');
  state.owner = me.owner; state.writes = me.writes; state.publicAccess = Boolean(me.public_access);
  const schema = await api('/api/schema');
  state.schema = schema; state.features = schema.features || [];
}

// The owner-token form, used by the sign-in dialog and by the login page at the root. onCancel: a Cancel button.
function signInForm({ title, onDone, onCancel }) {
  const input = h('input', { class: 'input', type: 'password', placeholder: 'Owner token', autocomplete: 'current-password', autofocus: true });
  const err = h('div', { class: 'alert hidden', style: { marginTop: '12px' } });
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: { token: input.value } });
      await refreshSession(); onDone();
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
  };
  const form = h('form', { class: 'modal', onsubmit: submit },
    h('h2', null, title),
    h('p', { class: 'muted', style: { margin: '0 0 16px' } }, 'Enter the owner token to open your private library.'),
    input, err,
    h('div', { class: 'actions', style: { justifyContent: 'flex-end' } },
      onCancel && h('button', { type: 'button', class: 'btn btn-ghost', onclick: onCancel }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Sign in')));
  return { form, input };
}
function signInDialog() {
  const close = () => back.remove();
  const { form, input } = signInForm({ title: 'Sign in', onDone: () => { close(); renderTopbar(); route(true); }, onCancel: close });
  const back = h('div', { class: 'backdrop', onclick: (e) => e.target === back && close() }, form);
  document.body.append(back);
  input.focus();
}
// Not signed in: the login page, at the root, and on every page while the server has no public access (PUBLIC_ACCESS).
// With public access on, the public library stays at /library for anyone.
const loginOnly = (r) => !state.owner && (r.atRoot || !state.publicAccess);
function loginPage() {
  unmount();
  main.className = 'main';
  const { form, input } = signInForm({ title: 'Research Hub', onDone: () => (parseRoute().atRoot ? navigate('/library', { replace: true }) : (renderTopbar(), route(true))) });
  form.classList.add('login');
  main.replaceChildren(h('div', { class: 'page' }, form));
  input.focus();
}
async function signOut() { await api('/api/logout', { method: 'POST' }); await refreshSession(); renderTopbar(); route(true); }

/* ---------------------------------------------------------------- chrome */
let topbar, main;
function renderTopbar() {
  const r = parseRoute();
  const current = state.apps.find((a) => a.id === r.app);
  const login = loginOnly(r); // the page is the sign-in form: no app menu, no second Sign in button
  const bar = h('header', { class: 'topbar' },
    !login && h('button', { id: 'menubtn', class: 'iconbtn' + (menuOpen ? ' on' : ''), 'aria-label': 'Apps', onclick: () => { menuOpen = !menuOpen; renderTopbar(); } }, icon('grid', 20)),
    h('a', { class: 'brand', href: BASE + '/', 'data-nav': '/' }, 'Research Hub'),
    current && !current.default && h('span', { class: 'crumb' }, current.title),
    h('div', { class: 'spacer' }),
    state.owner
      ? [h('span', { class: 'badge ok' }, 'Owner'), h('button', { class: 'btn btn-ghost btn-sm', onclick: signOut }, 'Sign out')]
      : !login && h('button', { class: 'btn btn-sm', onclick: signInDialog }, icon('lock', 15), 'Sign in'),
    h('button', { class: 'iconbtn', 'aria-label': 'Toggle theme', onclick: () => setTheme(theme() === 'dark' ? 'light' : 'dark') }, icon(theme() === 'dark' ? 'sun' : 'moon', 18)));
  if (menuOpen && !login) {
    bar.append(h('nav', { class: 'menu' },
      state.apps.map((a) => {
        const locked = a.auth === 'owner' && !state.owner;
        return link(a.default ? '/' : '/' + a.id, [
          h('span', { class: 'tile' }, icon(a.icon || 'grid', 18)),
          h('span', null, h('strong', null, a.title, locked && ' ', locked && icon('lock', 12)), h('small', null, a.description || ''))], 'menu-item' + (a.id === r.app ? ' on' : ''));
      })));
  }
  topbar.replaceWith(bar); topbar = bar;
}

/* ---------------------------------------------------------------- apps */
function makeCtx(el, r) {
  return { el, route: r, state, navigate, api, h, icon, toast, link, base: BASE, signIn: signInDialog, refreshSession };
}
async function route(force = false) {
  renderTopbar();
  const r = parseRoute();
  if (loginOnly(r)) { loginPage(); return; }
  const app = state.apps.find((a) => a.id === r.app);
  if (!app) { main.className = 'main'; main.replaceChildren(h('div', { class: 'empty' }, 'No such page.')); return; }
  if (app.auth === 'owner' && !state.owner) {
    unmount();
    main.className = 'main';
    main.replaceChildren(h('div', { class: 'page' }, h('h1', { class: 'page-title' }, app.title),
      h('p', { class: 'lead' }, 'This app is private.'), h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: signInDialog }, 'Sign in'))));
    return;
  }
  if (!force && mounted && mounted.id === app.id && mounted.mod.onRoute) { mounted.mod.onRoute(makeCtx(main, r)); return; }
  unmount();
  main.className = 'main' + (app.fill ? ' fill' : '');
  main.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
  try {
    const mod = (await import(`${BASE}/apps/${app.id}/app.js`)).default;
    main.replaceChildren();
    const cleanup = await mod.mount(makeCtx(main, r));
    mounted = { id: app.id, mod, cleanup };
  } catch (e) {
    console.error(e);
    main.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'alert' }, 'Could not load this app: ' + e.message)));
  }
}
function unmount() {
  if (mounted && typeof mounted.cleanup === 'function') { try { mounted.cleanup(); } catch { /* ignore */ } }
  mounted = null;
}

/* ---------------------------------------------------------------- boot */
(async function boot() {
  topbar = h('header', { class: 'topbar' });
  main = h('main', { class: 'main' });
  root.replaceChildren(topbar, main);
  try {
    state.apps = (await api('/api/apps')).apps;
    await refreshSession();
  } catch (e) {
    main.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'alert' }, 'Could not reach the server: ' + e.message)));
    return;
  }
  document.addEventListener('hub:theme', () => { if (mounted && mounted.mod.onTheme) mounted.mod.onTheme(); });
  route();
})();
