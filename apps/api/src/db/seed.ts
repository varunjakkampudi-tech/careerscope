/**
 * `npm run seed:companies` — loads the hand-verified company directory.
 *
 * ## What this data is, and why it exists
 *
 * `seed/companies.json` and `seed/leads.json` were exported from the original
 * `build-job-leads` script before that script was retired. Between them
 * they carry 112 employers and 117 postings that were collected and checked by
 * hand — every website in the file was opened, and every blank field was left
 * blank on purpose.
 *
 * That last part is the point. The seed is not here to make the database look
 * full; it is here so the company resolver starts from verified ground truth
 * instead of re-deriving it, and so a first-run user sees real links rather than
 * a page of "Not yet verified". Fields the original collector could not confirm
 * are absent, and the notes explaining *why* travelled with them.
 *
 * ## Idempotence
 *
 * Seeding is skipped once `SETTING.seedVersion` matches, and individual inserts
 * are `ON CONFLICT DO NOTHING`, so a company the app has since resolved for
 * itself is never overwritten by a file from August. `--force` re-runs the
 * version check but still will not clobber existing rows.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from './index.js';
import { databasePath } from './migrate.js';
import { createRepos, parseSeedFile, SETTING } from './repo/index.js';
import { parseEnv } from '../env.js';
import { now } from '../util/time.js';

/** Bumped when the seed files change, so an upgrade re-seeds without `--force`. */
export const SEED_VERSION = '2026-09-05';

export interface SeedResult {
  version: string;
  skipped: boolean;
  companiesInFile: number;
  companiesInserted: number;
}

export async function seedCompanies(
  dataDir: string,
  seedFile: string,
  options: { force?: boolean } = {},
): Promise<SeedResult> {
  const db = openDatabase(databasePath(dataDir));
  try {
    const repos = createRepos(db, dataDir);
    const applied = repos.settings.get(SETTING.seedVersion);
    if (applied === SEED_VERSION && !options.force) {
      return { version: SEED_VERSION, skipped: true, companiesInFile: 0, companiesInserted: 0 };
    }

    const companies = parseSeedFile(await readFile(seedFile, 'utf8'));
    const at = now();
    const inserted = repos.companies.seed(companies, at);
    repos.settings.set(SETTING.seedVersion, SEED_VERSION, at);

    return {
      version: SEED_VERSION,
      skipped: false,
      companiesInFile: companies.length,
      companiesInserted: inserted,
    };
  } finally {
    db.close();
  }
}

/**
 * Where to read the seed file from.
 *
 * `seed/` is source data and deliberately not `data/`, which is `DATA_DIR` —
 * a mounted volume in the container that shadows whatever the image baked in
 * and is empty on first boot. Keeping the two apart means the default resolves
 * correctly in both places: `<repo>/seed/companies.json` locally, and
 * `/app/seed/companies.json` in the image, whose WORKDIR is `/app`. The
 * argument stays overridable for anyone running from elsewhere.
 */
function seedFileArg(argv: string[]): string {
  const explicit = argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (explicit) return resolve(explicit);
  return resolve(process.cwd(), 'seed/companies.json');
}

async function main(): Promise<void> {
  try {
    const env = parseEnv();
    const force = process.argv.includes('--force');
    const file = seedFileArg(process.argv);
    const result = await seedCompanies(env.DATA_DIR, file, { force });

    if (result.skipped) {
      console.log(`Seed ${result.version} already applied. Use --force to re-run.`);
      return;
    }
    // Reports both numbers because they differ for a good reason: entries with
    // no verified link at all are skipped, and companies the app already knows
    // are left alone.
    console.log(
      `Seeded ${result.companiesInserted} of ${result.companiesInFile} companies ` +
        `(the rest were already present or carried no verified link).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  await main();
}
