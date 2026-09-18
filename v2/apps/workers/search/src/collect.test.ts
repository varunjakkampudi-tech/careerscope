import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { collect } from './collect.js';
import { matchingProfile, writableProfileSchema } from '@careerscope/core';
import { LOW_CONFIDENCE_SCORE_CEILING } from '../../../../../packages/shared/dist/index.js';
import {
  createRemoteOkProvider,
  createHimalayasProvider,
  createGreenhouseProvider,
  createLeverProvider,
  createWorkableProvider,
  HttpClient,
} from '../../../../../packages/providers/dist/index.js';

const request = { query: 'React', sources: ['remoteok'] as ['remoteok'] };
const signal = new AbortController().signal;

test('profile discovery uses bounded saved roles without sending candidate identity', async () => {
  const profile = matchingProfile(
    writableProfileSchema.parse({
      candidate: {
        fullName: 'Private Synthetic Name',
        email: 'private@example.test',
        location: 'Hyderabad',
      },
      preferences: {
        titles: [
          'React Engineer',
          'react   engineer',
          'Frontend Developer',
          'UI Developer',
          'Web Engineer',
          'Software Engineer',
          'Platform Engineer',
        ],
        techStack: ['React'],
      },
      application: {},
    }),
  );
  const queries: unknown[] = [];
  const provider = {
    ...createRemoteOkProvider(),
    async *search(query: unknown) {
      queries.push(query);
      yield* [];
    },
  };
  await collect({ ...request, useProfileTitles: true }, signal, provider, undefined, { profile });
  const query = queries[0] as { titles: string[]; maxResults: number };
  assert.equal(query.titles.length, 5);
  assert.equal(new Set(query.titles.map((title) => title.toLowerCase())).size, 5);
  assert.equal(query.titles.includes('Platform Engineer'), false);
  assert.equal(query.maxResults, 100);
  assert.equal(JSON.stringify(query).includes('Private Synthetic Name'), false);
  assert.equal(JSON.stringify(query).includes('private@example.test'), false);
  await collect(request, signal, provider, undefined, { profile });
  assert.deepEqual((queries[1] as { titles: string[] }).titles, ['React']);
  await assert.rejects(
    collect({ ...request, useProfileTitles: true }, signal, provider),
    /Saved target roles/,
  );
  await assert.rejects(
    collect({ ...request, useProfileTitles: true }, signal, provider, undefined, {
      profile: { ...profile, preferences: { ...profile.preferences, titles: [' ', '\t', 'a'] } },
    }),
    /Saved target roles/,
  );
  assert.equal(queries.length, 2);
});

