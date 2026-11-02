// Create/edit forms generated from the schema: one widget per field type. Saving an edit sends only the changed fields,
// so only those become {by: owner, status: reviewed}.
import { h, api, toast } from '../../shell/ui.js';
import { fieldGroups, fromForm, toForm, changedFields, createFields, noun } from './model.js';
import { tierBadge, provBadge } from './view.js';

const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------------------------------------------------------------- widgets: each returns { el, get() } */

function scalarInput(type, value, attrs = {}) {
  if (type === 'longtext' || type === 'markdown') return h('textarea', { class: 'textarea prose-input', rows: type === 'markdown' ? 8 : 3, ...attrs }, value ?? '');
  if (type === 'boolean') return h('input', { type: 'checkbox', checked: value === true, ...attrs });
  const t = type === 'integer' ? 'number' : type === 'url' ? 'url' : 'text';
  return h('input', { class: 'input', type: t, value: value ?? '', placeholder: type === 'date' ? 'YYYY, YYYY-MM or YYYY-MM-DD' : '', ...attrs });
}
const readScalar = (el) => (el.type === 'checkbox' ? el.checked : el.value);

function enumWidget(spec, value) {
  const sel = h('select', { class: 'select' }, h('option', { value: '' }, '—'),
    spec.enum.map((v) => h('option', { value: v, selected: v === value }, v.replace(/_/g, ' '))));
  if (value && !spec.enum.includes(value)) sel.append(h('option', { value, selected: true }, `${value} (not in the schema)`));
  return { el: sel, get: () => sel.value };
}

function listWidget(make, values, addLabel = 'Add') {
  const rows = h('div', { class: 'listedit' });
  const items = [];
  const add = (v) => {
    const w = make(v);
    const row = h('div', { class: 'listedit-row' }, w.el, h('button', { type: 'button', class: 'iconbtn small', 'aria-label': 'Remove', onclick: () => { row.remove(); items.splice(items.indexOf(w), 1); } }, '×'));
    items.push(w); rows.append(row);
  };
  (values || []).forEach(add);
  const el = h('div', null, rows, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => add(undefined) }, '+ ' + addLabel));
  return { el, get: () => items.map((w) => w.get()) };
}

function objectWidget(spec, value) {
  const parts = Object.entries(spec.props || {}).map(([k, t]) => {
    const input = scalarInput(t, value ? value[k] : '', { 'aria-label': k, placeholder: k.replace(/_/g, ' ') });
    return { k, input };
  });
  const el = h('div', { class: 'objedit' }, parts.map(({ k, input }) => h('label', { class: 'objpart' }, h('span', { class: 'faint small' }, k.replace(/_/g, ' ')), input)));
  return { el, get: () => Object.fromEntries(parts.map(({ k, input }) => [k, readScalar(input)])) };
}

// Type-ahead picker. search(q) -> [{key, name, hint}]. allowNew: typed names are accepted (vocabulary is matched server-side).
export function picker({ values = [], multi = true, search, allowNew = true, placeholder = 'Type to search', onChange }) {
  let chosen = values.filter((x) => x && (x.key || x.name));
  const chips = h('span', { class: 'chips inline' });
  const input = h('input', { class: 'input', type: 'text', placeholder, autocomplete: 'off' });
  const list = h('ul', { class: 'suggest hidden', role: 'listbox' });
  const draw = () => {
    chips.replaceChildren(...chosen.map((x, i) => h('span', { class: 'chip static' }, x.name || x.key, x.key ? null : h('span', { class: 'faint small' }, ' new'),
      h('button', { type: 'button', class: 'chip-x', 'aria-label': 'Remove ' + (x.name || x.key), onclick: () => { chosen.splice(i, 1); draw(); if (onChange) onChange(chosen); } }, '×'))));
    input.classList.toggle('hidden', !multi && chosen.length > 0);
  };
  const pick = (x) => { if (!chosen.some((c) => (c.key && c.key === x.key) || (!c.key && c.name === x.name))) chosen = multi ? [...chosen, x] : [x]; input.value = ''; list.classList.add('hidden'); draw(); if (onChange) onChange(chosen); };
  const show = (rows) => {
    list.replaceChildren(...rows.map((r) => h('li', null, h('button', { type: 'button', onclick: () => pick({ key: r.key, name: r.name }) }, r.name, r.hint && h('span', { class: 'faint small' }, ' ' + r.hint)))));
    list.classList.toggle('hidden', !rows.length);
  };
  const lookup = debounce(async () => {
    const q = input.value.trim();
    try { show(await search(q)); } catch (e) { show([]); }
  });
  input.addEventListener('input', lookup);
  input.addEventListener('focus', lookup);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const q = input.value.trim(); if (q && allowNew) pick({ key: null, name: q }); }
    if (e.key === 'Escape') list.classList.add('hidden');
  });
  input.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 150));
  draw();
  return { el: h('div', { class: 'picker' }, chips, input, list), get: () => chosen };
}

export const vocabSearch = (kind) => async (q) => (await api(`/api/vocab?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(q)}`)).items
  .map((x) => ({ key: x.key, name: x.name, hint: x.aliases && x.aliases.length ? x.aliases.slice(0, 2).join(', ') : '' }));
