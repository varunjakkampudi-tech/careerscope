import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { resolve, join } from 'node:path';
import process from 'node:process';
import { validateEnvelope } from '../mobile-site/snapshot-crypto.mjs';
import { publicJobUrl } from './export-mobile.mjs';

export const pageFiles = [
  'index.html',
  'app.js',
  'style.css',
  'theme.js',
  'version.js',
  ...['list', 'search', 'briefcase', 'settings', 'user', 'globe', 'lock', 'refresh'].map(
    (name) => `icon-${name}.svg`,
  ),
  'favicon.svg',
  'select-chevron.svg',
  'robots.txt',
  'sitemap.xml',
  'jobs.json',
  'admin.html',
  'admin.js',
  'admin.css',
  'snapshot-crypto.mjs',
  'admin.enc.json',
];

export function validatePublicSnapshot(snapshot) {
  if (
    !snapshot ||
    Object.keys(snapshot).sort().join(',') !== 'jobs,updatedAt' ||
    !Array.isArray(snapshot.jobs) ||
    !Number.isFinite(Date.parse(snapshot.updatedAt))
  )
    throw new Error('Invalid public snapshot');
  for (const job of snapshot.jobs) {
    if (
      Object.keys(job).sort().join(',') !== 'company,location,postedAt,source,title,url' ||
      !['company', 'location', 'source', 'title', 'url'].every(
        (key) => typeof job[key] === 'string',
      ) ||
      publicJobUrl(job.url) !== job.url ||
      (job.postedAt !== null && !Number.isFinite(Date.parse(job.postedAt)))
    )
      throw new Error('Public snapshot contains unexpected or unsafe fields');
  }
}

export async function stagePages(source, destination) {
  const publicSnapshot = JSON.parse(await readFile(join(source, 'jobs.json'), 'utf8'));
  validatePublicSnapshot(publicSnapshot);
  const encrypted = JSON.parse(await readFile(join(source, 'admin.enc.json'), 'utf8'));
  validateEnvelope(encrypted);
  await mkdir(destination);
  for (const name of pageFiles) await copyFile(join(source, name), join(destination, name));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await stagePages(join(root, 'mobile-site'), join(root, '_site'));
  process.stdout.write(
    'Validated public fields and encrypted envelope; staged only allowlisted Pages assets.\n',
  );
}
