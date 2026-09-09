import { expect, it, vi } from 'vitest';
import { buildTestApp } from './routes.fixtures.js';

it('keeps application automation opt-in and protects the routes', async () => {
  const fixture = await buildTestApp();
  try {
    const capability = await fixture.app.inject({
      url: '/api/applications/capability',
      headers: fixture.auth,
    });
    expect(capability.statusCode).toBe(200);
    expect(capability.json()).toMatchObject({ available: false });
    const start = await fixture.app.inject({
      method: 'POST',
      url: '/api/applications',
      headers: fixture.auth,
      payload: { consent: true },
    });
    expect(start.statusCode).toBe(503);
    const unauthorized = await fixture.app.inject({ url: '/api/applications' });
    expect(unauthorized.statusCode).toBe(401);
    const list = await fixture.app.inject({ url: '/api/applications', headers: fixture.auth });
    expect(list.json()).toEqual({ active: null, runs: [] });
  } finally {
    await fixture.close();
  }
});

it('requires sharing consent and defaults to manual review unless automatic submission is explicit', async () => {
  const fixture = await buildTestApp({ ENABLE_APPLICATION_AGENT: 'true' });
  const leadId = '11111111-1111-4111-8111-111111111111';
  const start = vi
    .spyOn(fixture.container.applications, 'start')
    .mockResolvedValue({ id: 'synthetic-run' } as Awaited<
      ReturnType<typeof fixture.container.applications.start>
    >);
  try {
    const send = (payload: object) =>
      fixture.app.inject({
        method: 'POST',
        url: '/api/applications',
        headers: fixture.auth,
        payload,
      });
    expect((await send({ leadId, consent: false, autoSubmit: true })).statusCode).toBe(400);
    expect(start).not.toHaveBeenCalled();
    expect((await send({ leadId, consent: true })).statusCode).toBe(202);
    expect(start).toHaveBeenLastCalledWith(leadId, true, false, undefined);
    expect((await send({ leadId, consent: true, autoSubmit: true })).statusCode).toBe(202);
    expect(start).toHaveBeenLastCalledWith(leadId, true, true, undefined);
    expect((await send({ leadId, consent: true, retryOf: 'invalid' })).statusCode).toBe(400);
    const retryOf = '22222222-2222-4222-8222-222222222222';
    expect((await send({ leadId, consent: true, retryOf })).statusCode).toBe(202);
    expect(start).toHaveBeenLastCalledWith(leadId, true, false, retryOf);
  } finally {
    await fixture.close();
  }
});
