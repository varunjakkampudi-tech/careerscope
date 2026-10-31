#!/usr/bin/env node
// Static and unit checks for the production image, compose file, Redis secret rendering and the
// resume-key bootstrap. Needs only Node (no Docker). CI runs it directly.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

await check('Dockerfile builds the proxy from committed, exactly pinned Go modules', () => {
  assert.equal(/@latest|@master|@main/.test(dockerfile), false, 'no floating module versions');
  assert.match(dockerfile, /GOFLAGS=-mod=readonly/, 'the build must not update go.mod or go.sum');
  assert.match(
    dockerfile,
    /COPY infra\/docker\/caddy-proxy\/go\.mod infra\/docker\/caddy-proxy\/go\.sum/,
  );
  const goMod = read('docker/caddy-proxy/go.mod');
  assert.ok(read('docker/caddy-proxy/go.sum').length > 0, 'go.sum must be committed');
  const requires = [...goMod.matchAll(/^\s*(?:require\s+)?([\w./-]+)\s+(v\S+)/gm)]
    .filter((match) => !['module', 'go', 'toolchain'].includes(match[1]))
    .map((match) => match[2]);
  assert.ok(requires.length >= 3, 'expected pinned requirements in go.mod');
  for (const version of requires) {
    assert.match(version, /^v\d+\.\d+\.\d+/, `${version} must be an exact release`);
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

await check(
  'file-secret renderers set restrictive modes, ownership and a private directory',
  () => {
    const redis = read('host/render-redis-config.sh');
    const otp = read('host/render-otp-secrets.sh');
    for (const [name, text] of [
      ['render-redis-config.sh', redis],
      ['render-otp-secrets.sh', otp],
    ]) {
      const code = withoutComments(text);
      assert.match(code, /^umask 077$/m, `${name} must set umask 077`);
      assert.match(code, /chmod 0700 "\$out_dir"/, `${name} must make the secrets directory 0700`);
      assert.match(
        code,
        /chown 999:1000 "\$target\.tmp"/,
        `${name} must hand root files to 999:1000`,
      );
      assert.match(code, /chmod 0444 "\$target\.tmp"/, `${name} non-root fallback must be 0444`);
      const modes = [...code.matchAll(/chmod\s+([0-7]{3,4})\b/g)].map((match) => match[1]);
      for (const mode of modes) {
        assert.equal(
          parseInt(mode, 8) & 0o022,
          0,
          `${name} chmod ${mode} is writable by group or others`,
        );
      }
      assert.ok(
        code.indexOf('chmod 0') < code.indexOf('mv -f "$target.tmp" "$target"'),
        `${name} must set the mode before the file is renamed into place`,
      );
    }
    const redisCode = withoutComments(redis);
    assert.match(
      redisCode,
      /chmod 0400 "\$target\.tmp"/,
      'redis.conf files are 0400 when root-written',
    );
    assert.match(
      redisCode,
      /chmod 0440 "\$target\.tmp"/,
      'redis-password is 0440 when root-written',
    );
    assert.match(
      withoutComments(otp),
      /chmod 0440 "\$target\.tmp"/,
      'OTP files are 0440 when root-written',
    );
  },
);

await check(
  'rendered secret files are never writable by group or others and leave no temporary',
  () => {
    if (!posix) return console.log('SKIP POSIX modes are not kept on this filesystem');
    if (spawnSync('bash', ['-c', 'exit 0']).error) return console.log('SKIP no bash available');
    const secrets = join(scratch, 'mode-secrets');
    const envFile = join(scratch, 'mode-env');
    writeFileSync(
      envFile,
      'REDIS_PASSWORD=placeholder0123456789abcdef\nRESEND_API_KEY=re_placeholder0123456789abcdef\n',
    );
    const env = { ...process.env, CAREERSCOPE_SECRETS_DIR: secrets };
    for (const script of ['render-redis-config.sh', 'render-otp-secrets.sh']) {
      const args = [join(infra, 'host', script), envFile];
      const run = spawnSync('bash', args, { env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
    }
    assert.equal(statSync(secrets).mode & 0o777, 0o700);
    const names = readdirSync(secrets).sort();
    assert.deepEqual(names, [
      'email-otp-hmac-secret',
      'redis-password',
      'redis-queue.conf',
      'redis.conf',
      'resend-api-key',
    ]);
    for (const name of names) {
      const mode = statSync(join(secrets, name)).mode & 0o777;
      assert.equal(mode & 0o022, 0, `${name} must not be writable by group or others`);
      assert.ok(
        [0o400, 0o440, 0o444].includes(mode),
        `${name} has unexpected mode ${mode.toString(8)}`,
      );
    }
  },
);

await check('.env.secrets is excluded from git and from the Docker build context', () => {
  const root = resolve(infra, '..');
  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/);
  const dockerignore = readFileSync(join(root, '.dockerignore'), 'utf8').split(/\r?\n/);
  const patterns = ['.env.*', '**/.env.*', '.env.secrets', '.env.secrets/', 'infra/.env.secrets'];
  const covers = (lines) => lines.some((line) => patterns.includes(line.trim()));
  assert.ok(covers(gitignore), '.gitignore must cover .env.secrets');
  assert.ok(covers(dockerignore), '.dockerignore must cover .env.secrets');
  const args = ['check-ignore', '-q', 'infra/.env.secrets/redis-password'];
  const git = spawnSync('git', args, { cwd: root });
  if (git.error || git.status === null || git.status > 1)
    return console.log('SKIP git unavailable');
  assert.equal(git.status, 0, 'git must report infra/.env.secrets/ as ignored');
});

await check('workers load configuration without the OTP secrets; the api does not', () => {
  const root = resolve(infra, '..');
  const call = /configuration\(\s*process\.env,\s*\{\s*emailOtpSecrets:\s*false\s*\}\s*\)/;
  for (const file of ['main', 'files', 'publisher']) {
    const path = join(root, `apps/workers/search/src/${file}.ts`);
    const text = withoutComments(readFileSync(path, 'utf8'));
    assert.match(text, call, `${file}.ts must pass { emailOtpSecrets: false }`);
  }
  const apiDir = join(root, 'apps/api/src');
  const apiCode = readdirSync(apiDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => withoutComments(readFileSync(join(apiDir, name), 'utf8')))
    .join('\n');
  assert.equal(
    /emailOtpSecrets:\s*false/.test(apiCode),
    false,
    'the api must load the OTP secrets',
  );
  const files = compose.match(/EMAIL_OTP_HMAC_SECRET_FILE|RESEND_API_KEY_FILE/g) ?? [];
  assert.equal(files.length, 2, 'only the api service receives the OTP secret files');
});

await check('secretFromFile and REDIS_PASSWORD_FILE use the hardened reader', async () => {
  const root = resolve(infra, '..');
  const source = withoutComments(readFileSync(join(root, 'packages/core/src/runtime.ts'), 'utf8'));
  assert.equal(/readFileSync/.test(source), false, 'runtime.ts must not use a bare readFileSync');
  assert.match(source, /lstatSync\(path\)/);
  assert.match(source, /isFile\(\)/);
  assert.match(source, /isSymbolicLink\(\)/);
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /SECRET_FILE_MAX_BYTES = 4096/);
  assert.match(source, /readSecretFile\('REDIS_PASSWORD_FILE'/);
  assert.match(source, /process\.platform !== 'win32'/);
  // Behaviour, against the built output when it exists (npm run build:core).
  const built = join(root, 'packages/core/dist/runtime.js');
  if (!existsSync(built)) return console.log('SKIP packages/core is not built');
  const loaded = await import(pathToFileURL(built).href).catch((error) => error);
  if (loaded instanceof Error)
    return console.log('SKIP packages/core dependencies are not installed');
  const { configuration } = loaded;
  const base = {
    DATABASE_URL: 'postgres://127.0.0.1/test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    QUEUE_REDIS_URL: 'redis://127.0.0.1:6380',
    APP_ORIGIN: 'http://localhost:5280',
  };
  const secret = 'placeholder0123456789abcdef';
  const file = join(scratch, 'redis-file-secret');
  const refuse = (content, why) => {
    writeFileSync(file, content, { mode: 0o600 });
    const fragment = content.trim().slice(0, 24);
    assert.throws(
      () => configuration({ ...base, REDIS_PASSWORD_FILE: file }),
      (error) =>
        error.message.includes('REDIS_PASSWORD_FILE') &&
        !error.message.includes(fragment) &&
        !error.message.includes(scratch),
      why,
    );
  };
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  const accepted = configuration({ ...base, REDIS_PASSWORD_FILE: file });
  assert.equal(new URL(accepted.REDIS_URL).password, secret);
  refuse('a'.repeat(5000), 'oversized');
  refuse(`${secret} ${secret}2\n`, 'multi-token');
  const link = join(scratch, 'redis-file-link');
  try {
    symlinkSync(file, link);
  } catch (error) {
    if (error.code === 'EPERM') return console.log('SKIP symlinks are not permitted here');
    throw error;
  }
  assert.throws(() => configuration({ ...base, REDIS_PASSWORD_FILE: link }), /REDIS_PASSWORD_FILE/);
});

rmSync(scratch, { recursive: true, force: true });
if (failures > 0) {
  console.error(`${failures} production config check(s) failed`);
  process.exit(1);
}
console.log('all production config checks passed');
