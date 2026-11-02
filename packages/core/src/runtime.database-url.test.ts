import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveDatabaseUrl } from './runtime.js';

// The database password is delivered as a file in production so it never sits in the environment
// (docker inspect). These checks cover the resolver every entry point now uses (V12 Stage 01 security).
function withSecret(content: string, run: (path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'careerscope-db-password-'));
  try {
    const path = join(directory, 'database-password');
    writeFileSync(path, content);
    run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('without DATABASE_PASSWORD_FILE the URL is returned unchanged', () => {
  const url = 'postgres://careerscope@127.0.0.1:5432/careerscope';
  assert.equal(resolveDatabaseUrl({ DATABASE_URL: url }), url);
});

test('the password from the file is applied when the URL has none', () => {
  withSecret('0123456789abcdef0123\n', (path) => {
    const resolved = new URL(
      resolveDatabaseUrl({
        DATABASE_URL: 'postgres://careerscope@127.0.0.1:5432/careerscope',
        DATABASE_PASSWORD_FILE: path,
      }),
    );
    assert.equal(resolved.password, '0123456789abcdef0123');
    assert.equal(resolved.username, 'careerscope');
    assert.equal(resolved.hostname, '127.0.0.1');
  });
});

test('a password already in the URL is kept, but the file is still validated', () => {
  withSecret('0123456789abcdef0123', (path) => {
    const url = 'postgres://careerscope:already-set-value@127.0.0.1:5432/careerscope';
    assert.equal(
      resolveDatabaseUrl({ DATABASE_URL: url, DATABASE_PASSWORD_FILE: path }),
      new URL(url).toString(),
    );
  });
});

test('a weak password file is refused without echoing its value', () => {
  withSecret('short', (path) => {
    assert.throws(
      () =>
        resolveDatabaseUrl({
          DATABASE_URL: 'postgres://careerscope@127.0.0.1:5432/careerscope',
          DATABASE_PASSWORD_FILE: path,
        }),
      (error: Error) =>
        error.message.includes('DATABASE_PASSWORD_FILE') && !error.message.includes('short'),
    );
  });
});

test('a missing password file names only the variable', () => {
  assert.throws(
    () =>
      resolveDatabaseUrl({
        DATABASE_URL: 'postgres://careerscope@127.0.0.1:5432/careerscope',
        DATABASE_PASSWORD_FILE: join(tmpdir(), 'careerscope-no-such-file-for-test'),
      }),
    (error: Error) => error.message === 'DATABASE_PASSWORD_FILE could not be read',
  );
});

test('a missing DATABASE_URL is refused', () => {
  assert.throws(() => resolveDatabaseUrl({}), /DATABASE_URL is required/);
});
