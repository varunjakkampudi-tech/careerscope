import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { setupAdminSecret } from './setup-admin-secret.mjs';

test('generates a local secret, preserves configuration, restricts permissions and never overwrites it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-secret-test-'));
  const path = join(directory, '.env');
  try {
    await writeFile(path, 'DATA_DIR=./data\nADMIN_SNAPSHOT_PASSPHRASE=\n');
    await setupAdminSecret(path);
    const contents = await readFile(path, 'utf8');
    const values = parseEnv(contents);
    assert.equal(values.DATA_DIR, './data');
    assert.match(values.ADMIN_SNAPSHOT_PASSPHRASE, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(setupAdminSecret(path));
    assert.equal(await readFile(path, 'utf8'), contents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
