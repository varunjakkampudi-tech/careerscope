/**
 * Builders for the repo tests.
 *
 * Everything here produces a value that has already been through its Zod schema,
 * so a fixture cannot drift away from the wire contract without failing at the
 * point it is built rather than three assertions later.
 *
 * The database is `:memory:`, but `dataDir` is still a real temp directory
 * because `ResumeRepo` writes files. Both are torn down by `cleanup()`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MATCH_WEIGHTS,
  jobSchema,
  matchBreakdownSchema,
  profileSchema,
  searchRequestSchema,
  skillGapQuerySchema,
  type Job,
  type LeadQuery,
  type MatchBreakdown,
  type Profile,
  type SearchRequest,
  type SkillGapQuery,
} from '@job-radar/shared';
import { openDatabase, type Db } from '../index.js';
import { createRepos, type Repos } from './index.js';
import { LOCAL_PROFILE_ID } from '../../util/ids.js';

/** A fixed clock. Tests that care about ordering pass their own timestamps. */
export const NOW = '2026-09-05T10:00:00.000Z';

export interface TestRepos extends Repos {
  db: Db;
  dataDir: string;
  cleanup(): void;
}

export function createTestRepos(): TestRepos {
  const dataDir = mkdtempSync(join(tmpdir(), 'job-radar-test-'));
  const db = openDatabase(':memory:');
  return {
    ...createRepos(db, dataDir),
    db,
    dataDir,
    cleanup() {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function makeProfile(overrides: Partial<Profile> = {}): Profile {
  const { candidate, preferences, application, ...rest } = overrides;
  return profileSchema.parse({
    id: LOCAL_PROFILE_ID,
    candidate: {
      fullName: 'Test Candidate',
      email: 'test@example.com',
      location: 'Hyderabad, India',
      ...candidate,
    },
    preferences: {
      titles: ['Senior Software Engineer'],
      techStack: ['TypeScript', 'React', 'Node.js'],
      ...preferences,
    },
    application: { yearsOfExperience: 6, ...application },
    ...rest,
  });
}

type JobOverrides = Partial<Omit<Job, 'company' | 'salary' | 'requiredYears'>> & {
  company?: Partial<Job['company']>;
  salary?: Partial<Job['salary']>;
  requiredYears?: Partial<Job['requiredYears']>;
};

/**
 * `id` follows `fingerprint` unless told otherwise, because `normalizeJob` sets
 * them to the same value and every upsert path depends on that being true.
 */
export function makeJob(overrides: JobOverrides = {}): Job {
  const { company, salary, requiredYears, ...rest } = overrides;
  const fingerprint = rest.fingerprint ?? 'fp-acme-sse';
  return jobSchema.parse({
    id: rest.id ?? fingerprint,
    fingerprint,
    source: 'greenhouse',
    sourceJobId: 'gh-1',
    title: 'Senior Software Engineer',
    company: { id: 'acme-corp', name: 'Acme Corp', ...company },
    location: 'Hyderabad, India',
    isRemote: false,
    employmentType: 'fulltime',
    salary: {
      raw: null,
      min: null,
      max: null,
      currency: null,
      period: null,
      annualMin: null,
      annualMax: null,
      ...salary,
    },
    postedAt: '2026-09-01T00:00:00.000Z',
    descriptionText: 'Build and ship product surfaces.',
    hasFullDescription: true,
    techStack: ['TypeScript'],
    requiredYears: { min: null, max: null, ...requiredYears },
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    ...rest,
  });
}

/** Writes the company row the job's FK needs, then the job. */
export function storeJob(repos: Repos, job: Job, at: string = NOW): Job {
  repos.companies.upsertFromJob(job, at);
  return repos.jobs.upsert(job, at);
}

export function makeBreakdown(
  score = 0.9,
  overrides: Partial<MatchBreakdown> = {},
): MatchBreakdown {
  return matchBreakdownSchema.parse({
    score,
    heuristicScore: score,
    dimensions: Object.fromEntries(
      Object.entries(MATCH_WEIGHTS).map(([dimension, weight]) => [
        dimension,
        { score, weight, reason: 'fixture' },
      ]),
    ),
    matchedSkills: ['TypeScript'],
    missingSkills: [],
    confidence: 'high',
    ...overrides,
  });
}

/** A `LeadQuery` with every defaulted field filled, since the repo takes the parsed shape. */
export function makeQuery(overrides: Partial<LeadQuery> = {}): LeadQuery {
  return { minScore: 0, sort: 'score', order: 'desc', limit: 50, offset: 0, ...overrides };
}

/** Likewise for the skill-gap aggregate. Defaults come from the schema, not from here. */
export function makeSkillGapQuery(overrides: Partial<SkillGapQuery> = {}): SkillGapQuery {
  return skillGapQuerySchema.parse(overrides);
}

export function makeSearchRequest(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return searchRequestSchema.parse({ sources: ['greenhouse'], ...overrides });
}
