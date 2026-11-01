import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configuration } from './runtime.js';

const base = {
  DATABASE_URL: 'postgres://127.0.0.1/test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  QUEUE_REDIS_URL: 'redis://127.0.0.1:6380',
  APP_ORIGIN: 'http://localhost:5280',
};

function withDirectory(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'secret-file-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Asserts the load is refused with a message that names the variable and nothing else. */
function refused(
  source: NodeJS.ProcessEnv,
  variable: string,
  forbidden: string[],
  options?: { emailOtpSecrets?: boolean },
) {
  assert.throws(
    () => configuration(source, options),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(variable) &&
      forbidden.every((text) => text.length > 0 && !error.message.includes(text)),
  );
}

test('a valid group-readable REDIS_PASSWORD_FILE is read', () => {
  withDirectory((directory) => {
    const password = randomBytes(24).toString('hex');
    const file = join(directory, 'redis-password');
    writeFileSync(file, `${password}\n`, { mode: 0o440 });
    assert.equal(
      new URL(configuration({ ...base, REDIS_PASSWORD_FILE: file }).REDIS_URL).password,
      password,
    );
  });
});

test('a symlinked secret file is refused for REDIS_PASSWORD_FILE and the OTP files', (context) => {
  withDirectory((directory) => {
    const password = randomBytes(24).toString('hex');
    const target = join(directory, 'real');
    const link = join(directory, 'link');
    writeFileSync(target, `${password}\n`, { mode: 0o600 });
    try {
      symlinkSync(target, link);
    } catch {
      context.skip('symlinks are not permitted on this host');
      return;
    }
    refused({ ...base, REDIS_PASSWORD_FILE: link }, 'REDIS_PASSWORD_FILE', [password, directory]);
    refused(
      {
        ...base,
        DEPLOYMENT_ENVIRONMENT: 'production',
        APP_ORIGIN: 'https://careerscope.tech',
        EMAIL_OTP_ENABLED: 'true',
        EMAIL_OTP_HMAC_SECRET_FILE: link,
      },
      'EMAIL_OTP_HMAC_SECRET_FILE',
      [password, directory],
    );
  });
});

test('REDIS_PASSWORD_FILE is validated even when the URLs carry a password, and its value is used only for URLs without one', () => {
  withDirectory((directory) => {
    const filePassword = randomBytes(24).toString('hex');
    const urlPassword = randomBytes(24).toString('hex');
    const file = join(directory, 'redis-password');
    const carrying = {
      ...base,
      REDIS_URL: `redis://:${urlPassword}@127.0.0.1:6379`,
      QUEUE_REDIS_URL: `redis://:${urlPassword}@127.0.0.1:6380`,
    };
    writeFileSync(file, `${filePassword}\n`, { mode: 0o600 });
    const env = configuration({ ...carrying, REDIS_PASSWORD_FILE: file });
    assert.equal(new URL(env.REDIS_URL).password, urlPassword);
    assert.equal(new URL(env.QUEUE_REDIS_URL).password, urlPassword);
    // Only the URL without a password takes the file's value.
    const mixed = configuration({
      ...carrying,
      QUEUE_REDIS_URL: base.QUEUE_REDIS_URL,
      REDIS_PASSWORD_FILE: file,
    });
    assert.equal(new URL(mixed.REDIS_URL).password, urlPassword);
    assert.equal(new URL(mixed.QUEUE_REDIS_URL).password, filePassword);
    // A malformed file still fails startup although every URL already has a password.
    writeFileSync(file, 'short\n', { mode: 0o600 });
    refused({ ...carrying, REDIS_PASSWORD_FILE: file }, 'REDIS_PASSWORD_FILE', [urlPassword]);
    refused(
      { ...carrying, REDIS_PASSWORD_FILE: join(directory, 'absent') },
      'REDIS_PASSWORD_FILE',
      [urlPassword],
    );
  });
});

test('an oversized secret file is refused without echoing its content', () => {
  withDirectory((directory) => {
    const file = join(directory, 'big');
    const content = 'a'.repeat(5000);
    writeFileSync(file, content, { mode: 0o600 });
    refused({ ...base, REDIS_PASSWORD_FILE: file }, 'REDIS_PASSWORD_FILE', [
      content.slice(0, 64),
      directory,
    ]);
  });
});

test('a multi-token secret file is refused without echoing its content', () => {
  withDirectory((directory) => {
    const file = join(directory, 'two');
    const first = randomBytes(12).toString('hex');
    const second = randomBytes(12).toString('hex');
    writeFileSync(file, `${first} ${second}\n`, { mode: 0o600 });
    refused({ ...base, REDIS_PASSWORD_FILE: file }, 'REDIS_PASSWORD_FILE', [
      first,
      second,
      directory,
    ]);
  });
});

test('a secret file writable by group or others is refused on POSIX', (context) => {
  if (process.platform === 'win32') {
    context.skip('POSIX permission bits do not exist on Windows');
    return;
  }
  withDirectory((directory) => {
    const password = randomBytes(24).toString('hex');
    const file = join(directory, 'redis-password');
    writeFileSync(file, `${password}\n`);
    chmodSync(file, 0o660);
    refused({ ...base, REDIS_PASSWORD_FILE: file }, 'REDIS_PASSWORD_FILE', [password, directory]);
  });
});

test('a secret file in a group- or world-writable directory is refused on POSIX', (context) => {
  if (process.platform === 'win32') {
    context.skip('POSIX permission bits do not exist on Windows');
    return;
  }
  withDirectory((directory) => {
    const password = randomBytes(24).toString('hex');
    const file = join(directory, 'redis-password');
    writeFileSync(file, `${password}\n`);
    chmodSync(file, 0o640);
    chmodSync(directory, 0o777);
    try {
      refused({ ...base, REDIS_PASSWORD_FILE: file }, 'REDIS_PASSWORD_FILE', [password, directory]);
    } finally {
      chmodSync(directory, 0o700);
    }
  });
});

test('a missing secret file error names only the variable', () => {
  withDirectory((directory) => {
    refused({ ...base, REDIS_PASSWORD_FILE: join(directory, 'absent') }, 'REDIS_PASSWORD_FILE', [
      directory,
    ]);
  });
});
