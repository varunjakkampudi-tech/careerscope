import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

const check = String.raw`
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync, backup } from 'node:sqlite';
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';

const origin = 'http://localhost:8080';
let server;
async function start() {
  server = spawn('/usr/local/bin/docker-entrypoint.sh', ['node', '/app/apps/api/dist/index.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Container startup timed out')), 30000);
    server.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited before readiness')); });
    server.once('error', reject);
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Server listening')) { clearTimeout(timer); resolve(); }
    });
  });
}
async function stop() {
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  const [code] = await exited;
  assert.equal(code, 0);
}
const request = (path, options = {}) => fetch(origin + path, {
  ...options, signal: AbortSignal.timeout(15000),
});
try {
  assert.notEqual(process.getuid(), 0);
  assert.throws(() => writeFileSync('/app/readonly-probe', 'fixture'));
  const nonInteractive = spawnSync('node', ['/app/apps/api/dist/setup-owner.js'], { encoding: 'utf8' });
  assert.equal(nonInteractive.status, 1);
  assert.match(nonInteractive.stderr, /Owner setup failed/);
  await start();
  assert.equal((await request('/api/health/ready')).status, 200);
  assert.equal((await request('/api/leads')).status, 401);
  assert.match(await (await request('/login')).text(), /id="root"/);
  const credentials = { email: 'container-test@example.com', password: randomBytes(24).toString('hex') };
  const setup = await request('/api/auth/setup', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  assert.equal(setup.status, 201);
  let cookie = setup.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/leads', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await request('/api/auth/setup', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  })).status, 409);
  assert.equal((await request('/api/auth/logout', {
    method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.example' },
  })).status, 403);
  const database = new DatabaseSync('/app/data/job-radar.db', { readOnly: true });
  await backup(database, '/app/data/backup.db');
  database.close();
  const restored = new DatabaseSync('/app/data/backup.db');
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(restored.prepare('SELECT COUNT(*) count FROM auth_owner').get().count, 1);
  restored.close();
  await stop();
  copyFileSync('/app/data/backup.db', '/app/data/job-radar.db');
  rmSync('/app/data/job-radar.db-wal', { force: true });
  rmSync('/app/data/job-radar.db-shm', { force: true });
  await start();
  assert.equal((await request('/api/leads', { headers: { Cookie: cookie } })).status, 200);
  const login = await request('/api/auth/login', {
    method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  assert.equal(login.status, 200);
  assert.equal((await request('/api/leads', { headers: { Cookie: cookie } })).status, 401);
  cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/leads', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await request('/api/auth/logout', {
    method: 'POST', headers: { Cookie: cookie, Origin: origin },
  })).status, 200);
  assert.equal((await request('/api/leads', { headers: { Cookie: cookie } })).status, 401);
  await stop();
  process.stdout.write('Container: readiness, shell, auth, CSRF, backup restore, restart persistence and session revocation passed.\n');
} finally {
  if (server && server.exitCode === null) server.kill('SIGTERM');
}
`;

const containerName = `careerscope-check-${randomUUID()}`;
try {
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      containerName,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--memory',
      '2g',
      '--cpus',
      '2',
      '--tmpfs',
      '/app/data:uid=1000,gid=1000,mode=700',
      '--tmpfs',
      '/tmp:mode=1777',
      '-e',
      'NODE_ENV=development',
      '-e',
      'AUTH_ORIGIN=http://localhost:8080',
      '-e',
      'LOGIN_ENABLED=true',
      '-e',
      'AUTH_DISABLED=false',
      '-e',
      'LOG_LEVEL=info',
      '--entrypoint',
      'node',
      process.env.CONTAINER_TEST_IMAGE ?? 'careerscope:local',
      '--input-type=module',
      '-e',
      check,
    ],
    { stdio: 'inherit', timeout: 120_000 },
  );
} finally {
  const cleanup = spawnSync('docker', ['rm', '-f', containerName], {
    stdio: 'ignore',
    timeout: 15_000,
  });
  if (cleanup.error || cleanup.status !== 0) {
    process.stderr.write(`Could not confirm cleanup of synthetic container ${containerName}.\n`);
    process.exitCode = 1;
  }
}

if (process.argv.includes('--llm')) {
  const modelCheck = String.raw`
    import assert from 'node:assert/strict';
    import { rerankLeads } from '@job-radar/matching';
    import { OllamaRerankClient } from './apps/api/dist/services/ollamaRerank.js';
    const candidate = {
      titles: ['Frontend Engineer'], yearsOfExperience: 4,
      skills: ['React', 'TypeScript'], recentSkills: ['React', 'TypeScript'],
      resumeText: 'Four years building accessible React and TypeScript interfaces and testing components.',
    };
    const item = {
      job: { id: 'fixture', title: 'Frontend Engineer', company: { name: 'Synthetic Company' },
        descriptionText: 'Build accessible React and TypeScript interfaces. Requires three years of frontend experience and component testing.' },
      match: { excludedReason: null, confidence: 'high', heuristicScore: 0.7, score: 0.7,
        llmScore: null, llmRationale: null },
    };
    const warnings = [];
    const started = Date.now();
    const result = await rerankLeads([item], candidate, {
      client: new OllamaRerankClient(process.env.OLLAMA_ORIGIN),
      model: process.env.LLM_MODEL, topN: 1, batchSize: 1, concurrency: 1,
      onWarning: (warning) => warnings.push(warning),
    });
    console.log(JSON.stringify({ elapsedMs: Date.now() - started, score: result[0].match.llmScore, warnings }));
    assert.equal(warnings.length, 0, 'Real model ranking failed; deterministic fallback is not inference success');
    assert.equal(typeof result[0].match.llmScore, 'number');
    assert.ok(result[0].match.llmScore >= 0 && result[0].match.llmScore <= 1);
    const fallback = await rerankLeads([item], candidate, {
      client: new OllamaRerankClient('http://127.0.0.1:1', 1000),
      model: process.env.LLM_MODEL,
    });
    assert.deepEqual(fallback[0].match, item.match);
    console.log('Local model: real ranking and unavailable-model fallback passed.');
  `;
  execFileSync(
    'docker',
    [
      'compose',
      '-f',
      'infra/docker-compose.local.yml',
      'exec',
      '-T',
      'api',
      'node',
      '--input-type=module',
      '-e',
      modelCheck,
    ],
    { stdio: 'inherit', timeout: 150_000 },
  );
}
