import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database, LeadRepository, users } from '@careerscope/core';
import {
  isPrivateOrReservedIp,
  classifyResponse,
  pinnedDispatcher,
  type LookupFn,
} from './check-lead-liveness.ts';

const publicLookup: LookupFn = async () => ({ address: '203.0.113.10', family: 4 });
const privateLookup: LookupFn = async () => ({ address: '10.0.0.5', family: 4 });
const unresolvableLookup: LookupFn = async () => {
  throw new Error('ENOTFOUND');
};

test('isPrivateOrReservedIp blocks loopback, RFC1918 and link-local, allows public addresses', () => {
  const blocked = [
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata endpoint - the classic SSRF target
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
  ];
  for (const ip of blocked) assert.equal(isPrivateOrReservedIp(ip), true, ip);

  const allowed = ['8.8.8.8', '1.1.1.1', '203.0.113.10', '2606:4700:4700::1111'];
  for (const ip of allowed) assert.equal(isPrivateOrReservedIp(ip), false, ip);

  // 172.15.x and 172.32.x are outside the RFC1918 172.16-172.31 block.
  assert.equal(isPrivateOrReservedIp('172.15.0.1'), false);
  assert.equal(isPrivateOrReservedIp('172.32.0.1'), false);

  // Not a recognizable IP at all - refuse rather than guess it is safe.
  assert.equal(isPrivateOrReservedIp('not-an-ip'), true);
});

test('isPrivateOrReservedIp unwraps IPv4-mapped IPv6 to the identical rule, not a separate under-covered one', () => {
  // Security review (P1): the previous version only string-matched
  // "::ffff:127." and "::ffff:10.", letting every other mapped-private range
  // - including the cloud metadata address - straight through.
  const blockedMapped = [
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.5',
    '::ffff:172.16.0.1',
    '::ffff:172.31.255.255',
    '::ffff:192.168.1.1',
    '::ffff:169.254.169.254',
    '::ffff:0.0.0.0',
  ];
  for (const ip of blockedMapped) assert.equal(isPrivateOrReservedIp(ip), true, ip);

  const allowedMapped = ['::ffff:8.8.8.8', '::ffff:203.0.113.10'];
  for (const ip of allowedMapped) assert.equal(isPrivateOrReservedIp(ip), false, ip);

  // The fully-hex form of the same mapped addresses (RFC 4291 allows both
  // ::ffff:a.b.c.d and ::ffff:XXXX:XXXX for the identical address).
  assert.equal(isPrivateOrReservedIp('::ffff:a9fe:a9fe'), true); // 169.254.169.254 in hex
  assert.equal(isPrivateOrReservedIp('::ffff:0808:0808'), false); // 8.8.8.8 in hex
});

test('pinnedDispatcher blocks a resolved-private address and reports an unresolvable hostname distinctly', async () => {
  assert.equal(await pinnedDispatcher('internal.example.test', privateLookup), 'blocked');
  assert.equal(await pinnedDispatcher('nowhere.example.test', unresolvableLookup), 'unresolvable');
  const dispatcher = await pinnedDispatcher('public.example.test', publicLookup);
  assert.notEqual(dispatcher, 'blocked');
  assert.notEqual(dispatcher, 'unresolvable');
});

test('classifyResponse: unambiguous 404/410 is stale, unambiguous 2xx is live, anything else is unknown', async () => {
  const fakeFetch = (status: number) =>
    (async () =>
      ({ status, ok: status >= 200 && status < 300, headers: new Headers() }) as never) as never;

  assert.equal(
    await classifyResponse('https://example.test', 1000, fakeFetch(404), publicLookup),
    'stale',
  );
  assert.equal(
    await classifyResponse('https://example.test', 1000, fakeFetch(410), publicLookup),
    'stale',
  );
  assert.equal(
    await classifyResponse('https://example.test', 1000, fakeFetch(200), publicLookup),
    'live',
  );
  assert.equal(
    await classifyResponse('https://example.test', 1000, fakeFetch(204), publicLookup),
    'live',
  );
  // Never assumed dead nor live: a 500 or a 403 is not a clear signal either way.
  assert.equal(
    await classifyResponse('https://example.test', 1000, fakeFetch(500), publicLookup),
    'unknown',
  );
  assert.equal(
    await classifyResponse('https://example.test', 1000, fakeFetch(403), publicLookup),
    'unknown',
  );
});

test('classifyResponse refuses to even fetch a hostname that resolves privately, or one that fails to resolve', async () => {
  let fetchCalled = false;
  const spyFetch = (async () => {
    fetchCalled = true;
    return { status: 200, ok: true, headers: new Headers() } as never;
  }) as never;
  assert.equal(
    await classifyResponse('https://internal.example.test', 1000, spyFetch, privateLookup),
    'unknown',
  );
  assert.equal(fetchCalled, false, 'a private-resolving hostname must never reach fetch at all');

  assert.equal(
    await classifyResponse('https://nowhere.example.test', 1000, spyFetch, unresolvableLookup),
    'unknown',
  );
  assert.equal(fetchCalled, false);
});

