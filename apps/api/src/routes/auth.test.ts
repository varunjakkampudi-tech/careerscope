import { expect, it } from 'vitest';
import { buildTestApp } from './routes.fixtures.js';
import { parseEnv } from '../env.js';

it('protects data despite the old bypass, restricts setup, and rejects CSRF and revoked cookies', async () => {
  const fixture = await buildTestApp({ LOGIN_ENABLED: 'true', AUTH_DISABLED: 'true' });
  const headers = { origin: 'http://localhost:5173', host: 'localhost' };
  const payload = { email: 'test@example.com', password: 'a synthetic strong password' };
  try {
    expect((await fixture.app.inject({ url: '/api/profile' })).statusCode).toBe(401);
    expect(
      (
        await fixture.app.inject({
          method: 'POST',
          url: '/api/auth/setup',
          headers,
          payload,
          remoteAddress: '192.0.2.1',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await fixture.app.inject({
          method: 'POST',
          url: '/api/auth/setup',
          headers,
          payload: { ...payload, password: 'short' },
        })
      ).statusCode,
    ).toBe(400);
    const setup = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers,
      payload,
    });
    expect(setup.statusCode).toBe(201);
    const cookie = String(setup.headers['set-cookie']).split(';')[0]!;
    expect(setup.headers['set-cookie']).toContain('HttpOnly');
    expect(setup.headers['set-cookie']).toContain('SameSite=Strict');
    const session = await fixture.app.inject({ url: '/api/auth/session', headers: { cookie } });
    expect(session.json()).toMatchObject({ authenticated: true, email: payload.email });
    expect((await fixture.app.inject({ url: '/api/leads', headers: { cookie } })).statusCode).toBe(
      200,
    );
    expect(
      (await fixture.app.inject({ method: 'POST', url: '/api/auth/setup', headers, payload }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await fixture.app.inject({
          method: 'DELETE',
          url: '/api/profile',
          headers: { cookie, origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
    const missingOrigin = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.body).toContain(
      'This request must come from the CareerScope application.',
    );
    expect(
      (
        await fixture.app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { ...headers, cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect((await fixture.app.inject({ url: '/api/leads', headers: { cookie } })).statusCode).toBe(
      401,
    );
  } finally {
    await fixture.close();
  }
  // The heaviest Argon2id test in the file; it exceeds the default timeout under
  // parallel load. The hashing cost is deliberately not reduced to speed it up.
}, 30_000);

it('rate limits password attempts even when forwarded IPs are spoofed', async () => {
  const fixture = await buildTestApp({ LOGIN_ENABLED: 'true' });
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fixture.app.inject({
        method: 'POST',
        url: '/api/auth/login?next=/events',
        headers: { origin: 'http://localhost:5173', 'x-forwarded-for': `192.0.2.${attempt}` },
        payload: { email: 'unknown@example.com', password: 'wrong' },
      });
      expect(response.statusCode).toBe(attempt < 5 ? 401 : 429);
    }
  } finally {
    await fixture.close();
  }
  // Six Argon2id verifications exceed the default timeout under parallel load.
}, 30_000);

it('uses host-only Secure cookies in production and forbids public setup', async () => {
  const fixture = await buildTestApp({
    NODE_ENV: 'production',
    APP_API_KEY: '',
    LOGIN_ENABLED: 'true',
    AUTH_ORIGIN: 'https://radar.example.com',
  });
  const payload = { email: 'test@example.com', password: 'synthetic production password' };
  const headers = { origin: 'https://radar.example.com' };
  try {
    expect(
      (await fixture.app.inject({ method: 'POST', url: '/api/auth/setup', headers, payload }))
        .statusCode,
    ).toBe(403);
    await fixture.container.repos.auth.setup(payload.email, payload.password);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers,
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('__Host-job-radar-session=');
    expect(response.headers['set-cookie']).toContain('Secure');
    expect(response.headers['set-cookie']).not.toContain('Domain=');
    expect(response.headers['cache-control']).toBe('no-store');
  } finally {
    await fixture.close();
  }
}, 30_000);

it('requires HTTPS for production login and an API key for legacy production auth', () => {
  expect(() =>
    parseEnv({
      NODE_ENV: 'production',
      LOGIN_ENABLED: 'true',
      AUTH_ORIGIN: 'http://radar.example.com',
    }),
  ).toThrow();
  expect(() =>
    parseEnv({ NODE_ENV: 'production', LOGIN_ENABLED: 'false', APP_API_KEY: '' }),
  ).toThrow();
  expect(() =>
    parseEnv({
      NODE_ENV: 'production',
      LOGIN_ENABLED: 'true',
      AUTH_DISABLED: 'true',
      AUTH_ORIGIN: 'https://radar.example.com',
    }),
  ).toThrow();
});
