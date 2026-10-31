#!/usr/bin/env node
// Static and unit checks for the production image, compose file, Redis secret rendering and the
// resume-key bootstrap. Needs only Node (no Docker). check-backup.sh runs it when node is on PATH,
// which is how CI executes it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ResumeKeyError, ensureResumeKey } from '../host/resume-key.mjs';

const infra = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(infra, path), 'utf8');
let failures = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} :: ${error.message}`);
  }
}

const withoutComments = (text) => text.replace(/^\s*#.*$/gm, '');
const dockerfile = withoutComments(read('docker/Dockerfile'));
const compose = read('docker/compose.production.yml');
const bootstrap = read('host/bootstrap.mjs');

await check('Dockerfile pins every Go module to an exact version', () => {
  const lines = dockerfile.split('\n').filter((line) => /\bgo get\b/.test(line));
  assert.ok(lines.length >= 3, 'expected go get lines');
  assert.equal(/@latest|@master|@main/.test(dockerfile), false, 'no floating module versions');
  for (const line of lines) {
    const modules = line
      .replace(/.*\bgo get\b/, '')
      .replace(/[\s\x5c]+$/, '')
      .trim();
    for (const module of modules.split(/\s+/)) {
      assert.match(module, /@v\d+\.\d+\.\d+$/, `${module} must be an exact release`);
    }
  }
});

await check('Dockerfile runs no unpinned apt upgrade', () => {
  assert.equal(/apt-get\s+(dist-)?upgrade/.test(dockerfile), false);
});

await check('Dockerfile installs only exact-version apk packages and no apk upgrade', () => {
  assert.equal(/apk\s+upgrade/.test(dockerfile), false);
  assert.equal(/apt-get\s+install/.test(dockerfile), false, 'build stage installs no OS packages');
  const adds = dockerfile.split('\n').filter((line) => /\bapk add\b/.test(line));
  assert.ok(adds.length > 0);
  for (const line of adds) {
    const packages = line
      .replace(/.*\bapk add\b/, '')
      .replace(/--\S+/g, '')
      .replace(/[\s\x5c]+$/, '')
      .trim();
    for (const name of packages.split(/\s+/)) {
      assert.match(name, /^[a-z0-9._+-]+=[^=\s]+$/, `${name} must be pinned`);
    }
  }
});

await check('app services get the Redis password from a file, not from the URL', () => {
  const body = withoutComments(compose);
  assert.equal(/redis:\/\/:/.test(body), false, 'no password inside a Redis URL');
  assert.match(body, /REDIS_PASSWORD_FILE: \/run\/secrets\/redis-password/);
  assert.equal((body.match(/secrets: \[redis-password\]/g) ?? []).length, 3);
});

await check(
  'OTP secrets are files mounted into the api service only, never environment values',
  () => {
    const body = withoutComments(compose);
    assert.equal(/^\s+(EMAIL_OTP_HMAC_SECRET|RESEND_API_KEY):/m.test(body), false);
    assert.match(body, /EMAIL_OTP_ENABLED: 'true'/);
    assert.match(body, /RESEND_FROM_EMAIL: 'CareerScope <noreply@careerscope.tech>'/);
    assert.match(body, /EMAIL_OTP_HMAC_SECRET_FILE: \/run\/secrets\/email-otp-hmac-secret/);
    assert.match(body, /RESEND_API_KEY_FILE: \/run\/secrets\/resend-api-key/);
    assert.equal(
      (body.match(/secrets: \[redis-password, email-otp-hmac-secret, resend-api-key\]/g) ?? [])
        .length,
      1,
    );
    const others = body.slice(body.indexOf('\n  publisher:'), body.indexOf('\nsecrets:'));
    assert.equal(/EMAIL_OTP_HMAC_SECRET_FILE|resend-api-key/.test(others), false);
  },
);

await check(
  'the backup freshness check has a timer and a sandboxed unit, installed by setup-backup.sh',
  () => {
    const service = withoutComments(read('systemd/careerscope-backup-check.service'));
    const timer = read('systemd/careerscope-backup-check.timer');
    assert.match(
      service,
      /ExecStart=\/usr\/local\/bin\/careerscope-check-backup\.sh --status-only \/var\/backups\/careerscope/,
    );
    for (const line of [
      'NoNewPrivileges=yes',
      'ProtectSystem=strict',
      'ProtectHome=yes',
      'PrivateTmp=yes',
    ]) {
      assert.ok(service.includes(line), line);
    }
    assert.equal(/SuccessExitStatus/.test(service), false);
    assert.match(timer, /OnCalendar=/);
    const setup = read('host/setup-backup.sh');
    assert.match(setup, /careerscope-backup-check\.timer/);
    assert.match(setup, /systemctl enable --quiet careerscope-backup-check\.timer/);
  },
);

await check('compose images are explicit required variables, not mutable local tags', () => {
  const images = compose.split('\n').filter((line) => /^\s*image:/.test(line));
  assert.equal(/careerscope:v\d/.test(withoutComments(compose)), false);
  assert.equal(images.filter((line) => line.includes('${CAREERSCOPE_IMAGE:?')).length, 2);
  assert.equal(images.filter((line) => line.includes('${CAREERSCOPE_PROXY_IMAGE:?')).length, 2);
});

await check(
  'Redis password is not a command-line argument or container environment variable',
  () => {
    const body = withoutComments(compose);
    assert.equal(body.includes('--requirepass'), false);
    assert.equal(body.includes('REDISCLI_AUTH:'), false);
    assert.match(body, /secrets:\s*\n\s+redis-config:\s*\n\s+file:/);
    assert.equal((body.match(/source: redis(-queue)?-config/g) ?? []).length, 2);
  },
);

await check('bootstrap writes the key through ensureResumeKey, not a bare exclusive create', () => {
  assert.match(bootstrap, /ensureResumeKey\('\/private\/encryption\.key'\)/);
  assert.equal(/open\([^)]*'wx'/.test(bootstrap), false);
  assert.ok(/host\/resume-key\.mjs:\/app\/resume-key\.mjs:ro/.test(compose));
});

const scratch = mkdtempSync(join(tmpdir(), 'cs-config-check-'));
const keyPath = (name) => join(scratch, name);
const posix = process.platform !== 'win32';

await check('a new key is complete 64-hex, private, and leaves no temporary file', async () => {
  const path = keyPath('created.key');
  assert.equal(await ensureResumeKey(path), 'created');
  assert.match(readFileSync(path, 'utf8'), /^[a-f0-9]{64}$/);
  if (posix) assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(scratch).filter((name) => name.startsWith('created.key.')),
    [],
  );
});

await check('an existing valid key is kept byte for byte', async () => {
  const path = keyPath('keep.key');
  await ensureResumeKey(path);
  const before = readFileSync(path, 'utf8');
  assert.equal(await ensureResumeKey(path), 'existing');
  assert.equal(readFileSync(path, 'utf8'), before);
});

await check(
  'a leftover partial temporary file from a crash does not block or become the key',
  async () => {
    const path = keyPath('crash.key');
    const stale = `${path}.tmp-1-old`;
    writeFileSync(stale, 'deadbeef');
    const longAgo = new Date(Date.now() - 3_600_000);
    utimesSync(stale, longAgo, longAgo);
    assert.equal(await ensureResumeKey(path), 'created');
    assert.match(readFileSync(path, 'utf8'), /^[a-f0-9]{64}$/);
    assert.equal(existsSync(stale), false, 'a stale temporary is removed');
  },
);

const badKeys = [
  ['empty', '', /empty/],
  ['truncated', 'abcdef0123', /truncated or malformed \(10 bytes/],
  ['non-hex', 'z'.repeat(64), /truncated or malformed/],
];
for (const [label, content, pattern] of badKeys) {
  await check(`a ${label} key file is reported to the operator and never overwritten`, async () => {
    const path = keyPath(`${label}.key`);
    writeFileSync(path, content);
    await assert.rejects(ensureResumeKey(path), (error) => {
      assert.ok(error instanceof ResumeKeyError);
      assert.match(error.message, pattern);
      assert.match(error.message, /Restore the matching key copy/);
      assert.equal(content.length > 0 && error.message.includes(content), false);
      return true;
    });
    assert.equal(readFileSync(path, 'utf8'), content);
  });
}

await check('concurrent first starts converge on one valid key', async () => {
  const path = keyPath('race.key');
  const results = await Promise.all([
    ensureResumeKey(path),
    ensureResumeKey(path),
    ensureResumeKey(path),
  ]);
  assert.ok(results.includes('created'));
  assert.match(readFileSync(path, 'utf8'), /^[a-f0-9]{64}$/);
});

await check('render-redis-config.sh writes password files and rejects a weak password', () => {
  const script = join(infra, 'host/render-redis-config.sh');
  if (spawnSync('bash', ['-c', 'exit 0']).error) return console.log('SKIP no bash available');
  const secrets = join(scratch, 'secrets');
  const envFile = join(scratch, 'env');
  const password = 'placeholder0123456789abcdef';
  writeFileSync(envFile, `POSTGRES_PASSWORD=unrelated\nREDIS_PASSWORD=${password}\n`);
  const env = { ...process.env, CAREERSCOPE_SECRETS_DIR: secrets };
  const run = spawnSync('bash', [script, envFile], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  for (const name of ['redis.conf', 'redis-queue.conf']) {
    assert.equal(readFileSync(join(secrets, name), 'utf8'), `requirepass ${password}\n`);
  }
  assert.equal(run.stdout.includes(password) || run.stderr.includes(password), false);
  if (posix) assert.equal(statSync(secrets).mode & 0o777, 0o700);
  writeFileSync(envFile, 'REDIS_PASSWORD=short\n');
  const weak = spawnSync('bash', [script, envFile], { env, encoding: 'utf8' });
  assert.notEqual(weak.status, 0);
});

await check(
  'render-otp-secrets.sh writes the files, generates the HMAC secret and rejects bad values',
  () => {
    const script = join(infra, 'host/render-otp-secrets.sh');
    if (spawnSync('bash', ['-c', 'exit 0']).error) return console.log('SKIP no bash available');
    if (spawnSync('openssl', ['version']).error) return console.log('SKIP no openssl available');
    const secrets = join(scratch, 'otp-secrets');
    const envFile = join(scratch, 'otp-env');
    const resend = 're_placeholder0123456789abcdef';
    const env = { ...process.env, CAREERSCOPE_SECRETS_DIR: secrets };
    const run = (text) => {
      writeFileSync(envFile, text);
      return spawnSync('bash', [script, envFile], { env, encoding: 'utf8' });
    };
    const ok = run(`RESEND_API_KEY=${resend}\n`);
    assert.equal(ok.status, 0, ok.stderr);
    const generated = readFileSync(envFile, 'utf8').match(
      /^EMAIL_OTP_HMAC_SECRET=([0-9a-f]{64})$/m,
    );
    assert.ok(generated, 'a 64-hex HMAC secret is generated into the env file');
    assert.equal(readFileSync(join(secrets, 'email-otp-hmac-secret'), 'utf8'), `${generated[1]}\n`);
    assert.equal(readFileSync(join(secrets, 'resend-api-key'), 'utf8'), `${resend}\n`);
    assert.equal(
      [ok.stdout, ok.stderr].some((text) => text.includes(generated[1]) || text.includes(resend)),
      false,
    );
    if (posix) assert.equal(statSync(secrets).mode & 0o777, 0o700);
    const counter = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join('');
    const bad = [
      `EMAIL_OTP_HMAC_SECRET=${'ab'.repeat(32)}\nRESEND_API_KEY=${resend}\n`,
      `EMAIL_OTP_HMAC_SECRET=${counter}\nRESEND_API_KEY=${resend}\n`,
      `EMAIL_OTP_HMAC_SECRET=${generated[1]}\n`,
      `EMAIL_OTP_HMAC_SECRET=${generated[1]}\nRESEND_API_KEY=short\n`,
    ];
    for (const text of bad) {
      const refused = run(text);
      assert.notEqual(refused.status, 0);
      assert.equal(
        refused.stderr.includes(generated[1]) || refused.stderr.includes('ababab'),
        false,
      );
    }
  },
);

rmSync(scratch, { recursive: true, force: true });
if (failures > 0) {
  console.error(`${failures} production config check(s) failed`);
  process.exit(1);
}
console.log('all production config checks passed');
