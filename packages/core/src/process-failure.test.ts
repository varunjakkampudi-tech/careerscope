import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { installProcessFailureHandlers } from './failure.js';

const fixture = fileURLToPath(new URL('./process-failure.fixture.ts', import.meta.url));

for (const mode of ['configuration', 'rejection']) {
  test(`a ${mode} crash exits 1 without printing the connection password`, () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', fixture, mode], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: ['postgres://user', ':S3cretPass@[bad host'].join(''),
        REDIS_URL: 'redis://127.0.0.1:56379',
        APP_ORIGIN: 'http://127.0.0.1:3000',
      },
    });
    assert.equal(child.status, 1);
    assert.doesNotMatch(child.stderr, /S3cretPass/);
    assert.doesNotMatch(child.stdout, /S3cretPass/);
    assert.match(child.stdout + child.stderr, /Process crashed/);
  });
}

test('installProcessFailureHandlers registers one listener however often it is called', () => {
  const before = process.listenerCount('uncaughtException');
  installProcessFailureHandlers();
  installProcessFailureHandlers();
  assert.equal(process.listenerCount('uncaughtException'), before + 1);
  assert.equal(process.listenerCount('unhandledRejection') >= 1, true);
});

test('a startup failure in migrate.ts exits 1 within 10 seconds without leaking the URL secret', () => {
  const migrate = fileURLToPath(new URL('../../../scripts/jobs/migrate.ts', import.meta.url));
  const started = Date.now();
  const child = spawnSync(process.execPath, ['--import', 'tsx', migrate], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      DATABASE_URL: ['postgres://user', ':S3cretPass@[bad host'].join(''),
    },
  });
  const elapsed = Date.now() - started;
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.equal(elapsed < 10000, true);
  assert.doesNotMatch(child.stderr, /S3cretPass/);
  assert.doesNotMatch(child.stdout, /S3cretPass/);
  assert.match(child.stdout + child.stderr, /Migration failed/);
});

const entryPoints = [
  ['apps/api/src/main.ts', {}],
  ['apps/workers/search/src/main.ts', {}],
  ['apps/workers/search/src/publisher.ts', {}],
  // files.ts idles when private storage is unconfigured, so it needs a storage directory and key file.
  ['apps/workers/search/src/files.ts', { storage: true }],
] as const;

for (const [entry, options] of entryPoints) {
  test(`a startup failure in ${entry} exits 1 within 15 seconds without leaking the URL secret`, async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const scratch = await mkdtemp(join(tmpdir(), 'careerscope-startup-'));
    try {
      const keyFile = join(scratch, 'resume.key');
      await writeFile(keyFile, 'a'.repeat(64), { mode: 0o600 });
      const started = Date.now();
      const child = spawnSync(process.execPath, ['--import', 'tsx', join(root, entry)], {
        encoding: 'utf8',
        timeout: 15000,
        cwd: root,
        env: {
          ...process.env,
          DATABASE_URL: ['postgres://user', ':S3cretPass@[bad host'].join(''),
          REDIS_URL: 'redis://127.0.0.1:1',
          QUEUE_REDIS_URL: 'redis://127.0.0.1:1',
          APP_ORIGIN: 'http://127.0.0.1:3000',
          ...('storage' in options
            ? {
                RESUME_STORAGE_DIRECTORY: join(scratch, 'objects'),
                RESUME_STORAGE_KEY_FILE: keyFile,
              }
            : {}),
        },
      });
      const elapsed = Date.now() - started;
      const output = child.stdout + child.stderr;
      console.log(`${entry}: status=${child.status} elapsedMs=${elapsed}`);
      assert.equal(child.error, undefined);
      assert.equal(child.status, 1);
      assert.equal(elapsed < 15000, true);
      assert.doesNotMatch(output, /S3cretPass/);
      assert.match(output, /Startup failed/);
      assert.doesNotMatch(output, /Process crashed|Unhandled|Uncaught|at async|node:internal/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

// A signal-delivery test is not practical here: Windows cannot deliver SIGTERM to a child, and the
// API listens on a fixed port, so a signal cannot be timed to land inside a given startup await.
// This guards the ordering that fixes the defect instead: the handler is registered before any
// resource is opened, so a signal during any startup step reaches the cleanup path.
test('apps/api/src/main.ts registers the shutdown signal before it opens any resource', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    fileURLToPath(new URL('../../../apps/api/src/main.ts', import.meta.url)),
    'utf8',
  );
  const registered = source.indexOf('shutdownSignal()');
  assert.notEqual(registered, -1);
  for (const opener of [
    'new Database(',
    'await rateLimiter(',
    'await configuredFileResumeStorage(',
  ]) {
    const opened = source.indexOf(opener);
    assert.notEqual(opened, -1, opener);
    assert.ok(registered < opened, `shutdownSignal() must come before ${opener}`);
  }
});
