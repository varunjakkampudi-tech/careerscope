// Progressive enhancement for the Refined Dark jobs page.
//
// The first page of rows is already in the HTML, so this never blanks the list
// to fetch. It layers search, source filtering, saved state and Load more on
// top of markup that already works without it.

const PAGE = 20;
const state = { all: [], shown: PAGE, saved: new Set(), onlySaved: false, q: '', source: '' };

const el = (id) => document.getElementById(id);
const list = el('list');

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const fmt = (n) => n.toLocaleString('en-US');

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

const announce = (m) => {
  el('live').textContent = m;
};

const icon = (name, size = 20) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#${name}"></use></svg>`;

function rowHtml(j) {
  const on = state.saved.has(j.url);
  return `<li class="row">
    <span class="cell title"><a class="job" href="${esc(j.url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(j.title)}<span class="vh"> — opens in a new tab</span></a></span>
    <span class="cell company"><span class="vh">Company: </span>${esc(j.company)}</span>
    <span class="cell location"><span class="vh">Location: </span>${esc(j.location)}</span>
    <span class="cell source"><span class="vh">Source: </span>${esc(j.source)}</span>
    <time class="cell posted" datetime="${esc(new Date(j.postedAt).toISOString())}">${esc(ago(j.postedAt))}</time>
    <span class="cell meta">${esc(j.company)} · ${esc(j.location)} · ${esc(ago(j.postedAt))}</span>
    <span class="cell act"><button class="save" type="button" aria-pressed="${on}" data-url="${esc(j.url)}"><span class="vh">Save ${esc(j.title)}</span>${icon(on ? 'icon-save-filled' : 'icon-save-outline')}</button></span>
  </li>`;
}

function skeleton(n = 8) {
  list.innerHTML = `<ul class="rows" aria-busy="true" aria-label="Loading jobs">${Array.from(
    { length: n },
    () =>
      '<li class="row"><span class="cell"><span class="sk-line" style="width:min(70%,280px)"></span></span><span class="cell"><span class="sk-line" style="width:70%"></span></span><span class="cell"><span class="sk-line" style="width:70%"></span></span><span class="cell"><span class="sk-line" style="width:60%"></span></span><span class="cell"><span class="sk-line" style="width:70%"></span></span><span class="cell"></span></li>',
  ).join('')}</ul>`;
}

function stateBlock(kind) {
  const art = {
    empty: `<svg width="96" height="96" viewBox="0 0 96 96" fill="none" aria-hidden="true"><path d="M29 14h25l13 13v55H29V14Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><path d="M54 14v15h13" stroke="currentColor" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><path d="M39 42h18M39 51h18M39 60h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"/><circle cx="65" cy="68" r="10" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/><path d="m72 75 8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`,
    error: `<svg width="96" height="96" viewBox="0 0 96 96" fill="none" aria-hidden="true"><path d="M48 13 82 78H14L48 13Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><path d="M48 34v22" stroke="currentColor" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"/><circle cx="48" cy="64" r="1.8" fill="currentColor"/><path d="M28 70c5.5 6 12.5 9 20 9 11 0 20.5-5.5 26-14" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".45" vector-effect="non-scaling-stroke"/></svg>`,
  };
  const copy = {
    none: ['No jobs published yet.', 'Check back later for newly published jobs.', 'empty', false],
    filtered: [
      'No jobs match your filters.',
      'Try adjusting your filters or clear them to see all jobs.',
      'empty',
      true,
    ],
    saved: [
      'Nothing saved yet.',
      'Use the save control on any row to keep it here.',
      'empty',
      true,
    ],
    error: ["Couldn't load the public job list.", 'Please try again.', 'error', false],
  }[kind];
  return `<section class="state${kind === 'error' ? ' state--error' : ''}"${kind === 'error' ? ' role="alert"' : ''} aria-labelledby="state-title">
    ${art[copy[2]]}
    <h2 id="state-title">${copy[0]}</h2>
    <p>${copy[1]}</p>
    ${copy[3] ? '<button class="control" type="button" data-clear>Clear filters</button>' : ''}
    ${kind === 'error' ? '<button class="control" type="button" data-retry>Try again</button>' : ''}
  </section>`;
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  return state.all.filter((j) => {
    if (state.onlySaved && !state.saved.has(j.url)) return false;
    if (state.source && j.source !== state.source) return false;
    if (!q) return true;
    return `${j.title} ${j.company} ${j.location}`.toLowerCase().includes(q);
  });
}

