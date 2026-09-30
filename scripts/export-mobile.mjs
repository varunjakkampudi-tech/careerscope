import { mkdir, copyFile, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { setInterval, clearInterval } from 'node:timers';
import pg from 'pg';

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
  const ownerId = process.env.PUBLIC_EXPORT_OWNER_ID;
  if (!ownerId) throw new Error('PUBLIC_EXPORT_OWNER_ID is required for a public export.');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT
         data->>'title' AS title,
         data->>'company' AS company,
         data->>'location' AS location,
         data->>'source' AS source,
         data->>'postedAt' AS posted_at,
         data->>'sourceUrl' AS source_url
       FROM saved_leads
       WHERE owner_id = $1 AND status <> 'archived'
       ORDER BY posted_at DESC NULLS LAST, title, company, source_url`,
      [ownerId],
    );
    const jobs = publicJobs(rows);
    const destination = join(root, 'mobile-site');
    await mkdir(destination, { recursive: true });
    await copyFile(
      join(root, 'apps/web/public/brand/logo-icon.png'),
      join(destination, 'favicon.png'),
    );
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
  } finally {
    await pool.end();
  }
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
