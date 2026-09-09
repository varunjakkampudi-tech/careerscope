import { chmodSync, existsSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backup } from 'node:sqlite';
import { Db } from './db/index.js';
import { databasePath } from './db/migrate.js';
import { AuthRepo } from './db/repo/auth.js';
import { parseEnv } from './env.js';

async function main(): Promise<void> {
  if (!process.argv.includes('--confirm-reset')) {
    throw new Error(
      'Run npm run auth:reset -- --confirm-reset to revoke logins and reopen local setup.',
    );
  }
  const env = parseEnv();
  const localHosts = ['localhost', '127.0.0.1', '::1', '[::1]'];
  if (
    env.NODE_ENV !== 'development' ||
    !env.LOGIN_ENABLED ||
    env.TRUST_PROXY ||
    !localHosts.includes(env.HOST) ||
    !localHosts.includes(new URL(env.AUTH_ORIGIN).hostname)
  ) {
    throw new Error(
      'Recovery requires development mode, enabled login, loopback HOST/AUTH_ORIGIN and no proxy.',
    );
  }
  const path = databasePath(env.DATA_DIR);
  if (!existsSync(path))
    throw new Error('The configured database does not exist. No changes made.');
  const db = new Db(path);
  try {
    if (!db.get('SELECT id FROM auth_owner WHERE id = 1')) {
      throw new Error('No owner account exists. Open the local login page to complete setup.');
    }
    const backupDirectory = mkdtempSync(join(dirname(path), 'owner-recovery-'));
    chmodSync(backupDirectory, 0o700);
    const backupPath = join(backupDirectory, 'job-radar.db');
    await backup(db.raw, backupPath);
    chmodSync(backupPath, 0o600);
    new AuthRepo(db).resetForLocalSetup();
    process.stdout.write(`Backup saved to ${backupPath}\n`);
    process.stdout.write(
      'Owner login reset. Profile, resumes and leads are unchanged. Existing sessions revoked.\n',
    );
    process.stdout.write(
      `Open ${new URL('/login', env.AUTH_ORIGIN).href} and create your replacement owner password now.\n`,
    );
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Owner recovery failed.');
  process.exitCode = 1;
});
