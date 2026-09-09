import assert from 'node:assert/strict';
import test from 'node:test';
import process from 'node:process';
import { publishPages } from './publish-pages.mjs';

function fixture(env, { branch = 'main', staged = '', exportFails = false } = {}) {
  const calls = [];
  return {
    calls,
    read: () => env,
    run(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === 'branch') return branch;
      if (args[0] === 'diff') return staged;
      if (command === process.execPath && exportFails) throw new Error('Export failed');
      return '';
    },
  };
}

test('each publication rereads the local passphrase and exports before committing only ciphertext', () => {
  for (const passphrase of ['first-synthetic-secret-123', 'second-synthetic-secret-456']) {
    const runner = fixture(`ADMIN_SNAPSHOT_PASSPHRASE=${passphrase}\nDATA_DIR=./data`);
    publishPages(runner);
    const exported = runner.calls.find((call) => call.command === process.execPath);
    assert.equal(exported.options.env.ADMIN_SNAPSHOT_PASSPHRASE, passphrase);
    assert.deepEqual(
      runner.calls.map((call) => call.args[0]),
      ['branch', 'diff', 'scripts/export-admin.mjs', 'add', 'commit', 'push'],
    );
    assert.deepEqual(runner.calls[4].args, [
      'commit',
      '--only',
      '-m',
      'Refresh encrypted admin snapshot',
      '--',
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
  ]) {
    assert.throws(() => publishPages(runner));
    assert.ok(!runner.calls.some((call) => ['add', 'commit', 'push'].includes(call.args[0])));
  }
});

test('failed encryption never commits or pushes the old snapshot', () => {
  const runner = fixture('ADMIN_SNAPSHOT_PASSPHRASE=valid-synthetic-secret-123', {
    exportFails: true,
  });
  assert.throws(() => publishPages(runner));
  assert.ok(!runner.calls.some((call) => ['add', 'commit', 'push'].includes(call.args[0])));
});