export const itemSearch = (collections) => async (q) => {
  const out = [];
  for (const c of collections) {
    const res = await api(`/api/items?collection=${c.name}&limit=8${q ? '&q=' + encodeURIComponent(q) : ''}`);
    out.push(...res.items.map((x) => ({ key: x.key, name: x.title || x.key, hint: c.label })));
  }
  return out;
};

function widget(spec, value, ctx) {
  const v = toForm(spec, value);
  if (spec.type === 'ref') {
    const vocabRef = ctx.entities.some((e) => e.label === spec.ref);
    const targets = ctx.collections.filter((c) => c.label === spec.ref);
    return picker({ values: v, multi: Boolean(spec.list), allowNew: vocabRef, search: vocabRef ? vocabSearch(spec.ref) : itemSearch(targets),
      placeholder: vocabRef ? `Type a ${spec.ref.toLowerCase()} name` : `Search ${spec.ref.toLowerCase()}s` });
  }
  if (spec.type === 'enum' && !spec.list) return enumWidget(spec, v);
  if (spec.type === 'object') return spec.list ? listWidget((x) => objectWidget(spec, x), v, 'Add row') : objectWidget(spec, v);
  if (spec.list) return listWidget((x) => { const el = scalarInput(spec.type, x ?? ''); return { el, get: () => readScalar(el) }; }, v);
  const el = scalarInput(spec.type, v, spec.type === 'integer' ? { min: spec.min ?? null, max: spec.max ?? null } : {});
  return { el, get: () => readScalar(el) };
}

/* ---------------------------------------------------------------- the form */

// coll: schema collection; item: existing item or null (create). ctx: { collections, entities }. onDone(result)
export function itemForm(coll, item, ctx, { onDone, onCancel, focus } = {}) {
  const locked = new Set(item ? coll.locked || [] : []);
  const widgets = {};
  const form = h('form', { class: 'itemform', novalidate: true });
  const err = h('div', { class: 'alert hidden' });
  form.append(h('h2', null, `${item ? 'Edit' : 'New'} ${noun(coll.label)}`));
  if (coll.name === 'paper' && !item) form.append(h('p', { class: 'muted' }, 'Give a DOI and the hub fills title, authors, year and venue from Crossref; or give at least a title.'));
  for (const g of fieldGroups(coll)) {
    const sec = h('fieldset', { class: 'formgroup' }, h('legend', null, g.label));
    for (const f of g.fields) {
      const spec = coll.fields[f];
      if (!spec) continue;
      const value = item ? item.fields[f] : spec.default ?? null;
      const derivedTitle = f === 'title' && coll.title_from; // a question's or hypothesis's title comes from its text when left empty
      const head = h('div', { class: 'field-head' }, h('label', { class: 'field-name', for: `f-${f}` }, spec.label || f, spec.required && !derivedTitle && ' *'), tierBadge(spec.tier), item && provBadge(item.provenance[f]),
        derivedTitle && h('span', { class: 'faint small' }, `optional: taken from the ${(coll.fields[coll.title_from].label || coll.title_from).toLowerCase()}`));
      if (locked.has(f)) {
        sec.append(h('div', { class: 'field locked', 'data-field': f }, head, h('div', { class: 'faint small' }, 'Filled from the source; not editable here.')));
        continue;
      }
      const w = widget(spec, value, ctx);
      const first = w.el.matches('input,select,textarea') ? w.el : w.el.querySelector('input,select,textarea');
      if (first) first.id = `f-${f}`;
      widgets[f] = w;
      sec.append(h('div', { class: 'field', 'data-field': f }, head, spec.help && h('div', { class: 'faint small' }, spec.help), w.el));
    }
    if (sec.children.length > 1) form.append(sec);
  }
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, item ? 'Save changes' : 'Create');
  form.append(err, h('div', { class: 'actions sticky' }, save, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => onCancel && onCancel() }, 'Cancel')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    const values = Object.fromEntries(Object.entries(widgets).map(([f, w]) => [f, fromForm(coll.fields[f], w.get())]));
    try {
      let res;
      if (item) {
        const changed = changedFields(coll.fields, item.fields, values);
        if (!Object.keys(changed).length) { toast('Nothing changed'); onCancel && onCancel(); return; }
        res = await api('/api/items/' + encodeURIComponent(item.key), { method: 'PATCH', body: { fields: changed } });
      } else {
        const fields = createFields(coll.fields, values);
        res = await api('/api/items', { method: 'POST', body: { collection: coll.name, fields } });
      }
      // empty fields are visible on the page already; only surprises are worth a toast
      const notes = (res.warnings || []).filter((w) => !/is empty \(Core field\)$/.test(w));
      onDone && onDone(res);
      if (notes.length) toast(notes.slice(0, 2).join('; '));
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); err.scrollIntoView({ block: 'nearest' }); }
  });
  if (focus) setTimeout(() => { const el = form.querySelector(`[data-field="${focus}"]`); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('focus'); const i = el.querySelector('input,select,textarea'); if (i) i.focus(); } }, 0);
  return form;
}

// "Add link" editor for an item: relation, target (vocabulary by name, or another item), evidence, location, confidence.
