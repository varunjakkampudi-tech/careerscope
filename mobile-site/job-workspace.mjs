export const savedJobsKey = 'careerscope.public.saved.v1';

export function isRecentJob(job, days, now = Date.now()) {
  if (!days) return true;
  const posted = typeof job.postedAt === 'string' ? Date.parse(job.postedAt) : NaN;
  return Number.isFinite(posted) && posted <= now && posted >= now - days * 86400000;
}

export function publicJobView(
  jobs,
  {
    query = '',
    source = '',
    days = 0,
    sort = 'snapshot',
    savedOnly = false,
    saved = new Set(),
  } = {},
  now = Date.now(),
) {
  const normalized = query.trim().toLowerCase();
  const matches = jobs.filter(
    (job) =>
      (!source || source === job.source) &&
      (!savedOnly || saved.has(job.url)) &&
      isRecentJob(job, days, now) &&
      `${job.title} ${job.company} ${job.location}`.toLowerCase().includes(normalized),
  );
  if (sort === 'newest')
    matches.sort(
      (first, second) => (Date.parse(second.postedAt) || 0) - (Date.parse(first.postedAt) || 0),
    );
  if (sort === 'company')
    matches.sort(
      (first, second) =>
        first.company.localeCompare(second.company) || first.title.localeCompare(second.title),
    );
  return matches;
}

export function readSavedJobs(storage) {
  const parsed = JSON.parse(storage.getItem(savedJobsKey) || '[]');
  if (!Array.isArray(parsed) || parsed.length > 5000) throw new Error('Invalid saved list');
  return new Set(
    parsed.filter((value) => {
      if (typeof value !== 'string') return false;
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      } catch {
        return false;
      }
    }),
  );
}

export function writeSavedJobs(storage, saved) {
  if (saved.size > 5000) throw new Error('Saved list limit reached');
  storage.setItem(savedJobsKey, JSON.stringify([...saved]));
}
