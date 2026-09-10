import { DatabaseSync } from 'node:sqlite';
import { mkdir, copyFile, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { setInterval, clearInterval } from 'node:timers';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicHosts =
  /(^|\.)(linkedin\.com|naukri\.com|indeed\.com|greenhouse\.io|greenhouse\.com|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|remotive\.com|remoteok\.com|himalayas\.app)$/i;

export function publicJobUrl(raw) {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !publicHosts.test(url.hostname)
    )
      return null;
    if (/\/mynetwork\/|\/comm\/|\/login|\/auth|\/email|\/safety\//i.test(url.pathname)) return null;
    const safe = new URL(url.origin + url.pathname);
    for (const key of ['jk', 'vjk', 'gh_jid', 'jobId', 'jobid']) {
      const value = url.searchParams.get(key);
      if (value && /^[a-zA-Z0-9_-]{1,100}$/.test(value)) safe.searchParams.set(key, value);
    }
    return safe.href;
  } catch {
    return null;
  }
}

export function publicJobs(rows) {
  const jobs = new Map();
  for (const row of rows) {
    const url = publicJobUrl(row.source_url);
    if (!url) continue;
    jobs.set(url, {
      title: String(row.title),
      company: String(row.company),
      location: String(row.location),
      source: String(row.source),
      postedAt: row.posted_at ?? null,
      url,
    });
  }
  return [...jobs.values()];
}

export async function exportMobile() {
  const database = new DatabaseSync(resolve(root, process.env.DATA_DIR || 'data', 'job-radar.db'), {
    readOnly: true,
  });
  let rows;
  try {
    rows = database
      .prepare(
        `SELECT DISTINCT j.title, c.name AS company, j.location,
      j.source, j.posted_at, j.source_url FROM jobs j
      JOIN companies c ON c.id = j.company_id JOIN leads l ON l.job_id = j.id
      ORDER BY j.posted_at DESC, j.title, c.name, j.source_url`,
      )
      .all();
  } finally {
    database.close();
  }
  const jobs = publicJobs(rows);
  const destination = join(root, 'mobile-site');
  await mkdir(destination, { recursive: true });
  await copyFile(join(root, 'apps/web/public/favicon.svg'), join(destination, 'favicon.svg'));
  const previous = await readFile(join(destination, 'jobs.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  if (JSON.stringify(previous?.jobs) === JSON.stringify(jobs)) return false;
  await writeFile(
    join(destination, 'jobs.json.tmp'),
    JSON.stringify({ updatedAt: new Date().toISOString(), jobs }),
  );
  await rename(join(destination, 'jobs.json.tmp'), join(destination, 'jobs.json'));
  process.stdout.write(
    `Mobile snapshot updated: ${jobs.length} public posting links; ${rows.length - jobs.length} unsupported or duplicate entries omitted.\n`,
  );
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await exportMobile();
  if (process.argv.includes('--watch')) {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await exportMobile();
      } catch {
        process.stderr.write('Mobile export failed; previous snapshot retained.\n');
      } finally {
        busy = false;
      }
    }, 60_000);
    process.on('SIGINT', () => clearInterval(timer));
    process.on('SIGTERM', () => clearInterval(timer));
  }
}
