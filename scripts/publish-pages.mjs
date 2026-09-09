import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseEnv } from 'node:util';
import process from 'node:process';
import { configuredPassphrase } from './export-admin.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function publishPages({ read = readFileSync, run = execFileSync } = {}) {
  const local = parseEnv(read(resolve(root, '.env'), 'utf8'));
  if (!configuredPassphrase(local.ADMIN_SNAPSHOT_PASSPHRASE)) {
    throw new Error('Set ADMIN_SNAPSHOT_PASSPHRASE in the local .env before publishing.');
  }
  const options = { cwd: root, encoding: 'utf8', stdio: 'pipe' };
  const git = (...args) => run('git', args, options).trim();
  if (git('branch', '--show-current') !== 'main') {
    throw new Error('Publish from main after committing the intended code changes.');
  }
  if (git('diff', '--cached', '--name-only')) {
    throw new Error('Commit or unstage pending changes before publishing.');
  }
  run(process.execPath, ['scripts/export-admin.mjs'], {
    ...options,
    env: { ...process.env, ...local },
  });
  git('add', '--', 'mobile-site/admin.enc.json');
  git(
    'commit',
    '--only',
    '-m',
    'Refresh encrypted admin snapshot',
    '--',
    'mobile-site/admin.enc.json',
  );
  git('push', 'origin', 'main');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    publishPages();
    process.stdout.write(
      'Encrypted with the current local passphrase and pushed main. Wait for Pages deployment to finish.\n',
    );
  } catch {
    process.stderr.write(
      'Publication failed. Check the local passphrase, main branch, pending staged changes and Git access. A snapshot commit may remain locally if the push failed. No secret was printed.\n',
    );
    process.exitCode = 1;
  }
}
