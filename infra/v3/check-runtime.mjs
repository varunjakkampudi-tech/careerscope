import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import JSZip from 'jszip';

const { fetch, AbortSignal } = globalThis;
assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
const execute = promisify(execFile);
const project = `careerscope-v3-test-${randomUUID().replaceAll('-', '')}`;
const directory = await mkdtemp(join(tmpdir(), 'careerscope-v3-acceptance-'));
const emptyEnv = join(directory, 'empty.env');
await writeFile(emptyEnv, '', { mode: 0o600 });
const listener = createServer();
await new Promise((resolve, reject) => {
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', resolve);
});
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://localhost:${port}`;
const databasePassword = randomBytes(24).toString('hex');
const env = { ...process.env, V3_TEST_PASSWORD: databasePassword, V3_TEST_PORT: String(port) };
const compose = [
  'compose',
  '--env-file',
  emptyEnv,
  '-p',
  project,
  '-f',
  fileURLToPath(new URL('./compose.acceptance.yml', import.meta.url)),
];

async function docker(args, timeout = 180000) {
  try {
    return (await execute('docker', args, { env, timeout, maxBuffer: 1024 * 1024 })).stdout.trim();
  } catch (error) {
    throw new Error(
      String(error.stderr || error.message).replaceAll(databasePassword, '[redacted]'),
    );
  }
}

async function request(path, { cookie, csrf, method = 'GET', body, raw = false } = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(body ? { 'content-type': raw ? 'application/octet-stream' : 'application/json' } : {}),
      ...(raw ? { 'idempotency-key': randomUUID() } : {}),
    },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  return response;
}

async function login(email, password) {
  const response = await request('/login', { method: 'POST', body: { email, password } });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie()[0].split(';')[0];
  const session = await request('/session', { cookie });
  const data = await session.json();
  assert.equal(data.authenticated, true);
  return { cookie, csrf: data.csrf };
}

async function privateKeyIdentity() {
  const apiId = await docker([...compose, 'ps', '-q', 'api']);
  return docker([
    'exec',
    apiId,
    'node',
    '--input-type=module',
    '-e',
    `
    import { createHash } from 'node:crypto';
    import { readFile, stat } from 'node:fs/promises';
    const path = '/private/encryption.key';
    console.log(JSON.stringify({ inode: (await stat(path)).ino, hash: createHash('sha256').update(await readFile(path)).digest('hex') }));
  `,
  ]);
}

async function eventually(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(200);
  }
  assert.fail(message);
}

