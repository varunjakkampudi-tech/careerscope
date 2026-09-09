import { DatabaseSync } from 'node:sqlite';
import { writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import process from 'node:process';
import { publicJobUrl } from './export-mobile.mjs';
import { encryptSnapshot } from '../mobile-site/snapshot-crypto.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function adminLeads(rows) {
  return rows.map((row) => ({
    title: String(row.title),
    company: String(row.company),
    location: String(row.location),
    source: String(row.source),
    postedAt: row.posted_at ?? null,
    url: publicJobUrl(row.source_url),
    score: Number(row.score),
    status: String(row.status),
  }));
}

export function configuredPassphrase(value) {
  if (!value) return null;
  if (
    value.length < 12 ||
    /^(admin|password|dummy|changeme|change-me|replace-me|example)/i.test(value)
  ) {
    throw new Error(
      'Replace dummy ADMIN_SNAPSHOT_PASSPHRASE with a unique passphrase of at least 12 characters, or leave it empty for hidden input.',
    );
  }
  return value;
}

export function readAdminSnapshot(database) {
  const profiles = database.prepare('SELECT id, updated_at, resume_id FROM profiles').all();
  if (profiles.length !== 1) throw new Error('Export requires exactly one owner profile.');
  const profile = profiles[0];
  const rows = database
    .prepare(
      `SELECT j.title, c.name AS company, j.location, j.source,
    j.posted_at, j.source_url, l.score, l.status FROM leads l
    JOIN jobs j ON j.id = l.job_id JOIN companies c ON c.id = j.company_id
    WHERE l.profile_id = ? ORDER BY l.score DESC, j.title, l.id`,
    )
    .all(profile.id);
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    profile: { updatedAt: profile.updated_at, hasResume: Boolean(profile.resume_id) },
    leads: adminLeads(rows),
  };
}

async function askPassphrase() {
  if (!process.stdin.isTTY) throw new Error('Run this command in your own interactive terminal.');
  const silent = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const reader = createInterface({ input: process.stdin, output: silent, terminal: true });
  try {
    process.stdout.write('Choose a unique snapshot passphrase (12+ characters; input hidden): ');
    const passphrase = await reader.question('');
    process.stdout.write('\nConfirm passphrase (input hidden): ');
    const confirmation = await reader.question('');
    process.stdout.write('\n');
    if (passphrase !== confirmation) throw new Error('Passphrases do not match.');
    return passphrase;
  } finally {
    reader.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const passphrase =
      configuredPassphrase(process.env.ADMIN_SNAPSHOT_PASSPHRASE) ?? (await askPassphrase());
    delete process.env.ADMIN_SNAPSHOT_PASSPHRASE;
    const database = new DatabaseSync(
      resolve(root, process.env.DATA_DIR || 'data', 'job-radar.db'),
      { readOnly: true },
    );
    let snapshot;
    try {
      snapshot = readAdminSnapshot(database);
    } finally {
      database.close();
    }
    const envelope = await encryptSnapshot(snapshot, passphrase);
    const destination = resolve(root, 'mobile-site/admin.enc.json');
    await writeFile(`${destination}.tmp`, JSON.stringify(envelope), { mode: 0o600 });
    await rename(`${destination}.tmp`, destination);
    process.stdout.write(
      `Encrypted ${snapshot.leads.length} leads. Only ciphertext was written. Publish admin.enc.json with the Pages files.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