test('classifyResponse falls back from HEAD to GET only on 405, and a network error is unknown, never stale', async () => {
  const calls: string[] = [];
  const fallbackFetch = (async (_url: string, init?: { method?: string }) => {
    calls.push(String(init?.method));
    if (init?.method === 'HEAD') return { status: 405, ok: false, headers: new Headers() };
    return { status: 200, ok: true, headers: new Headers() };
  }) as never;
  assert.equal(
    await classifyResponse('https://example.test', 1000, fallbackFetch, publicLookup),
    'live',
  );
  assert.deepEqual(calls, ['HEAD', 'GET']);

  const throwingFetch = (async () => {
    throw new Error('network unreachable');
  }) as never;
  assert.equal(
    await classifyResponse('https://example.test', 1000, throwingFetch, publicLookup),
    'unknown',
  );
});

test('classifyResponse re-validates every redirect hop, not only the first URL', async () => {
  const visitedHostnames: string[] = [];
  const lookupCallsPerHost: LookupFn = async (hostname) => {
    visitedHostnames.push(hostname);
    // The second hop resolves privately - must be caught, not silently
    // followed just because the first hop was fine.
    return hostname === 'safe.example.test'
      ? { address: '203.0.113.10', family: 4 }
      : { address: '10.0.0.5', family: 4 };
  };
  const redirectingFetch = (async (url: string) => {
    if (String(url).includes('safe.example.test')) {
      return {
        status: 302,
        ok: false,
        headers: new Headers({ location: 'https://internal.example.test/' }),
      };
    }
    return { status: 200, ok: true, headers: new Headers() };
  }) as never;

  const result = await classifyResponse(
    'https://safe.example.test',
    1000,
    redirectingFetch,
    lookupCallsPerHost,
  );
  assert.equal(result, 'unknown');
  assert.deepEqual(visitedHostnames, ['safe.example.test', 'internal.example.test']);
});

// dueForLivenessCheck/recordLivenessCheck need a real Postgres (ordering by
// liveness_checked_at, excluding archived/rejected) - same disposable-
// per-test-database pattern as packages/core/src/database.test.ts.
test('LeadRepository: due-for-check ordering, status exclusion, and recording a result', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require the isolated CareerScope DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    const ownerId = randomUUID();
    await database.db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.test`,
      passwordHash: 'synthetic-not-a-login',
    });
    const runId = randomUUID();
    await database.pool.query(
      `INSERT INTO search_runs (id, owner_id, request, request_hash, idempotency_key, status)
       VALUES ($1, $2, '{}'::jsonb, 'hash', 'key', 'completed')`,
      [runId, ownerId],
    );
    const makeJob = async (fingerprint: string, applyUrl: string) => {
      const jobId = randomUUID();
      await database.pool.query(
        `INSERT INTO search_jobs (id, run_id, owner_id, fingerprint, data) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          jobId,
          runId,
          ownerId,
          fingerprint,
          JSON.stringify({
            fingerprint,
            title: 'Engineer',
            company: 'Example',
            location: 'Remote',
            isRemote: true,
            description: 'x',
            hasFullDescription: true,
            source: 'himalayas',
            sourceUrl: 'https://himalayas.app/jobs/' + fingerprint,
            applyUrl,
            postedAt: null,
            sourceLinks: [],
          }),
        ],
      );
      return jobId;
    };
    const leads = new LeadRepository(database);
    const jobA = await makeJob('fp-a', 'https://example.test/a');
    const jobB = await makeJob('fp-b', 'https://example.test/b');
    const jobC = await makeJob('fp-c', 'https://example.test/c');
    const leadA = (await leads.save(ownerId, { jobId: jobA }))!;
    const leadB = (await leads.save(ownerId, { jobId: jobB }))!;
    const leadC = (await leads.save(ownerId, { jobId: jobC }))!;

    // Fresh leads start 'unknown' with no check timestamp, and every
    // non-archived/rejected lead is due, oldest (or never-) checked first.
    assert.equal(leadA.livenessStatus, 'unknown');
    assert.equal(leadA.livenessCheckedAt, null);
    let due = await leads.dueForLivenessCheck(10, 24);
    assert.deepEqual(due.map((d) => d.id).sort(), [leadA.id, leadB.id, leadC.id].sort());

    await leads.recordLivenessCheck(ownerId, leadA.id, 'live');
    await leads.recordLivenessCheck(ownerId, leadB.id, 'stale');
    const refreshedA = await leads.get(ownerId, leadA.id);
    assert.equal(refreshedA!.livenessStatus, 'live');
    assert.ok(refreshedA!.livenessCheckedAt);

    // A and B were just checked, inside the freshness window - not due
    // again yet. C was never checked, so it is still due.
    due = await leads.dueForLivenessCheck(10, 24);
    assert.deepEqual(
      due.map((d) => d.id),
      [leadC.id],
    );

    // A 0-hour freshness window means "due again immediately" - proves the
    // exclusion is a real time comparison, not a permanent flag.
    due = await leads.dueForLivenessCheck(10, 0);
    assert.deepEqual(due.map((d) => d.id).sort(), [leadA.id, leadB.id, leadC.id].sort());

    // Archiving a lead removes it from the work queue even with a 0-hour
    // window and even though it was never checked - re-verifying a listing
    // the owner already moved past wastes nothing useful.
    await leads.update(ownerId, leadC.id, {
      revision: leadC.revision,
      notes: leadC.notes,
      status: 'archived',
    });
    due = await leads.dueForLivenessCheck(10, 0);
    assert.deepEqual(due.map((d) => d.id).sort(), [leadA.id, leadB.id].sort());
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.close();
  }
});