try {
  await docker([...compose, 'config', '--quiet']);
  await docker([...compose, 'up', '-d', '--no-build', '--wait', '--wait-timeout', '120']);
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/resumes')).status, 401);
  const page = await fetch(origin, { signal: AbortSignal.timeout(10000) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /CareerScope/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const password = randomUUID();
  for (const email of ['owner@example.test', 'foreign@example.test']) {
    assert.equal(
      (await request('/register', { method: 'POST', body: { email, password } })).status,
      202,
    );
  }
  const owner = await login('owner@example.test', password);
  const foreign = await login('foreign@example.test', password);
  const secondary = await login('owner@example.test', password);
  assert.equal(
    (await request('/account/sessions/revoke-others', { ...owner, method: 'POST', body: {} }))
      .status,
    204,
  );
  assert.equal((await request('/profile', secondary)).status, 401);
  assert.equal((await request('/profile', owner)).status, 200);
  assert.equal((await request('/profile', foreign)).status, 200);
  const redisId = await docker([...compose, 'ps', '-q', 'redis']);
  try {
    await docker(['exec', redisId, 'redis-cli', 'CONFIG', 'SET', 'maxmemory', '1']);
    assert.match(
      await docker(['exec', redisId, 'redis-cli', 'SET', 'synthetic-pressure', '1']),
      /OOM/,
    );
    assert.equal(
      (await request('/login', { method: 'POST', body: { email: 'owner@example.test', password } }))
        .status,
      500,
    );
    assert.equal((await request('/profile', owner)).status, 200);
  } finally {
    await docker(['exec', redisId, 'redis-cli', 'CONFIG', 'SET', 'maxmemory', '64mb']);
  }
  await login('owner@example.test', password);
  const archive = new JSZip();
  archive.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  archive.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Candidate React TypeScript engineer building accessible interfaces with several years of experience.</w:t></w:r></w:p></w:body></w:document>',
  );
  const document = await archive.generateAsync({ type: 'nodebuffer' });
  const postgresId = await docker([...compose, 'ps', '-q', 'postgres']);
  const sql = (query) =>
    docker([
      'exec',
      postgresId,
      'psql',
      '-U',
      'careerscope',
      '-d',
      'careerscope',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      query,
    ]);
  await sql(`
    CREATE FUNCTION acceptance_pause_result() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(7654321); RETURN NEW; END $$;
    CREATE TRIGGER acceptance_pause BEFORE INSERT ON resume_results
    FOR EACH ROW EXECUTE FUNCTION acceptance_pause_result();
  `);
  const gate = sql(
    "SET application_name = 'acceptance-gate'; SELECT pg_advisory_lock(7654321); SELECT pg_sleep(90)",
  ).then(
    () => true,
    () => false,
  );
  await eventually(
    async () =>
      (await sql(
        "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=7654321 AND granted",
      )) === '1',
    'Result gate was not acquired',
  );
  const uploaded = await request('/resumes', {
    ...owner,
    method: 'POST',
    body: document,
    raw: true,
  });
  assert.equal(uploaded.status, 202);
  const upload = await uploaded.json();
  await eventually(
    async () =>
      (await sql(
        "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=7654321 AND NOT granted",
      )) === '1',
    'Parser did not reach its result commit',
  );
  const filesId = await docker([...compose, 'ps', '-q', 'files']);
  await docker(['kill', '--signal', 'KILL', filesId]);
  await sql(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='acceptance-gate'",
  );
  await gate;
  await sql(
    'DROP TRIGGER acceptance_pause ON resume_results; DROP FUNCTION acceptance_pause_result()',
  );
  assert.equal(
    await sql('SELECT count(*) FROM resume_results'),
    '0',
    'Interrupted result must roll back',
  );
  await docker([...compose, 'start', 'files']);
  const deadline = Date.now() + 150000;
  let parsed;
  while (Date.now() < deadline) {
    const response = await request(`/resumes/${upload.id}`, owner);
    assert.equal(response.status, 200);
    parsed = await response.json();
    if (parsed.status === 'parsed' || parsed.status === 'rejected') break;
    await delay(200);
  }
  assert.equal(parsed.status, 'parsed');
  assert.equal(await sql('SELECT count(*) FROM resume_results'), '1');
  assert.equal(await sql('SELECT count(*) FROM outbox_events'), '1');
  assert.equal(
    await sql("SELECT count(*) FROM command_executions WHERE status='completed' AND fence >= 2"),
    '1',
    'Recovery must reclaim the expired execution lease',
  );
  process.stdout.write(
    'SIGKILL during parser result commit rolled back; redelivery recovered one fenced result\n',
  );
  assert.ok(parsed.result.parsed.derived.techStack.includes('React'));
  assert.equal((await request(`/resumes/${upload.id}`, foreign)).status, 404);
  const ids = (await docker([...compose, 'ps', '-a', '-q'])).split(/\s+/);
  const configurations = JSON.parse(await docker(['inspect', ...ids]));
  assert.equal(configurations.length, 10);
  for (const container of configurations) {
    const service = container.Config.Labels['com.docker.compose.service'];
    assert.equal(container.HostConfig.ReadonlyRootfs, true, service);
    assert.ok(container.HostConfig.CapDrop.includes('ALL'), service);
    assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges:true'), service);
    assert.ok(
      container.Config.User && !['0', 'root', '0:0'].includes(container.Config.User),
      service,
    );
    assert.ok(container.HostConfig.Memory > 0, service);
    assert.ok(container.HostConfig.PidsLimit > 0, service);
    if (service !== 'proxy')
      assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length, 0);
    else
      assert.deepEqual(container.HostConfig.PortBindings['8080/tcp'], [
        { HostIp: '127.0.0.1', HostPort: String(port) },
      ]);
  }
  process.stdout.write(
    'Account, encrypted upload, real parser, owner isolation and container hardening passed\n',
  );
  const keyBefore = await privateKeyIdentity();
  await docker([...compose, 'down', '--timeout', '20']);
  await docker([...compose, 'up', '-d', '--no-build', '--wait', '--wait-timeout', '120']);
  assert.ok(
    (await privateKeyIdentity()) === keyBefore,
    'Stack recreation must preserve the key inode and content',
  );
  assert.equal((await (await request('/session', owner)).json()).authenticated, true);
  assert.equal((await (await request(`/resumes/${upload.id}`, owner)).json()).status, 'parsed');
  const apiId = await docker([...compose, 'ps', '-q', 'api']);
  const expectedHash = createHash('sha256').update(document).digest('hex');
  await docker([
    'exec',
    apiId,
    'node',
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { readFile, readdir } from 'node:fs/promises';
    import JSZip from 'jszip';
    import { Database, configuredFileResumeStorage } from '@careerscope/core';
    const database = new Database(process.env.DATABASE_URL);
    const storage = await configuredFileResumeStorage();
    try {
      const record = (await database.pool.query('SELECT * FROM resume_uploads WHERE id = $1', [${JSON.stringify(upload.id)}])).rows[0];
      const body = await storage.get({ ownerId: record.owner_id, resumeId: record.id, sha256: record.sha256, bytes: record.bytes, contentType: record.content_type }, record.object_version);
      assert.equal(createHash('sha256').update(body).digest('hex'), ${JSON.stringify(expectedHash)});
      const filenames = await readdir('/private/objects');
      assert.equal(filenames.length, 1);
      const envelope = await readFile('/private/objects/' + filenames[0]);
      assert.equal(envelope.includes(body), false);
      assert.equal(envelope.includes(Buffer.from('Synthetic Candidate')), false);
      await assert.rejects(JSZip.loadAsync(envelope));
    } finally { storage.close(); await database.close(); }
  `,
  ]);
  const newPassword = randomUUID();
  assert.equal(
    (
      await request('/account/password', {
        ...owner,
        method: 'POST',
        body: { currentPassword: password, newPassword },
      })
    ).status,
    204,
  );
  assert.equal((await request('/profile', owner)).status, 401);
  assert.equal((await request('/profile', foreign)).status, 200);
  const renewed = await login('owner@example.test', newPassword);
  assert.equal(
    (await request(`/resumes/${upload.id}`, { ...renewed, method: 'DELETE' })).status,
    204,
  );
  assert.equal((await request(`/resumes/${upload.id}`, renewed)).status, 404);
  process.stdout.write(
    'Stack recreation preserved session, database, encrypted object/key and parsed result; password revocation and deletion passed\n',
  );
} catch (error) {
  const logs = await docker([...compose, 'logs', '--no-color', '--tail', '20']).catch(
    () => 'Container logs unavailable',
  );
  const failures = logs
    .split('\n')
    .filter((line) =>
      /error|denied|read-only|exception|traceback|cannot|failed|npm warn/i.test(line),
    );
  process.stderr.write(failures.join('\n').replaceAll(databasePassword, '[redacted]') + '\n');
  throw error;
} finally {
  await docker([...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '20']);
  await rm(directory, { recursive: true, force: true });
}
