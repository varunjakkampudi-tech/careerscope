// Shared behaviour for the home-page variants.
//
// Real data or nothing: it loads the published jobs.json so density, truncation
// and long-tail titles are judged against actual records rather than a dozen
// tidy samples. A failed fetch shows an error state — a variant that silently
// rendered an empty list would be flattering itself.

const PAGE = 60;

const state = {
  all: [],
  view: [],
  shown: 0,
  saved: new Set(),
  onlySaved: false,
  q: '',
  sources: new Set(),
};

const el = (id) => document.getElementById(id);
const list = el('list');

function age(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return { text: '', fresh: false, exact: '' };
  const days = Math.floor(ms / 86400000);
  const exact = new Date(iso).toISOString().slice(0, 10);
  if (days <= 0) return { text: 'today', fresh: true, exact };
  if (days === 1) return { text: 'yesterday', fresh: true, exact };
  if (days <= 3) return { text: `${days}d`, fresh: true, exact };
  // Between 4 and 29 days every row reads the same, so the column becomes noise.
  // Show age only where it discriminates: very fresh, or genuinely stale.
  if (days < 30) return { text: '', fresh: false, exact };
  return { text: `${Math.floor(days / 30)}mo`, fresh: false, stale: true, exact };
}

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

function announce(message) {
  const live = el('live');
  if (live) live.textContent = message;
}

function skeleton() {
  list.innerHTML = `<ul class="rows" aria-busy="true" aria-label="Loading jobs">${Array.from(
    { length: 14 },
    () => '<li class="sk"></li>',
  ).join('')}</ul>`;
}

function empty(kind) {
  const total = state.all.length.toLocaleString();
  const copy = {
    none: ['No jobs published yet', 'The next discovery run will fill this list.'],
    filtered: ['No jobs match these filters', `Clear the filters to see all ${total} roles.`],
    saved: ['Nothing saved yet', 'Use the save control on any row to keep it here.'],
    error: ['The job list could not be loaded', 'This page needs jobs.json to render.'],
  }[kind];
  list.innerHTML = `<div class="state" role="${kind === 'error' ? 'alert' : 'status'}"><b>${esc(copy[0])}</b>${esc(copy[1])}</div>`;
}

function rowHtml(j) {
  const a = age(j.postedAt);
  const on = state.saved.has(j.url);
  const when = a.text
    ? `<time class="age${a.fresh ? ' fresh' : ''}${a.stale ? ' stale' : ''}" datetime="${esc(a.exact)}">${esc(a.text)}</time>`
    : `<time class="age" datetime="${esc(a.exact)}"></time>`;
  return `<li class="row">
    <button class="star" type="button" aria-pressed="${on}" data-url="${esc(j.url)}">
      <span class="vh">Save ${esc(j.title)}</span><span aria-hidden="true">${on ? '★' : '☆'}</span>
    </button>
    <span class="t"><a href="${esc(j.url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(j.title)}<span class="vh"> (opens in a new tab)</span></a></span>
    <span class="c"><span class="vh">Company: </span>${esc(j.company)}</span>
    <span class="l"><span class="vh">Location: </span>${esc(j.location)}</span>
    <span class="s"><span class="vh">Source: </span>${esc(j.source)}</span>
    ${when}
    <span class="meta">${esc(j.company)} · ${esc(j.location)}${a.text ? ` · ${esc(a.text)}` : ''}</span>
  </li>`;
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  return state.all.filter((j) => {
    if (state.onlySaved && !state.saved.has(j.url)) return false;
    if (state.sources.size && !state.sources.has(j.source)) return false;
    if (!q) return true;
    return `${j.title} ${j.company}`.toLowerCase().includes(q);
  });
}

// Counts beside a filter are read as "this is what you will get", so they are
// computed against every other active filter rather than against the corpus.
function renderSources() {
  const box = el('sources');
  if (!box) return;
  const q = state.q.trim().toLowerCase();
  const pool = state.all.filter((j) => {
    if (state.onlySaved && !state.saved.has(j.url)) return false;
    if (!q) return true;
    return `${j.title} ${j.company}`.toLowerCase().includes(q);
  });
  const counts = new Map();
  for (const j of pool) counts.set(j.source, (counts.get(j.source) ?? 0) + 1);
  const names = [...new Set([...counts.keys(), ...state.sources])].sort(
    (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0),
  );
  box.innerHTML = names
    .slice(0, 8)
    .map((name) => {
      const on = state.sources.has(name);
      const n = counts.get(name) ?? 0;
      return `<button type="button" data-source="${esc(name)}" aria-pressed="${on}"><span>${esc(name)}</span><span class="n">${n.toLocaleString()}</span></button>`;
    })
    .join('');
}

