import { decryptSnapshot } from './snapshot-crypto.mjs';

const element = (id) => document.getElementById(id);
let snapshot = null;
let limit = 50;
let generation = 0;
let lastActivity = Date.now();
const compactFilters = window.matchMedia('(max-width: 680px)');
const syncFilters = () => {
  element('filter-panel').open = !compactFilters.matches;
};
syncFilters();
compactFilters.addEventListener('change', syncFilters);

function lock() {
  generation += 1;
  snapshot = null;
  element('rows').replaceChildren();
  element('sources').replaceChildren();
  for (const id of ['updated', 'profile', 'count']) element(id).textContent = '';
  element('status').replaceChildren(new Option('All statuses', ''));
  element('search').value = '';
  element('score').value = '0';
  element('passphrase').value = '';
  element('workspace').hidden = true;
  element('lock').hidden = true;
  element('locked').hidden = false;
  element('unlock').disabled = false;
  element('unlock').textContent = 'Unlock';
  element('unlock-form').setAttribute('aria-busy', 'false');
  element('passphrase').removeAttribute('aria-invalid');
  element('error').hidden = true;
  element('empty').hidden = true;
  element('passphrase').focus({ preventScroll: true });
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function cell(text, className = '') {
  const node = document.createElement('div');
  node.setAttribute('role', 'cell');
  node.className = className;
  node.textContent = text;
  return node;
}

function render() {
  if (!snapshot) return;
  const query = element('search').value.trim().toLowerCase();
  const sources = [...element('sources').querySelectorAll('input:checked')].map(
    (input) => input.value,
  );
  const minimum = Number(element('score').value);
  const status = element('status').value;
  const sort = element('sort').value;
  element('score-value').textContent = `${minimum}%`;
  const leads = snapshot.leads
    .filter(
      (lead) =>
        lead.score * 100 >= minimum &&
        (!status || lead.status === status) &&
        (!sources.length || sources.includes(lead.source)) &&
        `${lead.title} ${lead.company} ${lead.location}`.toLowerCase().includes(query),
    )
    .sort((first, second) =>
      sort === 'score'
        ? second.score - first.score
        : sort === 'postedAt'
          ? (second.postedAt ?? '').localeCompare(first.postedAt ?? '')
          : first[sort].localeCompare(second[sort]),
    );
  const rows = leads.slice(0, limit).map((lead) => {
    const row = document.createElement('div');
    row.setAttribute('role', 'row');
    const role = cell('');
    const link = safeLink(lead.url);
    const title = document.createElement(link ? 'a' : 'span');
    title.textContent = lead.title;
    title.className = 'role-link';
    if (link) {
      title.href = link;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
      title.referrerPolicy = 'no-referrer';
    }
    const company = document.createElement('p');
    company.className = 'details';
    company.textContent = `${lead.company} / ${lead.postedAt ? new Date(lead.postedAt).toLocaleDateString() : 'Date unavailable'}`;
    role.append(title, company);
    row.append(
      cell(`${Math.round(lead.score * 100)}%`, 'match'),
      role,
      cell(lead.location),
      cell(lead.source),
      cell(lead.status),
    );
    return row;
  });
  element('rows').replaceChildren(...rows);
  element('count').textContent = `${leads.length.toLocaleString()} leads / showing ${rows.length}`;
  element('more').hidden = limit >= leads.length;
  element('empty').hidden = leads.length !== 0;
}

element('unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const attempt = ++generation;
  let passphrase = element('passphrase').value;
  element('passphrase').value = '';
  element('unlock').disabled = true;
  element('unlock').textContent = 'Unlocking...';
  element('unlock-form').setAttribute('aria-busy', 'true');
  element('passphrase').removeAttribute('aria-invalid');
  element('error').hidden = true;
  try {
    const response = await fetch('./admin.enc.json', { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('unavailable');
    const decrypted = await decryptSnapshot(await response.json(), passphrase);
    if (attempt !== generation) return;
    if (
      decrypted.version !== 1 ||
      !Array.isArray(decrypted.leads) ||
      !decrypted.profile ||
      decrypted.leads.some(
        (lead) =>
          !['title', 'company', 'location', 'source', 'status'].every(
            (key) => typeof lead[key] === 'string',
          ) ||
          !Number.isFinite(lead.score) ||
          lead.score < 0 ||
          lead.score > 1 ||
          (lead.postedAt !== null && typeof lead.postedAt !== 'string'),
      )
    )
      throw new Error('invalid');
    snapshot = decrypted;
    limit = 50;
    lastActivity = Date.now();
    element('sources').replaceChildren(
      ...[...new Set(snapshot.leads.map((lead) => lead.source))].sort().map((source) => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = source;
        label.append(input, document.createTextNode(source));
        return label;
      }),
    );
    element('status').replaceChildren(
      new Option('All statuses', ''),
      ...[...new Set(snapshot.leads.map((lead) => lead.status))]
        .sort()
        .map((status) => new Option(status, status)),
    );
    element('updated').textContent = `Exported ${new Date(snapshot.updatedAt).toLocaleString()}`;
    element('profile').textContent =
      `Profile updated ${new Date(snapshot.profile.updatedAt).toLocaleString()} / Resume ${snapshot.profile.hasResume ? 'attached' : 'not attached'}`;
    element('locked').hidden = true;
    element('workspace').hidden = false;
    element('lock').hidden = false;
    render();
    element('leads-title').focus({ preventScroll: true });
  } catch {
    if (attempt !== generation) return;
    lock();
    element('error').textContent =
      'Could not unlock. Check your passphrase and that an encrypted snapshot has been published.';
    element('error').hidden = false;
    element('passphrase').setAttribute('aria-invalid', 'true');
    element('passphrase').focus({ preventScroll: true });
  } finally {
    passphrase = '';
    if (attempt === generation) {
      element('unlock').disabled = false;
      element('unlock').textContent = 'Unlock';
      element('unlock-form').setAttribute('aria-busy', 'false');
    }
  }
});
element('lock').addEventListener('click', lock);
element('more').addEventListener('click', () => {
  limit += 50;
  render();
});
for (const id of ['search', 'score', 'sources', 'status', 'sort'])
  element(id).addEventListener('input', () => {
    limit = 50;
    render();
  });
element('clear').addEventListener('click', () => {
  element('search').value = '';
  element('score').value = '0';
  element('status').value = '';
  element('sort').value = 'score';
  for (const input of element('sources').querySelectorAll('input')) input.checked = false;
  limit = 50;
  render();
});
for (const event of ['pointerdown', 'keydown', 'scroll'])
  document.addEventListener(
    event,
    () => {
      if (snapshot && Date.now() - lastActivity >= 300000) lock();
      lastActivity = Date.now();
    },
    { passive: true },
  );
setInterval(() => {
  if (snapshot && Date.now() - lastActivity >= 300000) lock();
}, 10000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastActivity >= 300000) lock();
});
window.addEventListener('pagehide', lock);
