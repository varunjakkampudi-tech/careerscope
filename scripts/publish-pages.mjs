import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseEnv } from 'node:util';
import process from 'node:process';
import { configuredPassphrase } from './export-admin.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

const versionPaths = [
  'package.json',
  'package-lock.json',
  'apps/web/src/lib/brand.ts',
  'mobile-site/version.js',
];

export function publishPages({ read = readFileSync, run = execFileSync, bump = 'patch' } = {}) {
  if (!['patch', 'minor', 'major'].includes(bump)) throw new Error('Choose patch, minor or major.');
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
  if (git('status', '--porcelain', '--', ...versionPaths)) {
    throw new Error('Commit version-file changes before publishing.');
  }
  run(process.execPath, ['scripts/export-admin.mjs'], {
    ...options,
    env: { ...process.env, ...local },
  });
  run(
    'npm',
    ['version', bump, '--no-git-tag-version', '--ignore-scripts', '--workspaces=false'],
    options,
  );
  run(process.execPath, ['scripts/sync-version.mjs'], options);
  const { version } = JSON.parse(read(resolve(root, 'package.json'), 'utf8'));
  const files = [...versionPaths, 'mobile-site/admin.enc.json'];
  git('add', '--', ...files);
  git('commit', '--only', '-m', `Release v${version}`, '--', ...files);
  git('push', 'origin', 'main');
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const version = publishPages({ bump: process.argv[2] ?? 'patch' });
    process.stdout.write(
      `Release v${version} pushed with the current local passphrase. Wait for CI and Pages deployment to finish.\n`,
    );
  } catch {
    process.stderr.write(
      'Publication failed. Check the release type (patch/minor/major), local passphrase, main branch, pending version/staged changes and Git access. Release files or a commit may remain locally if a step failed. No secret was printed.\n',
    );
    process.exitCode = 1;
  }
}
