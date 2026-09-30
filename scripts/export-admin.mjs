import { writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import process from 'node:process';
import pg from 'pg';
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
    const ownerId = process.env.PUBLIC_EXPORT_OWNER_ID;
    if (!ownerId) throw new Error('PUBLIC_EXPORT_OWNER_ID is required for an admin export.');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let snapshot;
    try {
      const profile = await pool.query(
        `SELECT p.updated_at,
          EXISTS (SELECT 1 FROM resume_results rr
            WHERE rr.owner_id = p.owner_id AND rr.status = 'parsed') AS has_resume
         FROM candidate_profiles p WHERE p.owner_id = $1`,
        [ownerId],
      );
      if (profile.rowCount !== 1) throw new Error('Export requires exactly one owner profile.');
      const leads = await pool.query(
        `SELECT data->>'title' AS title, data->>'company' AS company,
          data->>'location' AS location, data->>'source' AS source,
          data->>'postedAt' AS posted_at, data->>'sourceUrl' AS source_url,
          COALESCE((data->'match'->>'score')::numeric, 0) AS score, status
         FROM saved_leads WHERE owner_id = $1
         ORDER BY score DESC, title, id`,
        [ownerId],
      );
      snapshot = {
        version: 1,
        updatedAt: new Date().toISOString(),
        profile: {
          updatedAt: profile.rows[0].updated_at,
          hasResume: Boolean(profile.rows[0].has_resume),
        },
        leads: adminLeads(leads.rows),
      };
    } finally {
      await pool.end();
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
