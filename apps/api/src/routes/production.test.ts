import { expect, it } from 'vitest';
import { buildTestApp, webDistFixture } from './routes.fixtures.js';

it('serves the production shell while protecting data with secure owner sessions', async () => {
  const web = webDistFixture();
  const fixture = await buildTestApp({
    NODE_ENV: 'production',
    LOGIN_ENABLED: 'true',
    APP_API_KEY: '',
    AUTH_ORIGIN: 'https://jobs.example.com',
    SERVE_WEB: 'true',
    WEB_DIST: web.dir,
    ENABLE_APPLICATION_AGENT: 'false',
  });
  try {
    await fixture.container.repos.auth.setup(
      'release-test@example.com',
      'synthetic release test password',
    );
    const shell = await fixture.app.inject('/leads');
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toContain('id="root"');
    expect(shell.headers['content-security-policy']).toContain('upgrade-insecure-requests');
    expect(shell.headers['strict-transport-security']).toBeTruthy();
    expect((await fixture.app.inject('/api/health/ready')).statusCode).toBe(200);
    expect((await fixture.app.inject('/api/leads')).statusCode).toBe(401);
    const login = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: fixture.env.AUTH_ORIGIN },
      payload: { email: 'release-test@example.com', password: 'synthetic release test password' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toContain('__Host-job-radar-session=');
    expect(login.headers['set-cookie']).toContain('Secure');
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const sources = await fixture.app.inject({ url: '/api/sources', headers: { cookie } });
    expect(sources.statusCode).toBe(200);
    expect(sources.headers['cache-control']).toBe('no-store');
    expect(
      (
        await fixture.app.inject({
          method: 'DELETE',
          url: '/api/profile',
          headers: { cookie, origin: 'https://untrusted.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await fixture.app.inject({ url: '/api/applications/capability', headers: { cookie } }))
        .statusCode,
    ).toBe(503);
    expect(
      (
        await fixture.app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { cookie, origin: fixture.env.AUTH_ORIGIN },
        })
      ).statusCode,
    ).toBe(200);
    expect((await fixture.app.inject({ url: '/api/leads', headers: { cookie } })).statusCode).toBe(
      401,
    );
  } finally {
    await fixture.close();
    web.remove();
  }
});