test('saved roles broaden real feed filtering without multiplying acquisition requests', async () => {
  const profile = matchingProfile(
    writableProfileSchema.parse({
      candidate: {
        fullName: 'Synthetic Candidate',
        email: 'synthetic@example.test',
        location: 'Remote',
      },
      preferences: {
        titles: ['React Engineer', 'Platform Engineer'],
        techStack: ['React', 'TypeScript'],
      },
      application: {},
    }),
  );
  let calls = 0;
  const now = Date.parse('2026-09-18T12:00:00Z');
  const http = new HttpClient({
    retries: 0,
    fetch: async () => {
      calls += 1;
      return new Response(
        JSON.stringify([
          { legal: 'Synthetic fixture' },
          ...['React Engineer', 'Platform Engineer', 'Nurse'].map((title, index) => ({
            id: `roles-${index}`,
            position: title,
            company: 'Synthetic Company',
            location: 'Remote',
            description: '<p>Build React and TypeScript services.</p>',
            date: new Date(now).toISOString(),
            url: `https://remoteok.com/remote-jobs/roles-${index}`,
            apply_url: `https://example.test/roles-${index}`,
          })),
        ]),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const result = await collect(
    { ...request, useProfileTitles: true },
    signal,
    createRemoteOkProvider(),
    http,
    { profile, now },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result.jobs.map((job) => job.title).sort(), [
    'Platform Engineer',
    'React Engineer',
  ]);
  assert.ok(result.jobs.every((job) => job.match && job.sourceLinks?.length === 1));
  const repeated = await collect(
    { ...request, useProfileTitles: true },
    signal,
    createRemoteOkProvider(),
    http,
    { profile, now },
  );
  assert.deepEqual(repeated.jobs, result.jobs);
});

test('multi-source collection retains validated partial results and preserves cancellation', async () => {
  const raw = {
    source: 'remoteok' as const,
    sourceJobId: 'multi',
    title: 'React Engineer',
    companyName: 'Example',
    location: 'Remote',
    isRemote: true,
    description: 'React role',
    hasFullDescription: false,
    sourceUrl: 'https://remoteok.com/remote-jobs/multi',
    applyUrl: 'https://example.test/apply',
  };
  const remote = {
    ...createRemoteOkProvider(),
    async *search() {
      yield raw;
    },
  };
  const himalayas = {
    ...createHimalayasProvider(),
    async *search() {
      yield {
        ...raw,
        source: 'himalayas' as const,
        sourceJobId: 'other',
        description: 'Build accessible React and TypeScript interfaces. '.repeat(10),
        hasFullDescription: true,
        sourceUrl: 'https://himalayas.app/jobs/multi',
      };
      yield {
        ...raw,
        source: 'himalayas' as const,
        sourceJobId: 'unique',
        companyName: 'Another Example',
        sourceUrl: 'https://himalayas.app/jobs/unique',
      };
    },
  };
  const multiRequest = {
    ...request,
    sources: ['remoteok', 'himalayas'] as ['remoteok', 'himalayas'],
  };
  const { jobs: result, status } = await collect(multiRequest, signal, [remote, himalayas]);
  assert.equal(status, 'completed');
  assert.equal(result.length, 2);
  assert.equal(result.find((job) => job.company === 'Example')?.source, 'himalayas');
  assert.deepEqual(result.find((job) => job.company === 'Example')?.sourceLinks, [
    { source: 'remoteok', url: raw.sourceUrl },
    { source: 'himalayas', url: 'https://himalayas.app/jobs/multi' },
  ]);
  const failing = {
    ...himalayas,
    async *search() {
      yield { ...raw, source: 'himalayas' as const };
      throw new Error('Synthetic source failure');
    },
  };
  const partial = await collect(multiRequest, signal, [remote, failing]);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.jobs.length, 1);
  assert.deepEqual(
    partial.outcomes.map((outcome) => outcome.status),
    ['completed', 'failed'],
  );
  assert.equal(partial.outcomes[1]!.errorCode, 'source_failed');
  assert.equal(partial.outcomes[1]!.accepted, 1);
  const control = new AbortController();
  const cancelling = {
    ...remote,
    async *search() {
      yield raw;
      control.abort();
    },
  };
  let secondCalled = false;
  const uncalled = {
    ...himalayas,
    async *search() {
      secondCalled = true;
      yield raw;
    },
  };
  await assert.rejects(collect(multiRequest, control.signal, [cancelling, uncalled]), {
    name: 'AbortError',
  });
  assert.equal(secondCalled, false);
});

test('search uses the established provider normalization and attribution', async () => {
  const http = new HttpClient({
    retries: 0,
    fetch: async () =>
      new Response(
        JSON.stringify([
          { legal: 'fixture notice' },
          {
            id: 'fixture-1',
            position: 'React Engineer',
            company: 'Example',
            location: 'Remote',
            description: '<p>Build accessible React interfaces.</p>',
            date: new Date().toISOString(),
            url: 'https://remoteok.com/remote-jobs/fixture-1',
            apply_url: 'https://example.test/apply',
          },
        ]),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  const { jobs: results } = await collect(request, signal, createRemoteOkProvider(), http);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.match, null);
  assert.equal(results[0]!.description, 'Build accessible React interfaces.');
  assert.equal(results[0]!.sourceUrl, 'https://remoteok.com/remote-jobs/fixture-1');
});

test('selected Himalayas adapter follows bounded pages and preserves source links', async () => {
  const urls: string[] = [];
  const http = new HttpClient({
    retries: 0,
    minIntervalMs: 0,
    fetch: async (url) => {
      urls.push(url);
      const second = url.includes('cursor=');
      return Response.json({
        jobs: [
          {
            guid: `https://himalayas.app/jobs/fixture-${second ? 'second' : 'first'}`,
            title: 'React Engineer',
            companyName: second ? 'Second Example' : 'First Example',
            locationRestrictions: ['India'],
            description: '<p>Build React interfaces.</p>',
            employmentType: 'Full Time',
            pubDate: Math.floor(Date.now() / 1000),
            applicationLink: 'https://example.test/apply',
          },
        ],
        nextCursor: second ? null : 'next-page',
      });
    },
  });
  const { jobs: result } = await collect(
    { query: 'Saved target roles', useProfileTitles: true, sources: ['himalayas'] },
    signal,
    undefined,
    http,
    {
      profile: matchingProfile(
        writableProfileSchema.parse({
          candidate: {
            fullName: 'Synthetic Candidate',
            email: 'synthetic@example.test',
            location: 'India',
          },
          preferences: {
            titles: [
              'React Engineer',
              'Platform Engineer',
              'UI Developer',
              'Web Engineer',
              'Frontend Developer',
            ],
            techStack: ['React'],
          },
          application: {},
        }),
      ),
    },
  );
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.startsWith('https://himalayas.app/jobs/api?limit=100')));
  assert.ok(urls[1]!.includes('cursor=next-page'));
  assert.equal(result.length, 2);
  assert.ok(result.every((job) => job.source === 'himalayas' && job.location === 'India'));
  assert.equal(result[0]!.description, 'Build React interfaces.');
});

test('public ATS factories collect validated jobs and fetch bounded descriptions', async () => {
  for (const source of ['greenhouse', 'lever', 'workable'] as const) {
    const calls: string[] = [];
    const description = '<p>Build accessible React and TypeScript interfaces.</p>';
    const http = new HttpClient({
      retries: 0,
      minIntervalMs: 0,
      fetch: async (url) => {
        calls.push(url);
        if (source === 'greenhouse') {
          assert.equal(new URL(url).hostname, 'boards-api.greenhouse.io');
          return Response.json(
            url.endsWith('/jobs/123')
              ? { content: description }
              : {
                  jobs: [
                    {
                      id: 123,
                      title: 'React Engineer',
                      company_name: 'Synthetic ATS',
                      location: { name: 'Remote' },
                      absolute_url: 'https://example.test/greenhouse/123',
                    },
                  ],
                },
          );
        }
        if (source === 'lever') {
          assert.equal(new URL(url).hostname, 'api.lever.co');
          return Response.json([
            {
              id: 'synthetic-123',
              text: 'React Engineer',
              categories: { location: 'Remote' },
              description,
              hostedUrl: 'https://example.test/lever/123',
            },
          ]);
        }
        assert.equal(new URL(url).hostname, 'apply.workable.com');
        return Response.json(
          url.endsWith('/jobs/ABC123')
            ? { description }
            : {
                results: [{ shortcode: 'ABC123', title: 'React Engineer', location: 'Remote' }],
                nextPage: null,
              },
        );
      },
    });
    const result = await collect({ query: 'React', sources: [source] }, signal, undefined, http);
    assert.equal(result.status, 'completed');
    assert.ok(result.jobs.length > 0);
    assert.ok(
      result.jobs.every(
        (job) => job.source === source && job.sourceLinks?.every((link) => link.source === source),
      ),
    );
    assert.ok(result.jobs.some((job) => job.description.includes('accessible React')));
    assert.ok(calls.length > 0);
    const details = calls.filter((url) => /\/jobs\/(123|ABC123)$/.test(url));
    assert.ok(details.length <= 20);
    if (source !== 'lever') assert.ok(details.length > 0);
    const manualCalls = [...calls];
    calls.length = 0;
    http.clearCache();
    const expanded = await collect(
      { query: 'Saved target roles', useProfileTitles: true, sources: [source] },
      signal,
      undefined,
      http,
      {
        profile: matchingProfile(
          writableProfileSchema.parse({
            candidate: {
              fullName: 'Synthetic Candidate',
              email: 'synthetic@example.test',
              location: 'Remote',
            },
            preferences: {
              titles: [
                'React Engineer',
                'Platform Engineer',
                'UI Developer',
                'Web Engineer',
                'Frontend Developer',
              ],
              techStack: ['React'],
            },
            application: {},
          }),
        ),
      },
    );
    assert.equal(expanded.status, 'completed');
    assert.ok(expanded.jobs.length > 0);
    assert.deepEqual(calls, manualCalls, `${source} must not rescan boards per title`);
  }
});

test('five-source discovery isolates ATS failure and caps detail requests', async () => {
  let details = 0;
  const providers = [
    createRemoteOkProvider(),
    createHimalayasProvider(),
    createGreenhouseProvider(),
    createLeverProvider(),
    createWorkableProvider(),
  ].map((provider) => ({
    ...provider,
    async *search() {
      if (provider.id === 'lever') throw new Error('Synthetic unavailable ATS');
      for (let index = 0; index < 25; index += 1)
        yield {
          source: provider.id,
          sourceJobId: `${provider.id}-${index}`,
          title: `React Engineer ${index}`,
          companyName: 'Synthetic',
          location: 'Remote',
          description: 'React',
          hasFullDescription: false,
          sourceUrl: `https://example.test/${provider.id}/${index}`,
          applyUrl: `https://example.test/apply/${index}`,
        };
    },
    ...(provider.id === 'greenhouse'
      ? {
          async fetchDetail(job: Parameters<NonNullable<typeof provider.fetchDetail>>[0]) {
            details += 1;
            if (details === 1) throw new Error('Synthetic detail failure');
            return {
              ...job,
              description: 'Build React interfaces. '.repeat(20),
              hasFullDescription: true,
            };
          },
        }
      : { fetchDetail: undefined }),
  }));
  const result = await collect(
    { query: 'React', sources: ['remoteok', 'himalayas', 'greenhouse', 'lever', 'workable'] },
    signal,
    providers,
  );
  assert.equal(details, 20);
  assert.equal(result.status, 'partial');
  assert.equal(result.outcomes.length, 5);
  assert.equal(
    result.outcomes.find((outcome) => outcome.source === 'lever')?.errorCode,
    'source_failed',
  );
  assert.equal(
    result.outcomes.find((outcome) => outcome.source === 'greenhouse')?.errorCode,
    'source_failed',
  );
  assert.equal(result.outcomes.find((outcome) => outcome.source === 'workable')?.accepted, 25);
  assert.equal(result.jobs.length, 25);
  assert.ok(result.jobs.every((job) => job.sourceLinks?.length === 4));
  assert.ok(result.jobs.some((job) => job.description.length > 100));
});

test('ATS detail timeout retains its listing while whole-search cancellation still rejects', async (context) => {
  const deadline = new AbortController();
  const timeout = AbortSignal.timeout;
  context.mock.method(AbortSignal, 'timeout', (milliseconds: number) =>
    milliseconds === 25_000 ? deadline.signal : timeout(milliseconds),
  );
  const control = new AbortController();
  const provider = {
    ...createGreenhouseProvider(),
    async *search() {
      yield {
        source: 'greenhouse' as const,
        sourceJobId: 'synthetic:123',
        title: 'React Engineer',
        companyName: 'Synthetic',
        location: 'Remote',
        sourceUrl: 'https://example.test/123',
        applyUrl: 'https://example.test/123',
        hasFullDescription: false,
      };
    },
    async fetchDetail(): Promise<never> {
      deadline.abort(new DOMException('Synthetic deadline', 'TimeoutError'));
      throw deadline.signal.reason;
    },
  };
  const result = await collect({ query: 'React', sources: ['greenhouse'] }, signal, provider);
  assert.equal(result.status, 'partial');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0]!.description, '');
  assert.equal(result.outcomes[0]!.accepted, 1);
  assert.equal(result.outcomes[0]!.errorCode, 'source_timeout');
  context.mock.restoreAll();
  await assert.rejects(
    collect({ query: 'React', sources: ['greenhouse'] }, control.signal, {
      ...provider,
      async fetchDetail(): Promise<never> {
        control.abort();
        throw control.signal.reason;
      },
    }),
    { name: 'AbortError' },
  );
});

test(
  'five source deadlines complete within the real overall acquisition bound',
  { timeout: 65_000 },
  async () => {
    const started: string[] = [];
    const elapsed: number[] = [];
    const providers = [
      createRemoteOkProvider(),
      createHimalayasProvider(),
      createGreenhouseProvider(),
      createLeverProvider(),
      createWorkableProvider(),
    ].map((provider) => ({
      ...provider,
      async *search(
        _query: Parameters<typeof provider.search>[0],
        context: Parameters<typeof provider.search>[1],
      ): AsyncGenerator<never> {
        assert.equal(_query.titles.length, 5);
        yield* [];
        started.push(provider.id);
        const beginning = performance.now();
        try {
          await delay(60_000, undefined, { signal: context.signal });
          assert.fail('Provider exceeded its acquisition budget');
        } finally {
          elapsed.push(performance.now() - beginning);
        }
      },
    }));
    const beginning = performance.now();
    const result = await collect(
      {
        query: 'Saved target roles',
        useProfileTitles: true,
        sources: ['remoteok', 'himalayas', 'greenhouse', 'lever', 'workable'],
      },
      signal,
      providers,
      undefined,
      {
        profile: matchingProfile(
          writableProfileSchema.parse({
            candidate: {
              fullName: 'Synthetic Candidate',
              email: 'synthetic@example.test',
              location: 'Remote',
            },
            preferences: {
              titles: [
                'React Engineer',
                'Frontend Developer',
                'UI Developer',
                'Web Engineer',
                'Platform Engineer',
              ],
              techStack: ['React'],
            },
            application: {},
          }),
        ),
      },
    );
    const total = performance.now() - beginning;
    assert.deepEqual(started, ['remoteok', 'himalayas', 'greenhouse', 'lever', 'workable']);
    assert.equal(elapsed.length, 5);
    assert.ok(
      elapsed.every((milliseconds) => milliseconds >= 10_900 && milliseconds < 12_500),
      JSON.stringify(elapsed),
    );
    assert.ok(total >= 54_500 && total < 60_000, `Acquisition took ${total}ms`);
    assert.equal(result.status, 'failed');
    assert.equal(result.jobs.length, 0);
    assert.ok(result.outcomes.every((outcome) => outcome.errorCode === 'source_timeout'));
  },
);

test('provider scan ceilings remain visible even when no jobs match', async () => {
  let requests = 0;
  const http = new HttpClient({
    retries: 0,
    minIntervalMs: 0,
    fetch: async () => {
      requests += 1;
      return Response.json({
        jobs: [
          {
            guid: `https://himalayas.app/jobs/unmatched-${requests}`,
            title: 'Nurse',
            companyName: 'Synthetic Clinic',
            pubDate: Math.floor(Date.now() / 1000),
          },
        ],
        nextCursor: `page-${requests}`,
        totalCount: 5000,
      });
    },
  });
  const result = await collect(
    { query: 'React', sources: ['himalayas'] },
    signal,
    createHimalayasProvider(),
    http,
  );
  assert.equal(requests, 20);
  assert.equal(result.jobs.length, 0);
  assert.equal(result.outcomes[0]?.limited, true);
  assert.equal(result.outcomes[0]?.errorCode, null);
});

test('combined collection bounds each provider and returns at most 100 unique results', async () => {
  let read = 0;
  const provider = {
    ...createRemoteOkProvider(),
    async *search() {
      for (let index = 0; index < 200; index += 1) {
        read += 1;
        yield {
          source: 'remoteok' as const,
          sourceJobId: String(index),
          title: `React Engineer ${index}`,
          companyName: 'Example',
          location: 'Remote',
          description: 'React',
          sourceUrl: `https://remoteok.com/remote-jobs/${index}`,
          applyUrl: 'https://example.test/apply',
        };
      }
    },
  };
  const { jobs: result, outcomes } = await collect(request, signal, provider);
  assert.equal(read, 100);
  assert.equal(outcomes[0]!.limited, true);
  assert.equal(result.length, 100);
  assert.equal(new Set(result.map((job) => job.fingerprint)).size, 100);
});

test('profile matching preserves exclusions, confidence ceilings and company flags', async () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  const profile = matchingProfile(
    writableProfileSchema.parse({
      candidate: { fullName: 'Example', email: 'example@example.test', location: 'Hyderabad' },
      preferences: {
        titles: ['React Engineer'],
        techStack: ['React', 'TypeScript'],
        excludeKeywords: ['PHP'],
        excludeCompanies: ['Flagged Inc'],
        employmentTypes: ['fulltime'],
      },
      application: { yearsOfExperience: 4 },
    }),
  );
  const base = {
    source: 'remoteok' as const,
    sourceJobId: 'full',
    title: 'React Engineer',
    companyName: 'Example',
    location: 'Remote',
    isRemote: true,
    employmentType: 'fulltime' as const,
    hasFullDescription: true,
    postedAt: new Date(now).toISOString(),
    description: 'Build React and TypeScript interfaces with four years of experience. '.repeat(10),
    sourceUrl: 'https://remoteok.com/remote-jobs/fixture',
    applyUrl: 'https://example.test/apply',
  };
  const provider = {
    ...createRemoteOkProvider(),
    async *search() {
      yield base;
      yield {
        ...base,
        sourceJobId: 'snippet',
        companyName: 'Flagged Inc',
        description: 'React role',
        hasFullDescription: false,
      };
      yield {
        ...base,
        sourceJobId: 'contract',
        companyName: 'Contract Co',
        employmentType: 'contract' as const,
      };
      yield {
        ...base,
        sourceJobId: 'excluded',
        companyName: 'Excluded Co',
        description: 'Develop PHP systems',
      };
    },
  };
  const { jobs: results } = await collect(request, signal, provider, undefined, { profile, now });
  assert.equal(results.length, 2);
  const full = results.find((job) => job.company === 'Example')!;
  const snippet = results.find((job) => job.company === 'Flagged Inc')!;
  assert.equal(full.match?.confidence, 'high');
  assert.equal(snippet.match?.confidence, 'low');
  assert.ok(snippet.match!.score <= LOW_CONFIDENCE_SCORE_CEILING);
  assert.equal(snippet.match?.flaggedCompany, true);
  assert.equal(full.match?.llmScore, null);
  assert.ok(full.match!.matchedSkills.includes('React'));
  assert.deepEqual(
    (await collect(request, signal, provider, undefined, { profile, now })).jobs,
    results,
  );
});

