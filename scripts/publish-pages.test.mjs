import assert from 'node:assert/strict';
import test from 'node:test';
import process from 'node:process';
import { publishPages } from './publish-pages.mjs';

function fixture(
  env,
  { branch = 'main', staged = '', dirty = '', exportFails = false, failStep = '' } = {},
) {
  const calls = [];
  let version = '1.0.0';
  return {
    calls,
    read: (path) => (path.endsWith('package.json') ? JSON.stringify({ version }) : env),
    run(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === failStep) throw new Error('Release step failed');
      if (args[0] === 'branch') return branch;
      if (args[0] === 'diff') return staged;
      if (args[0] === 'status') return dirty;
      if (command === 'npm') version = { patch: '1.0.1', minor: '1.1.0', major: '2.0.0' }[args[1]];
      if (command === process.execPath && exportFails) throw new Error('Export failed');
      return '';
    },
  };
}

test('each publication reads the local passphrase and commits a patch release with ciphertext', () => {
  for (const passphrase of ['first-synthetic-secret-123', 'second-synthetic-secret-456']) {
    const runner = fixture(`ADMIN_SNAPSHOT_PASSPHRASE=${passphrase}\nDATA_DIR=./data`);
    assert.equal(publishPages(runner), '1.0.1');
    const exported = runner.calls.find((call) => call.command === process.execPath);
    assert.equal(exported.options.env.ADMIN_SNAPSHOT_PASSPHRASE, passphrase);
    assert.deepEqual(
      runner.calls.map((call) => call.args[0]),
      [
        'branch',
        'diff',
        'status',
        'scripts/export-admin.mjs',
        'version',
        'scripts/sync-version.mjs',
        'add',
        'commit',
        'push',
      ],
    );
    assert.deepEqual(runner.calls[7].args, [
      'commit',
      '--only',
      '-m',
      'Release v1.0.1',
      '--',
      'package.json',
      'package-lock.json',
      'apps/web/src/lib/brand.ts',
      'mobile-site/version.js',
      'mobile-site/admin.enc.json',
    ]);
    assert.ok(runner.calls.every((call) => !call.args.join(' ').includes(passphrase)));
    assert.ok(
      runner.calls.filter((call) => call.command === 'git').every((call) => !call.options.env),
    );
  }
});

test('missing or placeholder passphrases, wrong branches and staged changes prevent publication', () => {
  for (const runner of [
    fixture(''),
    fixture('ADMIN_SNAPSHOT_PASSPHRASE=password-placeholder-123'),
    fixture('ADMIN_SNAPSHOT_PASSPHRASE=valid-synthetic-secret-123', { branch: 'feature' }),
    fixture('ADMIN_SNAPSHOT_PASSPHRASE=valid-synthetic-secret-123', { staged: 'README.md' }),
    fixture('ADMIN_SNAPSHOT_PASSPHRASE=valid-synthetic-secret-123', { dirty: ' M package.json' }),
  ]) {
    assert.throws(() => publishPages(runner));
    assert.ok(!runner.calls.some((call) => ['add', 'commit', 'push'].includes(call.args[0])));
  }
});

test('supports minor and major releases and rejects unknown release types before changes', () => {
  for (const [bump, expected] of [
    ['minor', '1.1.0'],
    ['major', '2.0.0'],
  ]) {
    const runner = fixture('ADMIN_SNAPSHOT_PASSPHRASE=valid-synthetic-secret-123');
    assert.equal(publishPages({ ...runner, bump }), expected);
    assert.deepEqual(runner.calls.find((call) => call.command === 'npm').args, [
      'version',
      bump,
      '--no-git-tag-version',
      '--ignore-scripts',
      '--workspaces=false',
    ]);
  }
  const runner = fixture('ADMIN_SNAPSHOT_PASSPHRASE=valid-synthetic-secret-123');
  assert.throws(() => publishPages({ ...runner, bump: 'invalid' }), /Choose patch/);
  assert.equal(runner.calls.length, 0);
});

test('failed encryption never commits or pushes the old snapshot', () => {
  const runner = fixture('ADMIN_SNAPSHOT_PASSPHRASE=valid-synthetic-secret-123', {
    exportFails: true,
  });
  assert.throws(() => publishPages(runner));
  assert.ok(!runner.calls.some((call) => ['add', 'commit', 'push'].includes(call.args[0])));
});

test('version bump or synchronization failures never commit or push', () => {
  for (const failStep of ['version', 'scripts/sync-version.mjs']) {
    const runner = fixture('ADMIN_SNAPSHOT_PASSPHRASE=valid-synthetic-secret-123', { failStep });
    assert.throws(() => publishPages(runner));
    assert.ok(!runner.calls.some((call) => ['add', 'commit', 'push'].includes(call.args[0])));
  }
});
