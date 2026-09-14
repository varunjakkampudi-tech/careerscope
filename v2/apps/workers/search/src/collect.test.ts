import assert from 'node:assert/strict';
import test from 'node:test';
import { collect } from './collect.js';
import { matchingProfile, writableProfileSchema } from '@careerscope/core';
import { LOW_CONFIDENCE_SCORE_CEILING } from '../../../../../packages/shared/dist/index.js';
import {
  createRemoteOkProvider,
  createHimalayasProvider,
  HttpClient,
} from '../../../../../packages/providers/dist/index.js';

const request = { query: 'React', sources: ['remoteok'] as ['remoteok'] };
const signal = new AbortController().signal;

test('multi-source collection deduplicates before matching and stops on a selected source failure', async () => {
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
  const result = await collect(request, signal, [remote, himalayas]);
  assert.equal(result.length, 2);
  assert.equal(result.find((job) => job.company === 'Example')?.source, 'himalayas');
  const failing = {
    ...himalayas,
    async *search() {
      yield raw;
      throw new Error('Synthetic source failure');
    },
  };
  await assert.rejects(collect(request, signal, [remote, failing]), /Synthetic source failure/);
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
  await assert.rejects(collect(request, control.signal, [cancelling, uncalled]), {
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
  const results = await collect(request, signal, createRemoteOkProvider(), http);
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
  const result = await collect({ query: 'React', sources: ['himalayas'] }, signal, undefined, http);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.startsWith('https://himalayas.app/jobs/api?limit=100')));
  assert.ok(urls[1]!.includes('cursor=next-page'));
  assert.equal(result.length, 2);
  assert.ok(result.every((job) => job.source === 'himalayas' && job.location === 'India'));
  assert.equal(result[0]!.description, 'Build React interfaces.');
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
  const result = await collect(request, signal, [provider, provider]);
  assert.equal(read, 200);
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
  const results = await collect(request, signal, provider, undefined, { profile, now });
  assert.equal(results.length, 2);
  const full = results.find((job) => job.company === 'Example')!;
  const snippet = results.find((job) => job.company === 'Flagged Inc')!;
  assert.equal(full.match?.confidence, 'high');
  assert.equal(snippet.match?.confidence, 'low');
  assert.ok(snippet.match!.score <= LOW_CONFIDENCE_SCORE_CEILING);
  assert.equal(snippet.match?.flaggedCompany, true);
  assert.equal(full.match?.llmScore, null);
  assert.ok(full.match!.matchedSkills.includes('React'));
  assert.deepEqual(await collect(request, signal, provider, undefined, { profile, now }), results);
});

test('source failure and cancellation cannot masquerade as successful empty searches', async () => {
  const http = new HttpClient({
    retries: 0,
    fetch: async () => new Response('unavailable', { status: 503 }),
  });
  await assert.rejects(
    collect(request, signal, createRemoteOkProvider(), http),
    /Provider collection failed/,
  );
  await assert.rejects(collect(request, AbortSignal.abort(), createRemoteOkProvider(), http), {
    name: 'AbortError',
  });
});
