import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runInNewContext } from 'node:vm';
import { syncVersion, versionFiles } from './sync-version.mjs';

test('generates consistent app and Pages versions for semantic releases', () => {
  for (const version of ['1.0.1', '1.1.0', '2.0.0']) {
    const writes = new Map();
    assert.equal(
      syncVersion({
        read: () => JSON.stringify({ version }),
        write: (path, content) => writes.set(path, content),
      }),
      version,
    );
    assert.equal(writes.size, 2);
    for (const content of writes.values()) assert.ok(content.includes(version));
  }
  assert.throws(() => versionFiles('not-a-version'));
});

test('generated Pages script renders the release in each footer', () => {
  const elements = [{ textContent: '' }, { textContent: '' }];
  runInNewContext(versionFiles('2.1.4')['mobile-site/version.js'], {
    document: { querySelectorAll: () => elements },
  });
  assert.deepEqual(
    elements.map((element) => element.textContent),
    ['v2.1.4', 'v2.1.4'],
  );
});

test('npm semantic bumps update root metadata and lockfile without scripts or tags', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-version-test-'));
  try {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'release-fixture', version: '1.0.0', private: true }),
    );
    await writeFile(
      join(directory, 'package-lock.json'),
      JSON.stringify({
        name: 'release-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: { '': { name: 'release-fixture', version: '1.0.0' } },
      }),
    );
    for (const [bump, expected] of [
      ['patch', '1.0.1'],
      ['minor', '1.1.0'],
      ['major', '2.0.0'],
    ]) {
      execFileSync(
        // Windows resolves npm through npm.cmd, which needs a shell to execute.
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['version', bump, '--no-git-tag-version', '--ignore-scripts', '--workspaces=false'],
        { cwd: directory, stdio: 'pipe', shell: process.platform === 'win32' },
      );
      assert.equal(
        JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).version,
        expected,
      );
      const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
      assert.equal(lock.version, expected);
      assert.equal(lock.packages[''].version, expected);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('check mode rejects stale versions without writing files', () => {
  const files = versionFiles('1.2.3');
  // Resolved paths use the platform separator, so compare normalised suffixes.
  const read = (path) => {
    const normalised = String(path).replaceAll('\\', '/');
    return normalised.endsWith('package.json')
      ? '{"version":"1.2.3"}'
      : Object.entries(files).find(([file]) => normalised.endsWith(file))?.[1];
  };
  const write = () => assert.fail('Check must not write');
  assert.equal(syncVersion({ check: true, read, write }), '1.2.3');
  assert.throws(
    () =>
      syncVersion({
        check: true,
        read: (path) =>
          String(path).replaceAll('\\', '/').endsWith('package.json') ? read(path) : 'stale',
        write,
      }),
    /Version mismatch/,
  );
});
