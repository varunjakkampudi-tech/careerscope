const search = document.querySelector('#search');
const source = document.querySelector('#source');
const list = document.querySelector('#jobs');
const count = document.querySelector('#count');
const more = document.querySelector('#more');
const refresh = document.querySelector('#refresh');
let jobs = [];
let limit = 50;

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
  const query = search.value.trim().toLowerCase();
  const matches = jobs.filter(
    (job) =>
      (!source.value || job.source === source.value) &&
      `${job.title} ${job.company} ${job.location}`.toLowerCase().includes(query),
  );
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
    item.append(content, link);
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
    const selection = source.value;
    source.replaceChildren(new Option('All sources', ''));
    for (const name of [...new Set(jobs.map((job) => job.source))].sort())
      source.add(new Option(name, name));
    source.value = selection;
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
  render();
});
source.addEventListener('change', () => {
  limit = 50;
  render();
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