function render({ reset = false, quiet = false } = {}) {
  if (reset) state.shown = 0;
  state.view = filtered();
  el('count').textContent = `${state.view.length.toLocaleString()} roles`;

  if (state.view.length === 0) {
    empty(state.onlySaved ? 'saved' : state.all.length ? 'filtered' : 'none');
    el('shown').textContent = '';
    el('more').hidden = true;
    renderSources();
    if (!quiet) announce('No jobs match these filters');
    return;
  }

  state.shown = Math.min(state.view.length, (state.shown || 0) + PAGE);
  list.innerHTML = `<ul class="rows">${state.view.slice(0, state.shown).map(rowHtml).join('')}</ul>`;
  el('shown').textContent =
    `${state.shown.toLocaleString()} of ${state.view.length.toLocaleString()}`;
  el('more').hidden = state.shown >= state.view.length;
  renderSources();
  if (!quiet) announce(`${state.view.length.toLocaleString()} roles match`);
}

// Toggling a save must not rebuild the list. The previous version re-rendered
// everything, which destroyed the focused element and dropped keyboard users
// back to the top of the page after every save.
list.addEventListener('click', (e) => {
  const button = e.target.closest('.star');
  if (!button) return;
  const url = button.dataset.url;
  const on = !state.saved.has(url);
  if (on) state.saved.add(url);
  else state.saved.delete(url);
  button.setAttribute('aria-pressed', String(on));
  button.querySelector('[aria-hidden]').textContent = on ? '★' : '☆';
  announce(on ? 'Saved' : 'Removed from saved');
  if (state.onlySaved) {
    const keep = state.shown;
    render({ reset: true, quiet: true });
    state.shown = keep;
  } else {
    renderSources();
  }
});

el('sources')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-source]');
  if (!b) return;
  const name = b.dataset.source;
  if (state.sources.has(name)) state.sources.delete(name);
  else state.sources.add(name);
  render({ reset: true });
});

let debounce;
el('q')?.addEventListener('input', (e) => {
  state.q = e.target.value;
  clearTimeout(debounce);
  debounce = setTimeout(() => render({ reset: true }), 120);
});
el('all')?.addEventListener('click', () => {
  state.onlySaved = false;
  el('all').setAttribute('aria-pressed', 'true');
  el('saved').setAttribute('aria-pressed', 'false');
  render({ reset: true });
});
el('saved')?.addEventListener('click', () => {
  state.onlySaved = true;
  el('saved').setAttribute('aria-pressed', 'true');
  el('all').setAttribute('aria-pressed', 'false');
  render({ reset: true });
});
el('clearf')?.addEventListener('click', () => {
  state.q = '';
  if (el('q')) el('q').value = '';
  state.onlySaved = false;
  state.sources.clear();
  el('all')?.setAttribute('aria-pressed', 'true');
  el('saved')?.setAttribute('aria-pressed', 'false');
  render({ reset: true });
});
el('more')?.addEventListener('click', () => {
  const first = state.shown;
  render();
  list.querySelectorAll('.row')[first]?.querySelector('a')?.focus();
});
el('theme')?.addEventListener('click', () => {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  document.documentElement.setAttribute('data-theme', light ? 'dark' : 'light');
  el('theme').setAttribute('aria-label', `Theme: ${light ? 'dark' : 'light'}`);
});

skeleton();
try {
  const res = await fetch('../../mobile-site/jobs.json');
  if (!res.ok) throw new Error(String(res.status));
  const data = await res.json();
  const rows = Array.isArray(data) ? data : (data.jobs ?? data.items ?? []);
  if (!Array.isArray(rows)) throw new Error('unexpected shape');
  // The page says "newest first". That has to be true, so sort rather than
  // trust whatever order the published file happens to ship in.
  state.all = rows
    .slice()
    .sort((a, b) => (Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0));
  render({ reset: true, quiet: true });
} catch {
  empty('error');
}
