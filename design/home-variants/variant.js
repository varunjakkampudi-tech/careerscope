// Shared behaviour for the three home-page variants.
//
// Real data or nothing: it loads the published jobs.json so density, truncation
// and long-tail titles are judged against 2,529 actual records rather than a
// dozen tidy samples. If the fetch fails it shows an error state, because a
// variant that silently renders an empty list would flatter itself.

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
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (!Number.isFinite(days)) return { text: '—', fresh: false };
  if (days <= 0) return { text: 'today', fresh: true };
  if (days === 1) return { text: '1d', fresh: true };
  if (days < 30) return { text: `${days}d`, fresh: days <= 3 };
  return { text: `${Math.floor(days / 30)}mo`, fresh: false };
}

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

function skeleton() {
  list.innerHTML = Array.from({ length: 14 }, () => '<div class="sk"></div>').join('');
}

function empty(kind) {
  const copy = {
    none: ['No jobs published yet', 'The next discovery run will fill this list.'],
    filtered: ['No jobs match these filters', 'Clear the filters to see all 2,529 roles.'],
    saved: ['Nothing saved yet', 'Use the star on any row to keep it here.'],
    error: ['The job list could not be loaded', 'This page needs jobs.json to render.'],
  }[kind];
  list.innerHTML = `<div class="state"><b>${esc(copy[0])}</b>${esc(copy[1])}</div>`;
}

function render(reset = false) {
  if (reset) state.shown = 0;
  const q = state.q.trim().toLowerCase();
  state.view = state.all.filter((j) => {
    if (state.onlySaved && !state.saved.has(j.url)) return false;
    if (state.sources.size && !state.sources.has(j.source)) return false;
    if (!q) return true;
    return `${j.title} ${j.company}`.toLowerCase().includes(q);
  });

  el('count').textContent = `${state.view.length.toLocaleString()} roles`;

  if (state.view.length === 0) {
    empty(state.onlySaved ? 'saved' : state.all.length ? 'filtered' : 'none');
    el('shown').textContent = '';
    el('more').hidden = true;
    return;
  }

  state.shown = Math.min(state.view.length, state.shown + PAGE || PAGE);
  const rows = state.view.slice(0, state.shown);
  list.innerHTML = rows
    .map((j) => {
      const a = age(j.postedAt);
      const on = state.saved.has(j.url);
      return `<div class="row">
        <button class="star" aria-pressed="${on}" aria-label="${on ? 'Remove from saved' : 'Save'} ${esc(j.title)}" data-url="${esc(j.url)}">${on ? '★' : '☆'}</button>
        <span class="t"><a href="${esc(j.url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(j.title)}</a></span>
        <span class="c">${esc(j.company)}</span>
        <span class="l">${esc(j.location)}</span>
        <span class="s">${esc(j.source)}</span>
        <span class="age ${a.fresh ? 'fresh' : ''}">${esc(a.text)}</span>
        <span class="meta">${esc(j.company)} · ${esc(j.location)} · ${esc(a.text)}</span>
      </div>`;
    })
    .join('');

  el('shown').textContent =
    `${state.shown.toLocaleString()} of ${state.view.length.toLocaleString()}`;
  el('more').hidden = state.shown >= state.view.length;
}

list.addEventListener('click', (e) => {
  const b = e.target.closest('.star');
  if (!b) return;
  const url = b.dataset.url;
  if (state.saved.has(url)) state.saved.delete(url);
  else state.saved.add(url);
  const keep = state.shown;
  render(true);
  state.shown = keep;
  render();
});

el('q')?.addEventListener('input', (e) => {
  state.q = e.target.value;
  render(true);
});
el('all')?.addEventListener('click', () => {
  state.onlySaved = false;
  el('all').setAttribute('aria-pressed', 'true');
  el('saved').setAttribute('aria-pressed', 'false');
  render(true);
});
el('saved')?.addEventListener('click', () => {
  state.onlySaved = true;
  el('saved').setAttribute('aria-pressed', 'true');
  el('all').setAttribute('aria-pressed', 'false');
  render(true);
});
el('clearf')?.addEventListener('click', () => {
  state.q = '';
  el('q').value = '';
  state.onlySaved = false;
  state.sources.clear();
  document
    .querySelectorAll('button[data-source]')
    .forEach((b) => b.setAttribute('aria-pressed', 'false'));
  el('all').setAttribute('aria-pressed', 'true');
  el('saved').setAttribute('aria-pressed', 'false');
  render(true);
});
el('more')?.addEventListener('click', () => render());

// Variant C exposes source filtering in a sidebar; the others do not have one.
const sourcesBox = el('sources');
function renderSources() {
  if (!sourcesBox) return;
  const counts = new Map();
  for (const j of state.all) counts.set(j.source, (counts.get(j.source) ?? 0) + 1);
  sourcesBox.innerHTML = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(
      ([name, n]) =>
        `<button data-source="${esc(name)}" aria-pressed="false"><span>${esc(name)}</span><span>${n.toLocaleString()}</span></button>`,
    )
    .join('');
}
sourcesBox?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-source]');
  if (!b) return;
  const name = b.dataset.source;
  if (state.sources.has(name)) state.sources.delete(name);
  else state.sources.add(name);
  b.setAttribute('aria-pressed', String(state.sources.has(name)));
  render(true);
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
  state.all = Array.isArray(data) ? data : (data.jobs ?? data.items ?? []);
  if (!Array.isArray(state.all)) throw new Error('unexpected shape');
  renderSources();
  render(true);
} catch {
  empty('error');
}
