/**
 * `npm run db:migrate` — creates or updates the database, then reports what it
 * did.
 *
 * The DDL is idempotent, so this is safe against a live database and is also
 * what `index.ts` calls at boot. Having it as a *script* as well matters for
 * deployment: a container whose data volume is missing or read-only should fail
 * loudly at `docker compose up`, not on the first request three minutes later.
 */

import { resolve } from 'node:path';
import { Db, migrate } from './index.js';
import { parseEnv } from '../env.js';

export function databasePath(dataDir: string): string {
  return resolve(dataDir, 'job-radar.db');
}

export interface MigrationResult {
  path: string;
  from: number;
  to: number;
}

/**
 * Opens, migrates, closes. Exported so tests and `seed.ts` can reuse it.
 *
 * Uses `new Db()` rather than `openDatabase()` deliberately: the latter migrates
 * on the way in, which would stamp the version before we read it and make every
 * run report "already up to date".
 */
export function runMigration(dataDir: string): MigrationResult {
  const path = databasePath(dataDir);
  const db = new Db(path);
  try {
    return { path, ...migrate(db) };
  } finally {
    db.close();
  }
}

function main(): void {
  try {
    const env = parseEnv();
    const { path, from, to } = runMigration(env.DATA_DIR);
    console.log(
      from === to
        ? `Database at ${path} is already at schema v${to}.`
        : `Migrated ${path}: schema v${from} → v${to}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

// Only when run directly, so importing `runMigration` has no side effects.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
