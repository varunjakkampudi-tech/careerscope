import { afterEach, describe, expect, it } from 'vitest';
import { searchRequestSchema } from '@job-radar/shared';
import { buildTestApp, profileBody, type TestApp } from './routes.fixtures.js';

let fixture: TestApp | undefined;
afterEach(async () => {
  await fixture?.close();
});

const job = {
  source: 'indeed',
  sourceJobId: 'verified-job',
  title: 'Senior Software Engineer',
  companyName: 'Example',
  location: 'Hyderabad',
  description:
    'Develop React and TypeScript applications. Required skills: React, TypeScript, Node.js. Build accessible user interfaces and maintain reliable software. Experience: 5-7 years.',
  hasFullDescription: true,
  sourceUrl: 'https://in.indeed.com/viewjob?jk=verified-job',
};

describe('browser job import', () => {
  it('requires auth and a profile, computes scores, and preserves lead status on repeated imports', async () => {
    fixture = await buildTestApp();
    const { app, auth } = fixture;
    expect(
      (await app.inject({ method: 'POST', url: '/api/leads/import', payload: { jobs: [job] } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/leads/import',
          headers: auth,
          payload: { jobs: [job] },
        })
      ).statusCode,
    ).toBe(409);
    await app.inject({
      method: 'POST',
      url: '/api/profile',
      headers: auth,
      payload: profileBody(),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/leads/import',
      headers: auth,
      payload: { jobs: [job] },
    });
    expect(response.statusCode).toBe(201);
    const imported = response.json<{ imported: { id: string; score: number }[] }>().imported[0]!;
    expect(imported.score).toBeGreaterThan(0);
    await app.inject({
      method: 'PATCH',
      url: `/api/leads/${imported.id}`,
      headers: auth,
      payload: { status: 'saved' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/leads/import',
      headers: auth,
      payload: { jobs: [job] },
    });
    expect(fixture.container.repos.leads.counts().total).toBe(1);
    expect(fixture.container.repos.leads.get(imported.id)?.status).toBe('saved');
    const updated = await app.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: auth,
      payload: { preferences: { excludeKeywords: ['Example'] } },
    });
    expect(updated.statusCode).toBe(200);
    const rescored = fixture.container.repos.leads.get(imported.id)!;
    expect(rescored.match.score).toBe(0);
    expect(rescored.match.excludedReason).toBeTruthy();
    expect(rescored.status).toBe('saved');
    fixture.container.repos.runs.create(
      searchRequestSchema.parse({ sources: ['greenhouse'] }),
      new Date().toISOString(),
    );
    const duringSearch = await app.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: auth,
      payload: { preferences: { excludeKeywords: [] } },
    });
    expect(duringSearch.statusCode).toBe(409);
    expect(fixture.container.repos.profiles.get()?.preferences.excludeKeywords).toEqual([
      'Example',
    ]);
  });

  it('rejects unsafe links and caller-supplied scores and caps snippets', async () => {
    fixture = await buildTestApp();
    const { app, auth } = fixture;
    await app.inject({
      method: 'POST',
      url: '/api/profile',
      headers: auth,
      payload: profileBody(),
    });
    for (const invalid of [
      { ...job, score: 1 },
      { ...job, sourceUrl: 'javascript:alert(1)' },
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/leads/import',
            headers: auth,
            payload: { jobs: [invalid] },
          })
        ).statusCode,
      ).toBe(400);
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/leads/import',
      headers: auth,
      payload: { jobs: [{ ...job, hasFullDescription: false }] },
    });
    expect(response.statusCode).toBe(201);
    expect(
      response.json<{ imported: { score: number }[] }>().imported[0]!.score,
    ).toBeLessThanOrEqual(0.8);
  });
});