test('source failure and cancellation cannot masquerade as successful empty searches', async () => {
  const http = new HttpClient({
    retries: 0,
    fetch: async () => new Response('unavailable', { status: 503 }),
  });
  const result = await collect(request, signal, createRemoteOkProvider(), http);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.jobs, []);
  assert.equal(result.outcomes[0]!.errorCode, 'source_failed');
  await assert.rejects(collect(request, AbortSignal.abort(), createRemoteOkProvider(), http), {
    name: 'AbortError',
  });
});

test('malformed source rows are excluded while successful empty sources remain explicit', async () => {
  const valid = {
    source: 'remoteok' as const,
    sourceJobId: 'safe',
    title: 'React Engineer',
    companyName: 'Synthetic',
    location: 'Remote',
    description: 'Validated fixture',
    sourceUrl: 'https://remoteok.com/remote-jobs/safe',
    applyUrl: 'https://example.test/apply',
  };
  const invalid = {
    ...createRemoteOkProvider(),
    async *search() {
      yield valid;
      yield {
        ...valid,
        source: 'himalayas' as const,
        sourceJobId: 'unsafe',
        applyUrl: 'javascript:alert(1)',
      };
      throw new Error('Invalid response must close the iterator');
    },
  };
  const empty = {
    ...createHimalayasProvider(),
    async *search() {
      yield* [];
    },
  };
  const result = await collect({ ...request, sources: ['remoteok', 'himalayas'] }, signal, [
    invalid,
    empty,
  ]);
  assert.equal(result.status, 'partial');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.outcomes[0]!.errorCode, 'invalid_response');
  assert.equal(result.outcomes[0]!.accepted, 1);
  assert.deepEqual(result.outcomes[1], {
    source: 'himalayas',
    status: 'completed',
    accepted: 0,
    limited: false,
    errorCode: null,
  });
  const successfulEmpty = await collect({ ...request, sources: ['himalayas'] }, signal, empty);
  assert.equal(successfulEmpty.status, 'completed');
  assert.deepEqual(successfulEmpty.jobs, []);
  await assert.rejects(collect(request, signal, [invalid, invalid]), /Providers must match/);
});
