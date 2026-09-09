import { publicJobView, readSavedJobs, writeSavedJobs, savedJobsKey } from './job-workspace.mjs';

const search = document.querySelector('#search');
const source = document.querySelector('#source');
const list = document.querySelector('#jobs');
const count = document.querySelector('#count');
const more = document.querySelector('#more');
const refresh = document.querySelector('#refresh');
let jobs = [];
let limit = 50;
let saved = new Set();
let savedOnly = false;
const posted = document.querySelector('#posted');
const sort = document.querySelector('#sort');
const storageError = document.querySelector('#storage-error');
const initial = new URL(location.href).searchParams;
search.value = initial.get('q') || '';
posted.value = ['1', '3', '7', '30'].includes(initial.get('days')) ? initial.get('days') : '';
sort.value = ['newest', 'company'].includes(initial.get('sort')) ? initial.get('sort') : 'snapshot';
savedOnly = initial.get('view') === 'saved';
try {
  saved = readSavedJobs(localStorage);
} catch {
  storageError.hidden = false;
}

function syncUrl() {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries({
    q: search.value,
    source: source.value,
    days: posted.value,
    sort: sort.value === 'snapshot' ? '' : sort.value,
    view: savedOnly ? 'saved' : '',
  })) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  history.replaceState(null, '', url);
}

function persistSaved() {
  try {
    writeSavedJobs(localStorage, saved);
    storageError.hidden = true;
  } catch {
    storageError.hidden = false;
  }
}

function validJobs(value) {
  if (!Array.isArray(value)) throw new Error('Invalid snapshot');
  return value.filter((job) => {
    if (
      !job ||
      !['title', 'company', 'location', 'source', 'url'].every(
        (key) => typeof job[key] === 'string',
      )
    )
      return false;
    try {
      const url = new URL(job.url);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  });
}

function render() {
  const matches = publicJobView(jobs, {
    query: search.value,
    source: source.value,
    days: Number(posted.value),
    sort: sort.value,
    savedOnly,
    saved,
  });
  document.querySelector('#all-jobs').setAttribute('aria-pressed', String(!savedOnly));
  document.querySelector('#saved-jobs').setAttribute('aria-pressed', String(savedOnly));
  document.querySelector('#saved-count').textContent = String(saved.size);
  document.querySelector('#jobs-title').textContent = savedOnly ? 'Saved jobs' : 'Latest jobs';
  const available = new Set(jobs.map((job) => job.url));
  const missing = [...saved].filter((url) => !available.has(url)).length;
  document.querySelector('#saved-unavailable').hidden = !savedOnly || !missing;
  document.querySelector('#saved-unavailable').textContent =
    `${missing} saved posting${missing === 1 ? '' : 's'} no longer in this snapshot.`;
  document.querySelector('#clear-saved').hidden = !savedOnly || !saved.size;
  document.querySelector('#empty').textContent = savedOnly
    ? 'No saved jobs match these filters.'
    : 'No jobs match these filters.';
  list.replaceChildren();
  for (const job of matches.slice(0, limit)) {
    const item = document.createElement('li');
    const content = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = job.title;
    const company = document.createElement('p');
    company.className = 'company';
    company.textContent = job.company;
    const details = document.createElement('p');
    details.className = 'details';
    const date = job.postedAt ? new Date(job.postedAt) : null;
    details.textContent = [
      job.location,
      job.source,
      date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : '',
    ]
      .filter(Boolean)
      .join(' / ');
    const link = document.createElement('a');
    link.className = 'posting';
    const url = new URL(job.url);
    if (url.protocol !== 'https:') continue;
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open posting';
    link.setAttribute('aria-label', `Open ${job.title} at ${job.company}`);
    content.append(title, company, details);
    const actions = document.createElement('div');
    actions.className = 'job-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'icon-button save-job';
    save.setAttribute('aria-label', `Save ${job.title} at ${job.company}`);
    save.setAttribute('aria-pressed', String(saved.has(job.url)));
    save.title = saved.has(job.url) ? 'Remove saved job' : 'Save job';
    const icon = document.createElement('img');
    icon.className = 'nav-icon';
    icon.src = saved.has(job.url) ? './icon-bookmark-check.svg' : './icon-bookmark.svg';
    icon.alt = '';
    icon.width = 18;
    icon.height = 18;
    save.append(icon);
    save.addEventListener('click', () => {
      if (saved.has(job.url)) saved.delete(job.url);
      else saved.add(job.url);
      persistSaved();
      const rowIndex = [...list.children].indexOf(item);
      render();
      const buttons = list.querySelectorAll('.save-job');
      (
        buttons[Math.min(rowIndex, buttons.length - 1)] || document.querySelector('#saved-jobs')
      ).focus({ preventScroll: true });
    });
    actions.append(save, link);
    item.append(content, actions);
    list.append(item);
  }
  count.textContent = `${matches.length.toLocaleString()} jobs${matches.length ? ` / showing ${Math.min(limit, matches.length)}` : ' found'}`;
  more.hidden = matches.length <= limit;
  document.querySelector('#empty').hidden = matches.length !== 0;
}

async function load() {
  if (refresh.disabled) return;
  refresh.disabled = true;
  document.querySelector('#error').hidden = true;
  try {
    const response = await fetch('./jobs.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Snapshot unavailable');
    const data = await response.json();
    jobs = validJobs(data.jobs);
    const selection = source.value || initial.get('source') || '';
    source.replaceChildren(new Option('All sources', ''));
    for (const name of [...new Set(jobs.map((job) => job.source))].sort())
      source.add(new Option(name, name));
    source.value = [...source.options].some((option) => option.value === selection)
      ? selection
      : '';
    initial.delete('source');
    document.querySelector('#updated').textContent =
      `Updated ${new Date(data.updatedAt).toLocaleString()}`;
    render();
  } catch {
    document.querySelector('#error').hidden = false;
    count.textContent = jobs.length ? count.textContent : 'No snapshot loaded';
  } finally {
    refresh.disabled = false;
  }
}
search.addEventListener('input', () => {
  limit = 50;
  syncUrl();
  render();
});
for (const control of [source, posted, sort])
  control.addEventListener('change', () => {
    limit = 50;
    syncUrl();
    render();
  });
for (const [id, isSaved] of [
  ['all-jobs', false],
  ['saved-jobs', true],
])
  document.querySelector(`#${id}`).addEventListener('click', () => {
    savedOnly = isSaved;
    limit = 50;
    syncUrl();
    render();
  });
document.querySelector('#clear-filters').addEventListener('click', () => {
  search.value = '';
  source.value = '';
  posted.value = '';
  sort.value = 'snapshot';
  limit = 50;
  syncUrl();
  render();
});
document
  .querySelector('#clear-saved')
  .addEventListener('click', () => document.querySelector('#clear-dialog').showModal());
document
  .querySelector('#cancel-clear')
  .addEventListener('click', () => document.querySelector('#clear-dialog').close());
document.querySelector('#confirm-clear').addEventListener('click', () => {
  saved.clear();
  persistSaved();
  document.querySelector('#clear-dialog').close();
  render();
  document.querySelector('#saved-jobs').focus();
});
window.addEventListener('storage', (event) => {
  if (event.key !== savedJobsKey && event.key !== null) return;
  try {
    saved = readSavedJobs(localStorage);
    render();
  } catch {
    storageError.hidden = false;
  }
});
more.addEventListener('click', () => {
  limit += 50;
  render();
});
refresh.addEventListener('click', load);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void load();
});
void load();
