import { unlockSnapshot, restoreSnapshot } from './snapshot-crypto.mjs';
import { isRecentJob } from './job-workspace.mjs';

const element = (id) => document.getElementById(id);
let snapshot = null;
let limit = 50;
let generation = 0;
let lastActivity = Date.now();
let tabSession = null;
let view = 'leads';
const sessionKey = 'careerscope.admin.session';
const views = ['leads', 'search', 'applications', 'settings', 'profile'];
const applicationStatuses = ['applied', 'interview', 'interviewing', 'offer', 'rejected'];
function saveSession() {
  try {
    if (tabSession) sessionStorage.setItem(sessionKey, JSON.stringify(tabSession));
    else sessionStorage.removeItem(sessionKey);
  } catch {
    return;
  }
}
const compactFilters = window.matchMedia('(max-width: 1023px)');
const syncFilters = () => {
  element('filter-panel').open = !compactFilters.matches;
};
syncFilters();
compactFilters.addEventListener('change', syncFilters);

function lock({ preserveSession = false } = {}) {
  generation += 1;
  snapshot = null;
  if (!preserveSession) {
    tabSession = null;
    saveSession();
  }
  for (const id of ['settings-view', 'profile-view', 'private-nav']) element(id).hidden = true;
  for (const node of document.querySelectorAll('[data-private-value]')) node.textContent = '';
  element('rows').replaceChildren();
  element('sources').replaceChildren();
  for (const id of ['updated', 'profile', 'count', 'threshold-count']) element(id).textContent = '';
  element('leads-title').textContent = 'My leads';
  element('status').replaceChildren(new Option('All statuses', ''));
  element('search').value = '';
  element('score').value = '0';
  element('posted').value = '';
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

function selectView({ focus = false } = {}) {
  if (!snapshot) return;
  view = views.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'leads';
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  element('workspace').hidden = ['settings', 'profile'].includes(view);
  element('settings-view').hidden = view !== 'settings';
  element('profile-view').hidden = view !== 'profile';
  document.title = `${view.charAt(0).toUpperCase() + view.slice(1)} | CareerScope`;
  limit = 50;
  render();
  if (view === 'search') element('filter-panel').open = true;
  if (focus) {
    const target =
      view === 'search'
        ? 'search'
        : view === 'settings'
          ? 'settings-title'
          : view === 'profile'
            ? 'profile-title'
            : 'leads-title';
    element(target).focus({ preventScroll: true });
  }
}

function showSnapshot(decrypted) {
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
    throw new Error('Invalid snapshot');
  snapshot = decrypted;
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
  element('profile-updated').textContent = new Date(snapshot.profile.updatedAt).toLocaleString();
  element('profile-resume').textContent = snapshot.profile.hasResume ? 'Attached' : 'Not attached';
  element('settings-exported').textContent = new Date(snapshot.updatedAt).toLocaleString();
  element('profile-leads').textContent = snapshot.leads.length.toLocaleString();
  element('locked').hidden = true;
  element('lock').hidden = false;
  element('private-nav').hidden = false;
  element('error').hidden = true;
  selectView({ focus: true });
}

async function fetchEnvelope() {
  const response = await fetch('./admin.enc.json', { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error('Snapshot unavailable');
  return response.json();
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
        (view !== 'applications' || applicationStatuses.includes(lead.status)) &&
        isRecentJob(lead, Number(element('posted').value)) &&
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
    role.className = 'role-cell';
    role.append(title);
    const match = cell(`${Math.round(lead.score * 100)}%`, 'match');
    const meter = document.createElement('meter');
    meter.min = 0;
    meter.max = 100;
    meter.value = lead.score * 100;
    meter.setAttribute('aria-label', 'Match score');
    match.append(meter);
    const statusCell = cell('');
    const badge = document.createElement('span');
    badge.className = 'status-badge';
    badge.dataset.status = lead.status;
    badge.textContent = lead.status.charAt(0).toUpperCase() + lead.status.slice(1);
    statusCell.append(badge);
    row.append(
      match,
      role,
      cell(lead.company, 'company-cell'),
      cell(lead.location, 'location-cell'),
      cell(lead.source, 'source-cell'),
      cell(
        lead.postedAt ? new Date(lead.postedAt).toLocaleDateString() : 'Not listed',
        'posted-cell',
      ),
      statusCell,
    );
    return row;
  });
  element('rows').replaceChildren(...rows);
  element('leads-title').textContent =
    view === 'search'
      ? 'Search jobs'
      : view === 'applications'
        ? 'Applications'
        : `${snapshot.leads.length.toLocaleString()} leads`;
  element('empty').textContent =
    view === 'applications'
      ? 'No applications match these filters in this snapshot.'
      : 'No leads match these filters.';
  element('lead-table').setAttribute(
    'aria-label',
    view === 'applications' ? 'Applications' : 'My leads',
  );
  element('threshold-count').textContent =
    `${leads.length.toLocaleString()} at or above ${minimum}%`;
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
    const envelope = await fetchEnvelope();
    const unlocked = await unlockSnapshot(envelope, passphrase);
    if (attempt !== generation) return;
    lastActivity = Date.now();
    showSnapshot(unlocked.snapshot);
    tabSession = { key: unlocked.key, salt: envelope.salt, nonce: envelope.nonce, lastActivity };
    saveSession();
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
element('settings-lock').addEventListener('click', lock);
window.addEventListener('hashchange', () => selectView({ focus: true }));
element('more').addEventListener('click', () => {
  limit += 50;
  render();
});
for (const id of ['search', 'score', 'sources', 'status', 'sort', 'posted'])
  element(id).addEventListener('input', () => {
    limit = 50;
    render();
  });
element('clear').addEventListener('click', () => {
  element('search').value = '';
  element('score').value = '0';
  element('status').value = '';
  element('sort').value = 'score';
  element('posted').value = '';
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
      if (tabSession && snapshot) {
        tabSession.lastActivity = lastActivity;
        saveSession();
      }
    },
    { passive: true },
  );
setInterval(() => {
  if (snapshot && Date.now() - lastActivity >= 300000) lock();
}, 10000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastActivity >= 300000) lock();
});
window.addEventListener('pagehide', () => lock({ preserveSession: true }));

async function resumeSession() {
  const attempt = ++generation;
  element('unlock').disabled = true;
  try {
    const saved = JSON.parse(sessionStorage.getItem(sessionKey) || 'null');
    if (!saved) return;
    const decrypted = await restoreSnapshot(await fetchEnvelope(), saved);
    if (attempt !== generation) return;
    lastActivity = saved.lastActivity;
    tabSession = saved;
    showSnapshot(decrypted);
  } catch {
    if (attempt === generation) lock();
  } finally {
    element('unlock').disabled = false;
  }
}
window.addEventListener('pageshow', (event) => {
  if (event.persisted) resumeSession();
});
resumeSession();