function render({ reset = false, quiet = false } = {}) {
  if (reset) state.shown = PAGE;
  const view = filtered();

  if (view.length === 0) {
    list.innerHTML = stateBlock(state.onlySaved ? 'saved' : state.all.length ? 'filtered' : 'none');
    el('shown').textContent = '';
    el('more').hidden = true;
    if (!quiet) announce('No jobs match your filters');
    return;
  }

  const rows = view.slice(0, Math.min(state.shown, view.length));
  list.innerHTML = `<ul class="rows">${rows.map(rowHtml).join('')}</ul>`;
  el('shown').textContent = `Showing 1–${fmt(rows.length)} of ${fmt(view.length)}`;
  el('more').hidden = rows.length >= view.length;
  if (!quiet) announce(`${fmt(view.length)} roles match`);
}

// Saving updates one button. Re-rendering the list would destroy focus and drop
// keyboard users back to the top after every save.
list.addEventListener('click', (e) => {
  const clear = e.target.closest('[data-clear]');
  if (clear) {
    resetFilters();
    return;
  }
  const retry = e.target.closest('[data-retry]');
  if (retry) {
    load();
    return;
  }
  const button = e.target.closest('.save');
  if (!button) return;
  const url = button.dataset.url;
  const on = !state.saved.has(url);
  if (on) state.saved.add(url);
  else state.saved.delete(url);
  button.setAttribute('aria-pressed', String(on));
  button.querySelector('use').setAttribute('href', on ? '#icon-save-filled' : '#icon-save-outline');
  announce(on ? 'Saved' : 'Removed from saved');
  if (state.onlySaved) render({ quiet: true });
});

function resetFilters() {
  state.q = '';
  state.source = '';
  state.onlySaved = false;
  el('q').value = '';
  el('source').value = '';
  el('all').setAttribute('aria-pressed', 'true');
  el('saved').setAttribute('aria-pressed', 'false');
  render({ reset: true });
}

let debounce;
el('q').addEventListener('input', (e) => {
  state.q = e.target.value;
  clearTimeout(debounce);
  debounce = setTimeout(() => render({ reset: true }), 120);
});
el('source').addEventListener('change', (e) => {
  state.source = e.target.value;
  render({ reset: true });
});
el('all').addEventListener('click', () => {
  state.onlySaved = false;
  el('all').setAttribute('aria-pressed', 'true');
  el('saved').setAttribute('aria-pressed', 'false');
  render({ reset: true });
});
el('saved').addEventListener('click', () => {
  state.onlySaved = true;
  el('saved').setAttribute('aria-pressed', 'true');
  el('all').setAttribute('aria-pressed', 'false');
  render({ reset: true });
});
el('clearf').addEventListener('click', resetFilters);
el('more').addEventListener('click', () => {
  const first = state.shown;
  state.shown += PAGE;
  render();
  list.querySelectorAll('.row')[first]?.querySelector('a')?.focus();
});
el('theme').addEventListener('click', () => {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  const next = light ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  el('theme').setAttribute('aria-label', `Theme: ${next}`);
  document.getElementById('theme-icon').setAttribute('href', light ? '#icon-moon' : '#icon-sun');
});

function fillSources() {
  const counts = new Map();
  for (const j of state.all) counts.set(j.source, (counts.get(j.source) ?? 0) + 1);
  const select = el('source');
  for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = `${name} (${fmt(n)})`;
    select.append(option);
  }
}

async function load() {
  skeleton();
  try {
    const res = await fetch('../../mobile-site/jobs.json');
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data.jobs ?? data.items ?? []);
    if (!Array.isArray(rows)) throw new Error('unexpected shape');
    state.all = rows
      .slice()
      .sort((a, b) => (Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0));
    el('total').textContent = fmt(state.all.length);
    if (!el('source').options.length || el('source').options.length === 1) fillSources();
    render({ reset: true, quiet: true });
  } catch {
    // The inlined first page stays useful, so only the enhanced view fails.
    list.innerHTML = stateBlock('error');
    el('more').hidden = true;
    el('shown').textContent = '';
  }
}

load();
