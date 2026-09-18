import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '@job-radar/providers';
import { checkJobAvailability, removeWithdrawnLeads } from './jobAvailability.js';
import {
  createTestRepos,
  makeBreakdown,
  makeJob,
  makeProfile,
  NOW,
  storeJob,
} from '../db/repo/repo.fixtures.js';

const job = {
  source: 'greenhouse' as const,
  sourceJobId: 'acme:123',
  sourceUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
};

function client(responses: { status: number; body: unknown }[]) {
  return new HttpClient({
    minIntervalMs: 0,
    fetch: async () => {
      const response = responses.shift();
      if (!response) throw new Error('Unexpected request');
      return new Response(
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
        {
          status: response.status,
        },
      );
    },
  });
}

describe('job availability', () => {
  it('uses the stored board-scoped ID for a custom Greenhouse URL with the matching job ID', async () => {
    const http = client([
      { status: 404, body: {} },
      { status: 200, body: { jobs: [] } },
    ]);
    const spy = vi.spyOn(http, 'get');
    expect(
      await checkJobAvailability(
        { ...job, sourceUrl: 'https://careers.example.com/jobs?gh_jid=123' },
        http,
        new AbortController().signal,
      ),
    ).toBe('removed');
    expect(spy.mock.calls[0]?.[0]).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs/123');
  });

  it('retains conflicting board-scoped identities', async () => {
    expect(
      await checkJobAvailability(
        { ...job, sourceJobId: 'other:123' },
        client([]),
        new AbortController().signal,
      ),
    ).toBe('unknown');
  });

  it.each(['jobs.lever.co', 'jobs.eu.lever.co'])(
    'checks the matching Lever region for %s',
    async (host) => {
      const http = client([
        { status: 410, body: { error: 'Posting not found' } },
        { status: 200, body: [] },
      ]);
      const spy = vi.spyOn(http, 'get');
      expect(
        await checkJobAvailability(
          { source: 'lever', sourceJobId: 'abc-123', sourceUrl: `https://${host}/acme/abc-123` },
          http,
          new AbortController().signal,
        ),
      ).toBe('removed');
      expect(spy.mock.calls[0]?.[0]).toBe(
        `https://${host === 'jobs.eu.lever.co' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/acme/abc-123?mode=json`,
      );
    },
  );

  it('retains a job when the response redirects away from its exact endpoint', async () => {
    const http = client([]);
    vi.spyOn(http, 'get').mockResolvedValue({
      status: 404,
      url: 'https://example.com/login',
      body: '{}',
      headers: {},
      fromCache: false,
    });
    expect(await checkJobAvailability(job, http, new AbortController().signal)).toBe('unknown');
  });

  it('rotates through bounded batches and wraps without starving older leads', async () => {
    const repos = createTestRepos();
    try {
      repos.profiles.save(makeProfile(), NOW);
      for (let index = 0; index < 26; index += 1) {
        const stored = storeJob(repos, makeJob({ ...job, fingerprint: `job-${index}` }));
        repos.leads.upsert({ jobId: stored.id, runId: null, breakdown: makeBreakdown() }, NOW);
      }
      const http = client(Array.from({ length: 51 }, () => ({ status: 200, body: { id: 123 } })));
      const signal = new AbortController().signal;
      expect((await removeWithdrawnLeads(repos, http, signal, NOW)).checked).toBe(25);
      expect((await removeWithdrawnLeads(repos, http, signal, NOW)).checked).toBe(1);
      expect((await removeWithdrawnLeads(repos, http, signal, NOW)).checked).toBe(25);
      expect(repos.leads.removalCandidates('', 100)).toHaveLength(26);
    } finally {
      repos.cleanup();
    }
  });

  it('retains leads when cancelled during the confirmation request', async () => {
    const repos = createTestRepos();
    const controller = new AbortController();
    try {
      repos.profiles.save(makeProfile(), NOW);
      const stored = storeJob(repos, makeJob(job));
      const lead = repos.leads.upsert(
        { jobId: stored.id, runId: null, breakdown: makeBreakdown() },
        NOW,
      );
      const http = new HttpClient({
        minIntervalMs: 0,
        fetch: async () => {
          controller.abort();
          return new Response('{}', { status: 404 });
        },
      });
      expect(await removeWithdrawnLeads(repos, http, controller.signal, NOW)).toEqual({
        checked: 0,
        removed: 0,
        unknown: 0,
      });
      expect(repos.leads.get(lead.id)).not.toBeNull();
    } finally {
      repos.cleanup();
    }
  });

  it('deletes confirmed removed untouched leads but preserves the underlying job', async () => {
    const repos = createTestRepos();
    try {
      repos.profiles.save(makeProfile(), NOW);
      const stored = storeJob(repos, makeJob(job));
      const lead = repos.leads.upsert(
        { jobId: stored.id, runId: null, breakdown: makeBreakdown() },
        NOW,
      );
      const http = client([
        { status: 404, body: {} },
        { status: 200, body: { jobs: [] } },
      ]);
      expect(await removeWithdrawnLeads(repos, http, new AbortController().signal, NOW)).toEqual({
        checked: 1,
        removed: 1,
        unknown: 0,
      });
      expect(repos.leads.get(lead.id)).toBeNull();
      expect(repos.jobs.get(stored.id)).not.toBeNull();
    } finally {
      repos.cleanup();
    }
  });

  it.each(['saved', 'applied', 'note', 'history', 'updated'])(
    'preserves %s leads even when a previously checked snapshot is deleted',
    (protection) => {
      const repos = createTestRepos();
      try {
        repos.profiles.save(makeProfile(), NOW);
        const stored = storeJob(repos, makeJob(job));
        const lead = repos.leads.upsert(
          { jobId: stored.id, runId: null, breakdown: makeBreakdown() },
          NOW,
        );
        if (protection === 'saved' || protection === 'applied')
          repos.leads.update(lead.id, { status: protection }, NOW);
        if (protection === 'note') repos.leads.update(lead.id, { note: 'Keep this history' }, NOW);
        if (protection === 'updated')
          repos.leads.update(lead.id, { status: 'new' }, '2026-09-06T00:00:00.000Z');
        if (protection === 'history')
          repos.db.run(
            "INSERT INTO application_runs (id,lead_id,status,data,created_at) VALUES ('attempt',:leadId,'failed','{}',:at)",
            { leadId: lead.id, at: NOW },
          );
        expect(repos.leads.deleteConfirmedRemoved(lead)).toBe(false);
        expect(repos.leads.get(lead.id)).not.toBeNull();
        if (protection !== 'updated') expect(repos.leads.removalCandidates('', 25)).toEqual([]);
      } finally {
        repos.cleanup();
      }
    },
  );

  it('requires an exact missing job and a healthy employer board', async () => {
    const http = client([
      { status: 404, body: { error: 'Job not found' } },
      { status: 200, body: { jobs: [] } },
    ]);
    expect(await checkJobAvailability(job, http, new AbortController().signal)).toBe('removed');
  });

  it.each([403, 429, 500, 503])('does not delete on HTTP %i', async (status) => {
    expect(
      await checkJobAvailability(job, client([{ status, body: {} }]), new AbortController().signal),
    ).toBe('unknown');
  });

  it.each([
    { status: 404, body: {} },
    { status: 200, body: '<html>Security check</html>' },
    { status: 200, body: { jobs: [{ id: 123 }] } },
    { status: 200, body: { jobs: [{}] } },
  ])('retains leads when board confirmation is inconclusive: %j', async (board) => {
    expect(
      await checkJobAvailability(
        job,
        client([{ status: 404, body: {} }, board]),
        new AbortController().signal,
      ),
    ).toBe('unknown');
  });

  it('recognizes an open exact job', async () => {
    expect(
      await checkJobAvailability(
        job,
        client([{ status: 200, body: { id: 123 } }]),
        new AbortController().signal,
      ),
    ).toBe('open');
  });

  it('does not probe unsupported hosts or mismatched identifiers', async () => {
    for (const candidate of [
      { ...job, sourceUrl: 'https://example.com/acme/jobs/123' },
      { ...job, sourceJobId: '456' },
    ]) {
      expect(await checkJobAvailability(candidate, client([]), new AbortController().signal)).toBe(
        'unknown',
      );
    }
  });
});
