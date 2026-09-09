/**
 * Route tests.
 *
 * These run against the real app through `app.inject()`, so they cover the
 * plugin chain and the `onRequest` auth hook as well as the handlers. The
 * emphasis is on the decisions that are easy to regress and expensive to get
 * wrong in production: who is refused, what an error body looks like, and the
 * upload guards.
 */

// The response type comes from the schema the route validates against, not a
// local restatement of it. A hand-written copy compiles regardless of what the
// route actually sends — it drifts silently, and the mismatch only surfaces as
// an `undefined` inside a failure message. This one cannot: `leadPageSchema`
// gaining a field is a compile error here the moment a test stops covering it.
import type { LeadPage, SkillGap } from '@job-radar/shared';
import { describe, expect, it } from 'vitest';
import {
  buildTestApp,
  multipartBody,
  profileBody,
  seedLeads,
  TEST_API_KEY,
  webDistFixture,
} from './routes.fixtures.js';

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

describe('authentication', () => {
  it('rejects a request with no key', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({ method: 'GET', url: '/api/leads' });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: 'unauthorized', message: 'Missing or invalid API key' },
      });
    } finally {
      await t.close();
    }
  });

  it('rejects a wrong key', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/leads',
        headers: { 'x-api-key': 'not-the-key-0123456789abcdef' },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  /**
   * A key one character short of correct must be refused like any other. The
   * hash-then-compare in `timingSafeEqual` exists so a length mismatch cannot be
   * distinguished from a value mismatch; this pins the behaviour it produces.
   */
  it('rejects a key that is a prefix of the real one', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/leads',
        headers: { 'x-api-key': TEST_API_KEY.slice(0, -1) },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it('accepts the key as a bearer token', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/leads',
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it('leaves health open, so a load balancer probe needs no credentials', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok' });
    } finally {
      await t.close();
    }
  });

  it('serves every route unauthenticated when AUTH_DISABLED is set', async () => {
    const t = await buildTestApp({ AUTH_DISABLED: 'true', APP_API_KEY: '' });
    try {
      const response = await t.app.inject({ method: 'GET', url: '/api/leads' });
      expect(response.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  /**
   * The single-origin deploy has to be usable.
   *
   * There, this server serves the SPA *and* guards the API, and the key lives in
   * the browser — the user types it into a settings screen this server hands
   * them first. A hook that guarded every path would 401 the shell, so there
   * would be no screen to type it into and no way in at all. That is exactly
   * what happened, and it is invisible until something boots the image with a
   * key set, which is why it is pinned here.
   */
  it('leaves the app shell public, so the key can be entered in the first place', async () => {
    const web = webDistFixture();
    const t = await buildTestApp({ SERVE_WEB: 'true', WEB_DIST: web.dir });
    try {
      const shell = await t.app.inject({ method: 'GET', url: '/' });
      expect(shell.statusCode).toBe(200);
      expect(shell.body).toContain('id="root"');

      // A client-side route: no file matches, so the SPA fallback answers with
      // the same shell rather than the auth hook answering with a 401.
      const deep = await t.app.inject({ method: 'GET', url: '/leads' });
      expect(deep.statusCode).toBe(200);
      expect(deep.body).toContain('id="root"');
    } finally {
      await t.close();
      web.remove();
    }
  });

  /** …and the API behind that shell is still shut. */
  it.each(['test', 'production'])(
    'applies HTTPS asset upgrading only in production (%s)',
    async (nodeEnv) => {
      const web = webDistFixture();
      const fixture = await buildTestApp({
        NODE_ENV: nodeEnv,
        SERVE_WEB: 'true',
        WEB_DIST: web.dir,
      });
      try {
        const response = await fixture.app.inject('/');
        const policy = String(response.headers['content-security-policy']);
        expect(policy).toContain("default-src 'self'");
        expect(policy.includes('upgrade-insecure-requests')).toBe(nodeEnv === 'production');
      } finally {
        await fixture.close();
        web.remove();
      }
    },
  );

  it('still refuses the API when the shell is public', async () => {
    const web = webDistFixture();
    const t = await buildTestApp({ SERVE_WEB: 'true', WEB_DIST: web.dir });
    try {
      const response = await t.app.inject({ method: 'GET', url: '/api/leads' });
      expect(response.statusCode).toBe(401);

      const authed = await t.app.inject({
        method: 'GET',
        url: '/api/leads',
        headers: t.auth,
      });
      expect(authed.statusCode).toBe(200);
    } finally {
      await t.close();
      web.remove();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Health and sources                                                         */
/* -------------------------------------------------------------------------- */

describe('GET /api/health/ready', () => {
  it('reports the database and the queue', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({ method: 'GET', url: '/api/health/ready' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ready', checks: { database: true } });
    } finally {
      await t.close();
    }
  });
});

describe('GET /api/sources', () => {
  it('lists every known source with its availability', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/sources',
        headers: t.auth,
      });
      const body = response.json() as {
        sources: { id: string; enabled: boolean; requiresKey: boolean; disabledReason: unknown }[];
      };

      expect(response.statusCode).toBe(200);
      expect(body.sources.length).toBeGreaterThan(0);

      // Keyless ATS boards work out of the box; that is the whole reason the app
      // finds leads on a fresh install with no configuration at all.
      const greenhouse = body.sources.find((source) => source.id === 'greenhouse');
      expect(greenhouse).toMatchObject({ enabled: true, requiresKey: false });

      // A keyed aggregator with no key is off, and says why — in a message that
      // names the variable, never a value.
      const adzuna = body.sources.find((source) => source.id === 'adzuna');
      expect(adzuna).toMatchObject({ enabled: false, requiresKey: true });
      expect(String(adzuna?.disabledReason)).toContain('ADZUNA_APP_ID');
      expect(String(adzuna?.disabledReason)).not.toContain(TEST_API_KEY);
    } finally {
      await t.close();
    }
  });

  it('reports the feature switches, so the UI can disable a control it cannot use', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/sources',
        headers: t.auth,
      });
      const body = response.json() as { capabilities: Record<string, unknown> };

      // Both default off, and the search screen greys out the rerank checkbox
      // rather than letting the user discover it in a 422.
      expect(body.capabilities).toEqual({ llmRerank: false, scrapers: false });
    } finally {
      await t.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Profile                                                                    */
/* -------------------------------------------------------------------------- */

describe('profile', () => {
  it('reports first-run state without a 404', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/profile/status',
        headers: t.auth,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ exists: false, hasResume: false });
    } finally {
      await t.close();
    }
  });

  it('preserves entered CTC while backend processing uses the adjusted value', async () => {
    const fixture = await buildTestApp();
    try {
      const created = await fixture.app.inject({
        method: 'POST',
        url: '/api/profile',
        headers: fixture.auth,
        payload: profileBody({ application: { currentCtc: '8.1', expectedCtc: '12 LPA' } }),
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().profile.application.currentCtc).toBe('8.1');
      for (const attempt of [1, 2]) {
        const updated = await fixture.app.inject({
          method: 'PUT',
          url: '/api/profile',
          headers: fixture.auth,
          payload: { application: { currentCtc: '8.1' } },
        });
        expect(updated.statusCode, `save ${attempt}`).toBe(200);
        expect(updated.json().profile.application.currentCtc).toBe('8.1');
        expect(fixture.container.repos.profiles.getForProcessing()?.application).toMatchObject({
          currentCtc: '7.1',
          expectedCtc: '12 LPA',
        });
        expect(fixture.container.repos.profiles.get()?.application.currentCtc).toBe('8.1');
      }
    } finally {
      await fixture.close();
    }
  });

  it('creates, then deep-merges a partial update', async () => {
    const t = await buildTestApp();
    try {
      const created = await t.app.inject({
        method: 'POST',
        url: '/api/profile',
        headers: t.auth,
        payload: profileBody(),
      });
      expect(created.statusCode).toBe(201);

      // Only `application` is sent. `preferences.techStack` must survive — the
      // resume-derived stack being wiped by an unrelated edit is the bug this
      // endpoint's merge behaviour exists to prevent.
      const updated = await t.app.inject({
        method: 'PUT',
        url: '/api/profile',
        headers: t.auth,
        payload: { application: { currentCtc: '30 LPA' } },
      });

      expect(updated.statusCode).toBe(200);
      const body = updated.json() as {
        profile: {
          preferences: { techStack: string[] };
          application: { currentCtc: string; yearsOfExperience: number };
        };
      };
      expect(body.profile.preferences.techStack).toContain('TypeScript');
      expect(body.profile.application.currentCtc).toBe('30 LPA');
      expect(body.profile.application.yearsOfExperience).toBe(6);
    } finally {
      await t.close();
    }
  });

  it('tells the caller to POST first when there is nothing to merge into', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'PUT',
        url: '/api/profile',
        headers: t.auth,
        payload: { application: { currentCtc: '10 LPA' } },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'profile_missing' } });
    } finally {
      await t.close();
    }
  });

  it('names the offending fields on a bad body', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/profile',
        headers: t.auth,
        payload: profileBody({ candidate: { fullName: 'x', email: 'not-an-email' } }),
      });

      expect(response.statusCode).toBe(400);
      const body = response.json() as {
        error: { code: string; details: { field: string }[] };
      };
      expect(body.error.code).toBe('bad_request');
      expect(body.error.details.map((detail) => detail.field)).toContain('candidate.email');
    } finally {
      await t.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Resume upload                                                              */
/* -------------------------------------------------------------------------- */

describe('POST /api/resume', () => {
  it('refuses a file whose bytes are not a PDF or DOCX, whatever it claims to be', async () => {
    const t = await buildTestApp();
    try {
      // Named `.pdf`, declared `application/pdf`, and neither is true. Format
      // detection reads the magic number precisely so this cannot get through.
      const { payload, headers } = multipartBody(
        'resume.pdf',
        new TextEncoder().encode('this is plain text pretending to be a pdf'),
      );

      const response = await t.app.inject({
        method: 'POST',
        url: '/api/resume',
        headers: { ...t.auth, ...headers },
        payload,
      });

      expect(response.statusCode).toBe(415);
      expect((response.json() as { error: { code: string } }).error.code).toMatch(/^resume_/);
    } finally {
      await t.close();
    }
  });

  it('refuses an empty file', async () => {
    const t = await buildTestApp();
    try {
      const { payload, headers } = multipartBody('resume.pdf', new Uint8Array(0));
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/resume',
        headers: { ...t.auth, ...headers },
        payload,
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });

  it('refuses a request that is not multipart', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/resume',
        headers: t.auth,
        payload: { file: 'nope' },
      });

      expect(response.statusCode).toBe(415);
      expect(response.json()).toMatchObject({ error: { code: 'unsupported_media_type' } });
    } finally {
      await t.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Search                                                                     */
/* -------------------------------------------------------------------------- */

describe('POST /api/search', () => {
  it('refuses to run without a profile', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/search',
        headers: t.auth,
        payload: { sources: ['greenhouse'] },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'profile_missing' } });
    } finally {
      await t.close();
    }
  });

  /**
   * The important one. A user who ticks a source that this install cannot run
   * must be told, not quietly given a run that skipped it — otherwise a clean
   * "0 results from LinkedIn" reads as "LinkedIn has nothing for you".
   */
  it('refuses the whole request when a selected source is unavailable', async () => {
    const t = await buildTestApp();
    try {
      await t.app.inject({
        method: 'POST',
        url: '/api/profile',
        headers: t.auth,
        payload: profileBody(),
      });

      const response = await t.app.inject({
        method: 'POST',
        url: '/api/search',
        headers: t.auth,
        payload: { sources: ['greenhouse', 'adzuna'] },
      });

      expect(response.statusCode).toBe(422);
      const body = response.json() as {
        error: { code: string; details: { source: string; reason: string }[] };
      };
      expect(body.error.code).toBe('unprocessable');
      expect(body.error.details).toHaveLength(1);
      expect(body.error.details[0]?.source).toBe('adzuna');
      expect(body.error.details[0]?.reason).toContain('ADZUNA_APP_ID');
    } finally {
      await t.close();
    }
  });

  it('rejects an unknown source', async () => {
    const t = await buildTestApp();
    try {
      await t.app.inject({
        method: 'POST',
        url: '/api/profile',
        headers: t.auth,
        payload: profileBody(),
      });

      const response = await t.app.inject({
        method: 'POST',
        url: '/api/search',
        headers: t.auth,
        payload: { sources: ['monster'] },
      });

      // Caught by the schema's source enum before the handler runs.
      expect(response.statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });

  it('rejects a rerank request when the server has it switched off', async () => {
    const t = await buildTestApp();
    try {
      await t.app.inject({
        method: 'POST',
        url: '/api/profile',
        headers: t.auth,
        payload: profileBody(),
      });

      const response = await t.app.inject({
        method: 'POST',
        url: '/api/search',
        headers: t.auth,
        payload: { sources: ['greenhouse'], useLlmRerank: true },
      });

      expect(response.statusCode).toBe(422);
    } finally {
      await t.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Leads                                                                      */
/* -------------------------------------------------------------------------- */

describe('leads', () => {
  it('returns an empty page rather than an error before the first run', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({ method: 'GET', url: '/api/leads', headers: t.auth });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ items: [], total: 0, limit: 50, offset: 0 });
    } finally {
      await t.close();
    }
  });

  /**
   * `minScore` defaults to 0, not to the 85% threshold. The filter rail owns the
   * threshold; an API that pre-filtered would make the slider unable to reveal
   * anything below its own default.
   */
  it('returns every scored lead by default, and filters only when asked', async () => {
    const t = await buildTestApp();
    try {
      seedLeads(t, [{ score: 0.92 }, { score: 0.71 }, { score: 0.43 }]);

      const all = await t.app.inject({ method: 'GET', url: '/api/leads', headers: t.auth });
      expect(all.json()).toMatchObject({ total: 3 });

      const filtered = await t.app.inject({
        method: 'GET',
        url: '/api/leads?minScore=0.85',
        headers: t.auth,
      });
      // The score lives under `match`, not on the lead itself — a lead carries
      // the whole `MatchBreakdown` so the drawer can draw the dimension bars
      // from the same payload the table was rendered from.
      const body = filtered.json() as LeadPage;
      expect(body.total).toBe(1);
      expect(body.items[0]?.match.score).toBeCloseTo(0.92);
    } finally {
      await t.close();
    }
  });

  /**
   * The facet counts ignore the score filter on purpose, so the slider can read
   * "3 leads · 1 at ≥85%" rather than "1 lead · 1 at ≥85%" — which would make
   * dragging it look like it had found nothing.
   */
  it('counts facets across the unfiltered set', async () => {
    const t = await buildTestApp();
    try {
      seedLeads(t, [{ score: 0.92 }, { score: 0.71 }, { score: 0.43 }]);

      const response = await t.app.inject({
        method: 'GET',
        url: '/api/leads?minScore=0.85',
        headers: t.auth,
      });
      const { facets } = response.json() as LeadPage;

      expect(facets.aboveThreshold).toBe(1);
      expect(facets.byStatus['new']).toBe(3);
    } finally {
      await t.close();
    }
  });

  it('sorts and pages', async () => {
    const t = await buildTestApp();
    try {
      seedLeads(t, [{ score: 0.42 }, { score: 0.95 }, { score: 0.68 }]);

      const response = await t.app.inject({
        method: 'GET',
        url: '/api/leads?sort=score&order=asc&limit=2',
        headers: t.auth,
      });
      const body = response.json() as LeadPage;

      expect(body.total).toBe(3);
      expect(body.items).toHaveLength(2);
      expect(body.items.map((item) => item.match.score)).toEqual([0.42, 0.68]);
    } finally {
      await t.close();
    }
  });

  it('returns the company record alongside the lead, so the drawer opens in one request', async () => {
    const t = await buildTestApp();
    try {
      seedLeads(t, [{ score: 0.9, company: 'Acme Corp' }]);

      const list = await t.app.inject({ method: 'GET', url: '/api/leads', headers: t.auth });
      const id = (list.json() as { items: { id: string }[] }).items[0]?.id;

      const response = await t.app.inject({
        method: 'GET',
        url: `/api/leads/${id}`,
        headers: t.auth,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        lead: { id },
        company: { name: 'Acme Corp' },
      });
    } finally {
      await t.close();
    }
  });

  it('reports how many rows a bulk update actually changed', async () => {
    const t = await buildTestApp();
    try {
      seedLeads(t, [{ score: 0.9 }, { score: 0.8 }]);
      const list = await t.app.inject({ method: 'GET', url: '/api/leads', headers: t.auth });
      const ids = (list.json() as { items: { id: string }[] }).items.map((item) => item.id);

      const response = await t.app.inject({
        method: 'POST',
        url: '/api/leads/bulk',
        headers: t.auth,
        // One id that does not exist. `updated` must not count it — a bulk
        // action that reports two successes when one row moved is worse than
        // one that reports the truth.
        payload: { ids: [...ids, 'missing-id'], status: 'dismissed' },
      });

      expect(response.json()).toEqual({ updated: 2, requested: 3 });
    } finally {
      await t.close();
    }
  });

  it('rejects a filter it cannot parse', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/leads?minScore=9&limit=0',
        headers: t.auth,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'bad_request' } });
    } finally {
      await t.close();
    }
  });

  it('404s an unknown lead', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/leads/does-not-exist',
        headers: t.auth,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    } finally {
      await t.close();
    }
  });

  /**
   * `/leads/skill-gap` sits alongside `/leads/:id`. The risk is not the
   * aggregate — that is tested in the repo — but that the literal segment gets
   * swallowed by the parameter and answers 404 for a lead named "skill-gap".
   */
  it('resolves /leads/skill-gap as a route, not as a lead id', async () => {
    const t = await buildTestApp();
    try {
      seedLeads(t, [{ score: 0.8 }, { score: 0.4 }]);
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/leads/skill-gap',
        headers: t.auth,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as SkillGap;
      expect(body).toMatchObject({ threshold: 0.85, nearMissFloor: 0.7, totalLeads: 2 });
      expect(body.nearMissLeads).toBe(1);
      expect(Array.isArray(body.gaps)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it('rejects a skill-gap band outside its range', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/leads/skill-gap?band=5',
        headers: t.auth,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'bad_request' } });
    } finally {
      await t.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Companies                                                                  */
/* -------------------------------------------------------------------------- */

describe('companies', () => {
  /**
   * An empty `q` returns nothing rather than the whole table. The field is a
   * typeahead, and answering a keystroke-in-progress with every company is both
   * slower and less useful than answering with nothing.
   */
  it('returns nothing for an empty search term', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/companies?q=',
        headers: t.auth,
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as { companies: unknown[] }).companies).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it('finds a seeded company by partial name', async () => {
    const t = await buildTestApp();
    try {
      seedLeads(t, [{ score: 0.9, company: 'Acme Corp' }]);

      const response = await t.app.inject({
        method: 'GET',
        url: '/api/companies?q=acme',
        headers: t.auth,
      });
      const body = response.json() as { companies: { name: string }[] };

      expect(body.companies.map((company) => company.name)).toContain('Acme Corp');
    } finally {
      await t.close();
    }
  });

  it('404s an unknown company', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/companies/nope',
        headers: t.auth,
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

describe('runs', () => {
  it('reports no active run on a fresh install', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/runs/active',
        headers: t.auth,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ run: null });
    } finally {
      await t.close();
    }
  });

  it('404s the event stream for an unknown run', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/runs/nope/events',
        headers: t.auth,
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

describe('export', () => {
  it('produces a downloadable workbook', async () => {
    const t = await buildTestApp();
    try {
      seedLeads(t, [{ score: 0.9, company: 'Acme Corp' }]);

      const response = await t.app.inject({
        method: 'GET',
        url: '/api/export/leads.xlsx',
        headers: t.auth,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['content-disposition']).toContain('.xlsx');
      // XLSX is a zip; a workbook that does not start with `PK` is not one.
      expect(response.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
    } finally {
      await t.close();
    }
  });

  it('emits a CSV with a UTF-8 BOM so Excel reads accented names correctly', async () => {
    const t = await buildTestApp();
    try {
      seedLeads(t, [{ score: 0.9, company: 'Sørensen Systems' }]);

      const response = await t.app.inject({
        method: 'GET',
        url: '/api/export/leads.csv',
        headers: t.auth,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
      expect(response.body).toContain('Sørensen Systems');
    } finally {
      await t.close();
    }
  });

  /**
   * The export takes the same filters as the table. A user who has narrowed to
   * "≥85%" and then exports means that set, not all 400 rows underneath it.
   */
  it('honours the leads filter', async () => {
    const t = await buildTestApp();
    try {
      seedLeads(t, [
        { score: 0.92, company: 'Kept Corp' },
        { score: 0.4, company: 'Filtered Out Ltd' },
      ]);

      const response = await t.app.inject({
        method: 'GET',
        url: '/api/export/leads.csv?minScore=0.85',
        headers: t.auth,
      });

      expect(response.body).toContain('Kept Corp');
      expect(response.body).not.toContain('Filtered Out Ltd');
    } finally {
      await t.close();
    }
  });

  /**
   * A cached export would be stale the moment the next run finishes, and the
   * file is regenerated from live data on every request anyway.
   */
  it('never lets an export be cached', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/export/leads.csv',
        headers: t.auth,
      });
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await t.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Not found                                                                  */
/* -------------------------------------------------------------------------- */

describe('unmatched routes', () => {
  it('answers an unknown API path with JSON, not HTML', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/nothing-here',
        headers: t.auth,
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    } finally {
      await t.close();
    }
  });

  it('still answers with JSON when no SPA build is present', async () => {
    const t = await buildTestApp();
    try {
      const response = await t.app.inject({ method: 'GET', url: '/leads', headers: t.auth });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
    } finally {
      await t.close();
    }
  });
});
