import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createEmailOtp, type Database } from '@careerscope/core';
import { createApp, type RateLimit } from './app.js';

const origin = 'http://localhost:5280';
const secret = Buffer.alloc(32, 5);
const email = 'candidate@example.test';

/** In-memory fixed-window limiter with the same peek semantics as Redis. */
function memoryLimiter(): RateLimit {
  const counts = new Map<string, number>();
  return async (key, limit, _seconds, peek) => {
    if (peek) return (counts.get(key) ?? 0) < limit;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count <= limit;
  };
}

/**
 * Counts only the 24-hour failure budgets and allows everything else. It isolates those budgets from
 * the 10-minute limits, which a fixed-window in-memory counter cannot age out within a test.
 */
function dayBudgetLimiter(): RateLimit {
  const memory = memoryLimiter();
  return async (key, limit, seconds, peek) =>
    key.includes('failed-day') ? memory(key, limit, seconds, peek) : true;
}

function setup(options: { recentChallenge?: boolean; noChallenge?: boolean } = {}) {
  const challengeId = randomUUID();
  const otp = createEmailOtp(challengeId, secret);
  const state = { connects: 0, sent: 0 };
  const database = {
    pool: {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => {
        state.connects += 1;
        return {
          query: async (sql: string) => {
            if (sql.includes('SELECT id FROM email_otp_challenges'))
              return { rows: options.noChallenge ? [] : [{ id: challengeId }] };
            if (sql.includes('SELECT digest, attempts, expires_at'))
              return {
                rows: [
                  {
                    digest: otp.digest,
                    attempts: 0,
                    expires_at: new Date(otp.expiresAt),
                    intent: 'sign-in',
                    terms_version: null,
                    privacy_version: null,
                    marketing_opt_in: false,
                    marketing_version: null,
                    age_screen_passed: null,
                  },
                ],
              };
            if (sql.includes('created_at >')) return { rows: options.recentChallenge ? [{}] : [] };
            return { rows: [] };
          },
          release: () => undefined,
        };
      },
    },
  } as unknown as Database;
  const provider = {
    send: async () => {
      state.sent += 1;
    },
  };
  return { database, provider, state, wrongCode: otp.code === '000000' ? '111111' : '000000' };
}

async function requestCode(app: Awaited<ReturnType<typeof createApp>>, ip: string) {
  return app.inject({
    method: 'POST',
    url: '/api/otp/request',
    remoteAddress: ip,
    headers: { origin },
    payload: { email },
  });
}

async function verify(
  app: Awaited<ReturnType<typeof createApp>>,
  ip: string,
  code: string,
): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/otp/verify',
    remoteAddress: ip,
    headers: { origin },
    payload: { email, code },
  });
  return response.statusCode;
}

test('verify attempts from one IP do not lock out the same address from another IP', async () => {
  const { database, provider, wrongCode } = setup();
  const app = await createApp(database, origin, memoryLimiter(), {
    emailOtp: { secret, provider },
  });
  try {
    for (let i = 0; i < 5; i += 1) assert.equal(await verify(app, '10.0.0.1', wrongCode), 401);
    assert.equal(await verify(app, '10.0.0.1', wrongCode), 429);
    assert.equal(await verify(app, '10.0.0.2', wrongCode), 401);
  } finally {
    await app.close();
  }
});

test('per-address backstop still bounds verification attempts spread across many IPs', async () => {
  // Each client stays under its own limits, so only the 30-attempt per-address backstop stops them.
  const { database, provider, wrongCode } = setup({ noChallenge: true });
  const app = await createApp(database, origin, memoryLimiter(), {
    emailOtp: { secret, provider },
  });
  try {
    for (let ip = 1; ip <= 6; ip += 1)
      for (let i = 0; i < 5; i += 1)
        assert.equal(await verify(app, `10.0.1.${ip}`, wrongCode), 401);
    assert.equal(await verify(app, '10.0.1.7', wrongCode), 429);
  } finally {
    await app.close();
  }
});

test('a client that exhausts its own 24-hour failure budget is blocked, and another client is not', async () => {
  const { database, provider, wrongCode } = setup();
  const app = await createApp(database, origin, dayBudgetLimiter(), {
    emailOtp: { secret, provider },
  });
  try {
    for (let i = 0; i < 20; i += 1) assert.equal(await verify(app, '10.0.2.1', wrongCode), 401);
    assert.equal(await verify(app, '10.0.2.1', wrongCode), 429);
    // The first client's failures never lock the address for anyone else.
    assert.equal(await verify(app, '10.0.2.2', wrongCode), 401);
  } finally {
    await app.close();
  }
});

test('failures spread across many clients throttle sending new codes but never verification', async () => {
  const { database, provider, state, wrongCode } = setup();
  const app = await createApp(database, origin, dayBudgetLimiter(), {
    emailOtp: { secret, provider },
  });
  try {
    // 100 failures from five clients (20 each) exhaust the per-address send budget.
    for (let ip = 1; ip <= 5; ip += 1)
      for (let i = 0; i < 20; i += 1)
        assert.equal(await verify(app, `10.0.3.${ip}`, wrongCode), 401);

    const connectsBefore = state.connects;
    const throttled = await requestCode(app, '10.0.3.9');
    assert.equal(throttled.statusCode, 202);
    assert.equal(state.sent, 0);
    assert.equal(state.connects, connectsBefore);

    // A client with no failures of its own can still verify.
    assert.equal(await verify(app, '10.0.3.9', wrongCode), 401);
  } finally {
    await app.close();
  }
});

test('a throttled address and a fresh one return identical request responses', async () => {
  const exhausted = setup();
  const throttledApp = await createApp(exhausted.database, origin, dayBudgetLimiter(), {
    emailOtp: { secret, provider: exhausted.provider },
  });
  const fresh = setup();
  const freshApp = await createApp(fresh.database, origin, dayBudgetLimiter(), {
    emailOtp: { secret, provider: fresh.provider },
  });
  try {
    for (let ip = 1; ip <= 5; ip += 1)
      for (let i = 0; i < 20; i += 1)
        await verify(throttledApp, `10.0.4.${ip}`, exhausted.wrongCode);
    const throttled = await requestCode(throttledApp, '10.0.4.9');
    const issued = await requestCode(freshApp, '10.0.4.9');
    assert.equal(exhausted.state.sent, 0);
    assert.equal(fresh.state.sent, 1);
    assert.equal(throttled.statusCode, issued.statusCode);
    assert.equal(throttled.body, issued.body);
  } finally {
    await throttledApp.close();
    await freshApp.close();
  }
});

test('a request during the cooldown of an unexpired challenge neither replaces nor sends a code', async () => {
  const cooling = setup({ recentChallenge: true });
  const coolingApp = await createApp(cooling.database, origin, memoryLimiter(), {
    emailOtp: { secret, provider: cooling.provider },
  });
  const fresh = setup();
  const freshApp = await createApp(fresh.database, origin, memoryLimiter(), {
    emailOtp: { secret, provider: fresh.provider },
  });
  try {
    const request = (app: typeof coolingApp) =>
      app.inject({
        method: 'POST',
        url: '/api/otp/request',
        headers: { origin },
        payload: { email },
      });
    const throttled = await request(coolingApp);
    const issued = await request(freshApp);
    assert.equal(throttled.statusCode, 202);
    assert.equal(cooling.state.sent, 0);
    assert.equal(issued.statusCode, 202);
    assert.equal(fresh.state.sent, 1);
    // Identical response whether or not a code was issued.
    assert.equal(throttled.body, issued.body);
  } finally {
    await coolingApp.close();
    await freshApp.close();
  }
});
