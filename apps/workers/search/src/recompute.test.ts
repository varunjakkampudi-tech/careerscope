import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildCandidateContext, scoreJob } from '@careerscope/matching';
import {
  matchingProfile,
  writableProfileSchema,
  type Database,
  type Command,
} from '@careerscope/core';
import { normalizeJob } from '@careerscope/providers';
import { resumeRecomputeHandler } from './recompute.js';

const command: Command = {
  id: randomUUID(),
  type: 'search.recompute',
  version: 1,
  aggregateId: randomUUID(),
  ownerId: randomUUID(),
  occurredAt: new Date().toISOString(),
  correlationId: randomUUID(),
};

const profile = matchingProfile(
  writableProfileSchema.parse({
    candidate: {
      fullName: 'Synthetic Candidate',
      email: 'synthetic@example.test',
      location: 'Hyderabad',
    },
    preferences: { titles: ['Platform Engineer'], techStack: ['React'] },
    application: {},
  }),
  {
    techStack: ['Kubernetes'],
    recentSkills: [],
    titles: [],
    yearsOfExperience: null,
    education: [],
    educationClaims: [],
    experienceClaims: [],
    extractionEvidence: [],
  },
);
const priorProfile = matchingProfile(
  writableProfileSchema.parse({
    candidate: {
      fullName: 'Synthetic Candidate',
      email: 'synthetic@example.test',
      location: 'Hyderabad',
    },
    preferences: { titles: ['Platform Engineer'], techStack: ['React'] },
    application: {},
  }),
);

function fakeJob() {
  return normalizeJob(
    {
      source: 'remoteok',
      sourceJobId: 'synthetic-job',
      title: 'Platform Engineer',
      companyName: 'Example',
      location: 'Remote',
      isRemote: true,
      hasFullDescription: true,
      description: 'Build and operate Kubernetes infrastructure. '.repeat(15),
      sourceUrl: 'https://example.test/jobs/platform',
      applyUrl: 'https://example.test/apply/platform',
    },
    { now: Date.parse('2026-11-01T12:00:00Z') },
  );
}

test('resume recompute re-scores completed matches and preserves each search profile snapshot', async () => {
  const job = fakeJob();
  const searchId = randomUUID();
  let completion: unknown;
  const database = {
    async resumeRecomputeSnapshot(ownerId: string) {
      assert.equal(ownerId, command.ownerId);
      return {
        searches: [
          {
            id: searchId,
            createdAt: new Date('2026-11-01T12:00:00Z'),
            status: 'completed' as const,
            profileRevision: 4,
            matchingProfile: { ...priorProfile, derived: profile.derived },
            jobs: [
              {
                runId: searchId,
                fingerprint: job.fingerprint,
                data: {
                  matchingInput: job,
                },
              },
            ],
          },
        ],
      };
    },
    async completeResumeRecompute(_command: Command, _fence: number, result: unknown) {
      completion = result;
      return true;
    },
  } as unknown as Database;

  assert.equal(
    await resumeRecomputeHandler(database)(command, 1, new AbortController().signal),
    true,
  );
  const saved = completion as {
    searches: Array<{
      id: string;
      profileRevision: number;
      matchingProfile: typeof profile;
      jobs: Array<{ match: { matchedSkills: string[] } }>;
    }>;
  };
  assert.equal(saved.searches[0]!.id, searchId);
  assert.equal(saved.searches[0]!.profileRevision, 4);
  assert.deepEqual(saved.searches[0]!.matchingProfile.derived, profile.derived);
  assert.ok(saved.searches[0]!.jobs[0]!.match.matchedSkills.includes('Kubernetes'));
});

test('legacy result rows are rescored from display fields while preserving non-resume dimensions', async () => {
  let completion: unknown;
  const job = fakeJob();
  const previousMatch = scoreJob(job, buildCandidateContext(priorProfile), {
    now: Date.parse('2026-11-01T12:00:00Z'),
  });
  const database = {
    async resumeRecomputeSnapshot() {
      return {
        searches: [
          {
            id: randomUUID(),
            createdAt: new Date(),
            status: 'partial' as const,
            profileRevision: 1,
            matchingProfile: profile,
            jobs: [
              {
                runId: randomUUID(),
                fingerprint: job.fingerprint,
                data: {
                  fingerprint: job.fingerprint,
                  sourceJobId: job.sourceJobId,
                  title: job.title,
                  company: job.company.name,
                  location: job.location,
                  description: job.descriptionText,
                  source: job.source,
                  sourceUrl: job.sourceUrl,
                  applyUrl: job.applyUrl,
                  postedAt: job.postedAt,
                  match: previousMatch,
                },
              },
            ],
          },
        ],
      };
    },
    async completeResumeRecompute(_command: Command, _fence: number, result: unknown) {
      completion = result;
      return true;
    },
  } as unknown as Database;
  const handler = resumeRecomputeHandler(database);
  const result = await handler(command, 1, new AbortController().signal);
  assert.equal(result, true);
  const saved = completion as {
    searches: Array<{ jobs: Array<{ match: typeof previousMatch }> }>;
  };
  assert.ok(saved.searches[0]!.jobs[0]!.match.resumeSkills.includes('Kubernetes'));
  assert.deepEqual(
    saved.searches[0]!.jobs[0]!.match.dimensions.compensation,
    previousMatch.dimensions.compensation,
  );
});

test('cancelled recompute does not read or commit a snapshot', async () => {
  let read = false;
  const database = {
    async resumeRecomputeSnapshot() {
      read = true;
      return { searches: [] };
    },
    async completeResumeRecompute() {
      throw new Error('must not commit after cancellation');
    },
  } as unknown as Database;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resumeRecomputeHandler(database)(command, 1, controller.signal));
  assert.equal(read, false);
});
