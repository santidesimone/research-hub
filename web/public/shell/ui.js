// Shared helpers for the shell and every app (apps receive these through ctx, or may import this file).
export const HUB = window.HUB;
export const BASE = HUB.base;
export const state = { owner: false, writes: false, apps: [], features: [], schema: null };

export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(c)); }
  return e;
}

const P = (d) => `<svg width="SIZE" height="SIZE" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  grid: P('<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>'),
  home: P('<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>'),
  library: P('<path d="M5 4v16M10 4v16"/><path d="M15 6l4 1-3.5 13-4-1z"/>'),
  terminal: P('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M13 15h4"/>'),
  search: P('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>'),
  sun: P('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: P('<path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z"/>'),
  pdf: P('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  link: P('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>'),
  lock: P('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  user: P('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-4 4-5.5 7-5.5s6 1.5 7 5.5"/>'),
  close: P('<path d="M6 6l12 12M18 6L6 18"/>'),
  graph: P('<circle cx="6" cy="7" r="2.3"/><circle cx="18" cy="7" r="2.3"/><circle cx="12" cy="18" r="2.3"/><path d="M8 7.5h8M7 9l4 7M17 9l-4 7"/>'),
  list: P('<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
  play: P('<path d="M7 5l12 7-12 7z"/>'),
};
export function icon(name, size = 18, cls = '') {
  return h('span', { class: 'icon ' + cls, html: (ICONS[name] || ICONS.grid).replace(/SIZE/g, size) });
}

export const url = (p) => BASE + p;
// A link that navigates inside the shell without a page load, and still works with middle-click.
export const link = (to, kids, cls = '') => h('a', { href: BASE + to, 'data-nav': to, class: cls }, kids);

export async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const init = { method, credentials: 'same-origin', headers: { 'X-Hub': '1', ...headers } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  else if (raw !== undefined) init.body = raw;
  const res = await fetch(BASE + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || `HTTP ${res.status}`); err.status = res.status; throw err; }
  return data;
}

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function toast(message, kind = '') {
  document.querySelectorAll('.toast').forEach((t) => t.remove()); // one at a time: the newest wins
  const el = h('div', { class: 'toast ' + kind }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = h('script', { src, 'data-src': src, onload: resolve, onerror: () => reject(new Error('could not load ' + src)) });
    document.head.append(s);
  });
}
