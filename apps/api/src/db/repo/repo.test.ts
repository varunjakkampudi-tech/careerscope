/**
 * Repo behaviour tests.
 *
 * These do not test that SQLite can store a row. They test the handful of rules
 * that are encoded in SQL and would regress silently: which observation wins on
 * conflict, what enrichment is allowed to overwrite, what automation must never
 * touch, and what is safe to delete. Every one of them is a decision documented
 * in the repo it belongs to; this file is what keeps the documentation true.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Lead, MatchBreakdown, SearchRequest } from '@job-radar/shared';
import {
  NOW,
  createTestRepos,
  makeBreakdown,
  makeJob,
  makeProfile,
  makeQuery,
  makeSearchRequest,
  makeSkillGapQuery,
  storeJob,
  type TestRepos,
} from './repo.fixtures.js';
import { SETTING } from './index.js';

let repos: TestRepos;

beforeEach(() => {
  repos = createTestRepos();
  // Leads and runs both FK to a profile, so every suite needs one.
  repos.profiles.save(makeProfile(), NOW);
});

afterEach(() => {
  repos.cleanup();
});

/* -------------------------------------------------------------------------- */
/* Jobs — the merge rule                                                      */
/* -------------------------------------------------------------------------- */

describe('JobRepo.upsert', () => {
  /** The same posting as an ATS would report it: full JD, real apply form. */
  const ats = () =>
    makeJob({
      source: 'greenhouse',
      descriptionText: 'A long and complete job description, several paragraphs of it.',
      hasFullDescription: true,
      techStack: ['TypeScript', 'React', 'PostgreSQL'],
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/1/apply',
      salary: { raw: '₹28L – ₹38L', annualMin: 2_800_000, annualMax: 3_800_000, currency: 'INR' },
    });

  /** The same posting as an aggregator reports it: snippet, tracking link. */
  const aggregator = () =>
    makeJob({
      source: 'jsearch',
      sourceJobId: 'js-1',
      descriptionText: 'Short teaser…',
      hasFullDescription: false,
      techStack: ['TypeScript'],
      applyUrl: 'https://aggregator.example/redirect?id=1',
      salary: { raw: 'Competitive' },
      sourcePublisher: 'LinkedIn',
    });

  it('keeps the richer observation when the ATS arrives second', () => {
    storeJob(repos, aggregator());
    const merged = storeJob(repos, ats());

    expect(repos.jobs.count()).toBe(1);
    expect(merged.descriptionText).toContain('several paragraphs');
    expect(merged.hasFullDescription).toBe(true);
    expect(merged.techStack).toEqual(['TypeScript', 'React', 'PostgreSQL']);
    expect(merged.salary.annualMax).toBe(3_800_000);
    // The tracking link is replaced by the real form.
    expect(merged.applyUrl).toContain('greenhouse.io');
  });

  it('keeps the richer observation when the ATS arrives first', () => {
    storeJob(repos, ats());
    const merged = storeJob(repos, aggregator());

    expect(repos.jobs.count()).toBe(1);
    expect(merged.descriptionText).toContain('several paragraphs');
    expect(merged.hasFullDescription).toBe(true);
    expect(merged.techStack).toEqual(['TypeScript', 'React', 'PostgreSQL']);
    // "Competitive" must never displace a real figure.
    expect(merged.salary.raw).toBe('₹28L – ₹38L');
    expect(merged.salary.annualMax).toBe(3_800_000);
    expect(merged.applyUrl).toContain('greenhouse.io');
  });

  it('fills a blank from the later observation without overwriting a known value', () => {
    storeJob(repos, makeJob({ postedAt: null, employmentType: null, sourcePublisher: null }));
    const merged = storeJob(
      repos,
      makeJob({
        postedAt: '2026-08-20T00:00:00.000Z',
        employmentType: 'contract',
        sourcePublisher: 'Indeed',
      }),
    );

    expect(merged.postedAt).toBe('2026-08-20T00:00:00.000Z');
    expect(merged.employmentType).toBe('contract');
    expect(merged.sourcePublisher).toBe('Indeed');
  });

  it.each([true, false])('prefers a full JD over a longer snippet, full first: %s', (fullFirst) => {
    const full = { ...ats(), requiredYears: { min: 3, max: 5 } };
    const snippet = {
      ...aggregator(),
      descriptionText: 'A verbose email teaser with no complete requirements. '.repeat(10),
      techStack: ['TypeScript', 'React', 'PostgreSQL', 'Python', 'Java'],
      requiredYears: { min: 8, max: 10 },
    };
    storeJob(repos, fullFirst ? full : snippet);
    const merged = storeJob(repos, fullFirst ? snippet : full);
    expect(merged.descriptionText).toBe(full.descriptionText);
    expect(merged.techStack).toEqual(full.techStack);
    expect(merged.requiredYears).toEqual(full.requiredYears);
    expect(merged.hasFullDescription).toBe(true);
  });

  it('always advances last_seen_at', () => {
    storeJob(repos, makeJob(), '2026-09-01T00:00:00.000Z');
    const merged = storeJob(repos, makeJob(), '2026-09-05T00:00:00.000Z');

    expect(merged.firstSeenAt).toBe('2026-09-01T00:00:00.000Z');
    expect(merged.lastSeenAt).toBe('2026-09-05T00:00:00.000Z');
  });
});

describe('JobRepo.pruneStale', () => {
  it('deletes an old job but never one attached to a lead', () => {
    const orphan = storeJob(
      repos,
      makeJob({ fingerprint: 'fp-orphan' }),
      '2026-01-01T00:00:00.000Z',
    );
    const applied = storeJob(
      repos,
      makeJob({ fingerprint: 'fp-applied' }),
      '2026-01-01T00:00:00.000Z',
    );
    repos.leads.upsert({ jobId: applied.id, runId: null, breakdown: makeBreakdown() }, NOW);

    expect(repos.jobs.pruneStale('2026-06-01T00:00:00.000Z')).toBe(1);
    expect(repos.jobs.get(orphan.id)).toBeNull();
    expect(repos.jobs.get(applied.id)).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Leads                                                                      */
/* -------------------------------------------------------------------------- */

describe('LeadRepo.upsert', () => {
  it('re-scores without touching the status or note the user set', () => {
    const job = storeJob(repos, makeJob());
    const first = repos.leads.upsert(
      { jobId: job.id, runId: null, breakdown: makeBreakdown(0.7) },
      NOW,
    );
    repos.leads.update(first.id, { status: 'applied', note: 'Referred by Priya' }, NOW);

    const rescored = repos.leads.upsert(
      { jobId: job.id, runId: null, breakdown: makeBreakdown(0.92) },
      '2026-09-06T00:00:00.000Z',
    );

    expect(rescored.id).toBe(first.id);
    expect(rescored.match.score).toBeCloseTo(0.92);
    expect(rescored.status).toBe('applied');
    expect(rescored.note).toBe('Referred by Priya');
  });

  it('re-points the lead at the run that found it again', () => {
    const job = storeJob(repos, makeJob());
    const run = repos.runs.create(makeSearchRequest(), NOW);
    repos.leads.upsert({ jobId: job.id, runId: null, breakdown: makeBreakdown() }, NOW);
    const rescored = repos.leads.upsert(
      { jobId: job.id, runId: run.id, breakdown: makeBreakdown() },
      NOW,
    );

    expect(rescored.runId).toBe(run.id);
    expect(repos.leads.byRun(run.id)).toHaveLength(1);
  });
});

describe('LeadRepo.page', () => {
  beforeEach(() => {
    const strong = storeJob(repos, makeJob({ fingerprint: 'fp-strong', source: 'greenhouse' }));
    const weak = storeJob(
      repos,
      makeJob({ fingerprint: 'fp-weak', source: 'lever', sourceJobId: 'lv-1' }),
    );
    repos.leads.upsert({ jobId: strong.id, runId: null, breakdown: makeBreakdown(0.91) }, NOW);
    repos.leads.upsert({ jobId: weak.id, runId: null, breakdown: makeBreakdown(0.42) }, NOW);
  });

  it('filters by score', () => {
    const page = repos.leads.page(makeQuery({ minScore: 0.85 }));
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
  });

  it('counts facets over the set before the threshold is applied', () => {
    const page = repos.leads.page(makeQuery({ minScore: 0.85 }));

    // The summary strip reads "2 leads · 1 at ≥85%". If facets honoured the
    // threshold this would be 1 and 1, and the slider would always say 100%.
    expect(page.facets.bySource).toEqual({ greenhouse: 1, lever: 1 });
    expect(page.facets.byStatus).toEqual({ new: 2 });
    expect(page.facets.aboveThreshold).toBe(1);
  });

  it('keeps other source choices available while selecting and removing sources', () => {
    for (const sources of [['greenhouse'], ['greenhouse', 'lever'], ['lever']] as const) {
      const page = repos.leads.page(makeQuery({ sources: [...sources] }));
      expect(page.total).toBe(sources.length);
      expect(page.items.map((lead) => lead.job.source).sort()).toEqual([...sources].sort());
      expect(page.facets.bySource).toEqual({ greenhouse: 1, lever: 1 });
      expect(page.facets.byStatus).toEqual({ new: sources.length });
      expect(page.facets.aboveThreshold).toBe(sources.length);
    }
    const empty = repos.leads.page(makeQuery({ sources: ['greenhouse'], statuses: ['applied'] }));
    expect(empty.facets.bySource).toEqual({});
  });

  it('filters by source, status and free text', () => {
    expect(repos.leads.page(makeQuery({ sources: ['lever'] })).total).toBe(1);
    expect(repos.leads.page(makeQuery({ statuses: ['applied'] })).total).toBe(0);
    expect(repos.leads.page(makeQuery({ search: 'ship product' })).total).toBe(2);
    expect(repos.leads.page(makeQuery({ search: 'nothing matches this' })).total).toBe(0);
  });
});

describe('LeadRepo.page sorting', () => {
  beforeEach(() => {
    const withSalary = (fingerprint: string, annualMax: number | null) =>
      storeJob(repos, makeJob({ fingerprint, salary: { annualMin: annualMax, annualMax } }));
    for (const [fingerprint, salary] of [
      ['fp-low', 1_000_000],
      ['fp-none', null],
      ['fp-high', 4_000_000],
    ] as const) {
      const job = withSalary(fingerprint, salary);
      repos.leads.upsert({ jobId: job.id, runId: null, breakdown: makeBreakdown(0.9) }, NOW);
    }
  });

  const fingerprints = (leads: Lead[]) => leads.map((lead) => lead.job.fingerprint);

  it('puts unknown salaries last in both directions', () => {
    // "We don't know" belongs at the bottom of "highest paying" and at the
    // bottom of "lowest paying" alike.
    expect(
      fingerprints(repos.leads.page(makeQuery({ sort: 'salary', order: 'desc' })).items),
    ).toEqual(['fp-high', 'fp-low', 'fp-none']);
    expect(
      fingerprints(repos.leads.page(makeQuery({ sort: 'salary', order: 'asc' })).items),
    ).toEqual(['fp-low', 'fp-high', 'fp-none']);
  });

  it('paginates', () => {
    const page = repos.leads.page(makeQuery({ sort: 'salary', limit: 2, offset: 0 }));
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(repos.leads.page(makeQuery({ sort: 'salary', limit: 2, offset: 2 })).items).toHaveLength(
      1,
    );
  });
});

/**
 * The skill-gap aggregate.
 *
 * These assertions are the documentation for what the panel is allowed to
 * claim. Each one pins a subtraction that is invisible in the output: a lead
 * that was counted, or one that deliberately was not.
 */
describe('LeadRepo.skillGap', () => {
  /** `threshold` 0.85 and `band` 0.15 put the near-miss window at [0.70, 0.85). */
  const seed = (
    fingerprint: string,
    score: number,
    overrides: Partial<MatchBreakdown> = {},
    status?: 'dismissed',
  ): void => {
    const job = storeJob(repos, makeJob({ fingerprint, sourceJobId: fingerprint }));
    const lead = repos.leads.upsert(
      { jobId: job.id, runId: null, breakdown: makeBreakdown(score, overrides) },
      NOW,
    );
    if (status) repos.leads.update(lead.id, { status }, NOW);
  };

  beforeEach(() => {
    // Inside the window.
    seed('fp-near-a', 0.8, { missingSkills: ['Kafka', 'Go'], matchedSkills: ['TypeScript'] });
    // Exactly on the floor — `>= floor` means this one counts.
    seed('fp-near-b', 0.7, { missingSkills: ['kafka'], matchedSkills: ['TypeScript'] });
    // Exactly on the threshold — `< threshold` means this one does not.
    seed('fp-at-threshold', 0.85, {
      missingSkills: ['Kafka', 'Rust'],
      matchedSkills: ['TypeScript'],
    });
    // Below the floor.
    seed('fp-weak', 0.4, { missingSkills: ['Go'], matchedSkills: [] });

    // The three exclusions, all scored inside the window so that counting them
    // would be visible rather than coincidentally invisible.
    seed('fp-dismissed', 0.78, { missingSkills: ['Elixir'] }, 'dismissed');
    seed('fp-low-confidence', 0.79, { missingSkills: ['Scala'], confidence: 'low' });
    seed('fp-gated', 0.76, { missingSkills: ['Perl'], excludedReason: 'employment type' });
  });

  it('ranks what the near misses asked for and did not find', () => {
    const result = repos.leads.skillGap(makeSkillGapQuery());

    expect(result.threshold).toBe(0.85);
    expect(result.nearMissFloor).toBe(0.7);
    expect(result.totalLeads).toBe(4);
    expect(result.nearMissLeads).toBe(2);

    // "Kafka" and "kafka" are one gap, and the label is the capitalised form.
    expect(result.gaps.map((gap) => gap.skill)).toEqual(['Kafka', 'Go']);

    const [kafka, go] = result.gaps;
    expect(kafka).toMatchObject({ skill: 'Kafka', nearMissCount: 2, totalCount: 3 });
    expect(kafka?.averageScore).toBeCloseTo(0.75, 5);
    expect(go).toMatchObject({ skill: 'Go', nearMissCount: 1, totalCount: 2 });
    expect(go?.averageScore).toBeCloseTo(0.8, 5);
  });

  it('leaves out skills only the leads outside the window wanted', () => {
    const skills = repos.leads.skillGap(makeSkillGapQuery()).gaps.map((gap) => gap.skill);

    // Rust was demanded once, by the lead that already clears the threshold.
    // Reporting it as a gap would mean answering "why did I miss?" with a hit.
    expect(skills).not.toContain('Rust');
  });

  it('ignores dismissed, low-confidence and hard-gated leads', () => {
    const result = repos.leads.skillGap(makeSkillGapQuery());
    const skills = result.gaps.map((gap) => gap.skill);

    expect(skills).not.toContain('Elixir'); // the user said no to that posting
    expect(skills).not.toContain('Scala'); // extracted from a snippet, not a JD
    expect(skills).not.toContain('Perl'); // rejected by a gate, not by skills
    expect(result.totalLeads).toBe(4);
  });

  it('counts strengths across every lead, not just the near misses', () => {
    const [typescript, ...rest] = repos.leads.skillGap(makeSkillGapQuery()).strengths;

    expect(typescript).toMatchObject({ skill: 'TypeScript', totalCount: 3, nearMissCount: 2 });
    expect(rest).toEqual([]);
  });

  it('honours the limit', () => {
    expect(repos.leads.skillGap(makeSkillGapQuery({ limit: 1 })).gaps).toHaveLength(1);
  });

  it('falls back to overall demand when nothing landed in the window', () => {
    // A narrow band with a high floor leaves no near misses at all. An empty
    // panel would be the literal answer and a useless one, so the same list
    // ranked by overall demand is shown instead.
    const result = repos.leads.skillGap(makeSkillGapQuery({ threshold: 0.6, band: 0.05 }));

    expect(result.nearMissLeads).toBe(0);
    expect(result.gaps.map((gap) => gap.skill)).toEqual(['Kafka', 'Go', 'Rust']);
    expect(result.gaps.every((gap) => gap.nearMissCount === 0)).toBe(true);
  });
});

describe('LeadRepo bulk operations', () => {
  it('updates many statuses and reports the counts', () => {
    const ids = ['fp-a', 'fp-b', 'fp-c'].map((fingerprint) => {
      const job = storeJob(repos, makeJob({ fingerprint }));
      return repos.leads.upsert({ jobId: job.id, runId: null, breakdown: makeBreakdown() }, NOW).id;
    });

    expect(repos.leads.bulkUpdateStatus(ids.slice(0, 2), 'dismissed', NOW)).toBe(2);
    expect(repos.leads.counts().byStatus).toEqual({ dismissed: 2, new: 1 });
    expect(repos.leads.scoredJobIds().size).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* Companies — enrichment may fill a blank, never downgrade                   */
/* -------------------------------------------------------------------------- */

describe('CompanyRepo', () => {
  it('reopens enrichment when a later source supplies a missing website', () => {
    repos.companies.upsertFromJob(makeJob({ company: { website: null } }), NOW);
    repos.companies.applyResolution('acme-corp', { note: 'No website published' }, NOW);
    repos.companies.upsertFromJob(makeJob({ company: { website: 'https://acme.example' } }), NOW);

    expect(repos.companies.get('acme-corp')).toMatchObject({
      website: 'https://acme.example',
      websiteConfidence: 'probable',
      resolvedAt: null,
    });
    expect(repos.companies.unresolved(['acme-corp'])).toEqual(['acme-corp']);
    repos.companies.applyResolution('acme-corp', {}, NOW);
    repos.companies.upsertFromJob(makeJob({ company: { website: 'https://acme.example' } }), NOW);
    expect(repos.companies.unresolved(['acme-corp'])).toEqual([]);
  });

  it('does not erase a known field when a later board omits it', () => {
    repos.companies.upsertFromJob(
      makeJob({
        company: { website: 'https://acme.example', careersUrl: 'https://acme.example/careers' },
      }),
      NOW,
    );
    repos.companies.upsertFromJob(makeJob({ company: { website: null, careersUrl: null } }), NOW);

    const company = repos.companies.get('acme-corp');
    expect(company?.website).toBe('https://acme.example');
    expect(company?.careersUrl).toBe('https://acme.example/careers');
  });

  it('refuses to replace a verified value with a weaker observation', () => {
    const id = 'acme-corp';
    repos.companies.upsertFromJob(makeJob({ company: { website: 'https://acme.example' } }), NOW);
    repos.companies.applyResolution(
      id,
      { website: 'https://acme.example', websiteConfidence: 'verified' },
      NOW,
    );

    const downgraded = repos.companies.applyResolution(
      id,
      { website: 'https://acme-lookalike.example', websiteConfidence: 'probable' },
      NOW,
    );
    expect(downgraded?.website).toBe('https://acme.example');
    // The confidence has to stay verified too: relabelling it would let the
    // *next* probable observation through.
    expect(downgraded?.websiteConfidence).toBe('verified');

    const upgraded = repos.companies.applyResolution(
      id,
      { website: 'https://acme.co', websiteConfidence: 'verified' },
      NOW,
    );
    expect(upgraded?.website).toBe('https://acme.co');
  });

  it('stamps resolvedAt even when nothing was found', () => {
    repos.companies.upsertFromJob(makeJob(), NOW);
    expect(repos.companies.unresolved(['acme-corp'])).toEqual(['acme-corp']);

    const resolved = repos.companies.applyResolution(
      'acme-corp',
      { note: 'careers page 404' },
      NOW,
    );
    expect(resolved?.resolvedAt).toBe(NOW);
    expect(resolved?.note).toBe('careers page 404');
    expect(repos.companies.unresolved(['acme-corp'])).toEqual([]);
  });

  it('never invents a careers email', () => {
    repos.companies.upsertFromJob(makeJob(), NOW);
    const company = repos.companies.get('acme-corp');
    expect(company?.careersEmail).toBeNull();
    expect(company?.emailConfidence).toBe('unverified');
  });

  it('seeds only entries carrying a verified link, and never clobbers an existing row', () => {
    const seed = [
      {
        name: 'Seeded Co',
        website: 'https://seeded.example',
        websiteNote: 'opened by hand',
        atsPortalUrl: null,
        directListingUrl: null,
        listingNote: null,
        careersEmail: null,
        emailConfidence: 'unverified' as const,
        emailNote: 'no mailto on the careers page',
        excludedFromApply: false,
        verified: true,
      },
      {
        name: 'Nothing Verified Ltd',
        website: null,
        websiteNote: null,
        atsPortalUrl: null,
        directListingUrl: null,
        listingNote: null,
        careersEmail: null,
        emailConfidence: 'unverified' as const,
        emailNote: null,
        excludedFromApply: false,
        verified: false,
      },
    ];

    expect(repos.companies.seed(seed, NOW)).toBe(1);
    const seeded = repos.companies.byName('Seeded Co');
    expect(seeded?.website).toBe('https://seeded.example');
    // A human opened it, which is stronger than anything the resolver produces.
    expect(seeded?.websiteConfidence).toBe('verified');
    expect(seeded?.note).toBe('opened by hand · no mailto on the careers page');
    expect(repos.companies.byName('Nothing Verified Ltd')).toBeNull();

    // Re-seeding is a no-op rather than a rewrite.
    expect(repos.companies.seed(seed, NOW)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Runs and their event stream                                                */
/* -------------------------------------------------------------------------- */

describe('RunRepo', () => {
  it('allocates a gap-free sequence and replays from a given point', () => {
    const run = repos.runs.create(makeSearchRequest(), NOW);

    const seqs = [
      repos.runs.appendEvent(
        run.id,
        { type: 'log', level: 'info', message: 'one', source: null },
        NOW,
      ),
      repos.runs.appendEvent(
        run.id,
        { type: 'log', level: 'info', message: 'two', source: null },
        NOW,
      ),
      repos.runs.appendEvent(
        run.id,
        { type: 'log', level: 'warn', message: 'three', source: null },
        NOW,
      ),
    ];
    expect(seqs).toEqual([1, 2, 3]);

    // What an SSE client resuming with Last-Event-ID: 1 receives.
    const replay = repos.runs.eventsSince(run.id, 1);
    expect(replay.map((stored) => stored.seq)).toEqual([2, 3]);
  });

  it('leaves lead events out of the replay', () => {
    const run = repos.runs.create(makeSearchRequest(), NOW);
    const job = storeJob(repos, makeJob());
    const lead = repos.leads.upsert(
      { jobId: job.id, runId: run.id, breakdown: makeBreakdown() },
      NOW,
    );

    repos.runs.appendEvent(run.id, { type: 'lead', lead }, NOW);
    repos.runs.appendEvent(
      run.id,
      { type: 'log', level: 'info', message: 'done', source: null },
      NOW,
    );

    // A run can emit two hundred leads; the client re-fetches /api/leads anyway.
    expect(repos.runs.eventsSince(run.id, 0)).toHaveLength(1);
    expect(repos.runs.eventsSince(run.id, 0, true)).toHaveLength(2);
    expect(repos.runs.logs(run.id)).toHaveLength(1);
  });

  it('forces the progress bar to complete on failure', () => {
    const run = repos.runs.create(makeSearchRequest(), NOW);
    repos.runs.start(run.id, NOW);
    repos.runs.progress(run.id, 'fetching', 0.4, { ...run.stats, fetched: 12 });
    repos.runs.finish(run.id, 'failed', NOW, 'Greenhouse returned 503');

    const failed = repos.runs.get(run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.progress).toBe(1);
    expect(failed?.error).toBe('Greenhouse returned 503');
    expect(failed?.stats.fetched).toBe(12);
  });

  it('fails runs that a restart left mid-flight', () => {
    const ghost = repos.runs.create(makeSearchRequest(), NOW);
    repos.runs.start(ghost.id, NOW);

    expect(repos.runs.reapOrphans(NOW)).toBe(1);
    expect(repos.runs.get(ghost.id)?.status).toBe('failed');
    expect(repos.runs.active()).toBeNull();
    // The reason is in the stream too, so a reconnecting client is told why.
    expect(repos.runs.eventsSince(ghost.id, 0).map((s) => s.event.type)).toEqual(['error']);
  });

  it('cancels a live run and refuses to rewrite a finished one', () => {
    const live = repos.runs.create(makeSearchRequest(), NOW);
    expect(repos.runs.cancel(live.id, NOW)).toBe(true);
    expect(repos.runs.cancel(live.id, NOW)).toBe(false);
    expect(repos.runs.get(live.id)?.status).toBe('cancelled');
  });

  it('prunes old runs but keeps the leads they found', () => {
    const runs = ['2026-09-01', '2026-09-02', '2026-09-03'].map((day) => {
      const run = repos.runs.create(makeSearchRequest(), `${day}T00:00:00.000Z`);
      repos.runs.finish(run.id, 'completed', `${day}T01:00:00.000Z`);
      return run;
    });
    const job = storeJob(repos, makeJob());
    const lead = repos.leads.upsert(
      { jobId: job.id, runId: runs[0]!.id, breakdown: makeBreakdown() },
      NOW,
    );

    expect(repos.runs.prune(2)).toBe(1);
    expect(repos.runs.get(runs[0]!.id)).toBeNull();
    // Losing the run loses a progress log; losing the lead would lose the job.
    expect(repos.leads.get(lead.id)?.runId).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Profile, resume, settings                                                  */
/* -------------------------------------------------------------------------- */

describe('ProfileRepo.update', () => {
  it('merges one level deep', () => {
    repos.profiles.save(makeProfile(), NOW);

    const patched = repos.profiles.update({ preferences: { remoteOnly: true } }, NOW);
    // Deep enough that a single toggle keeps the tech stack…
    expect(patched?.preferences.remoteOnly).toBe(true);
    expect(patched?.preferences.techStack).toEqual(['TypeScript', 'React', 'Node.js']);
    expect(patched?.candidate.fullName).toBe('Test Candidate');

    // …shallow enough that sending an array replaces it, so a skill can be removed.
    const replaced = repos.profiles.update({ preferences: { techStack: ['Go'] } }, NOW);
    expect(replaced?.preferences.techStack).toEqual(['Go']);
    expect(replaced?.preferences.remoteOnly).toBe(true);
  });

  it('returns null for a profile that does not exist', () => {
    expect(repos.profiles.update({ candidate: { fullName: 'Nobody' } }, NOW, 'missing')).toBeNull();
  });
});

describe('ResumeRepo', () => {
  const upload = (filename: string, at: string) =>
    repos.resumes.store(
      {
        filename,
        mimeType: 'application/pdf',
        bytes: new TextEncoder().encode('%PDF-1.7 fake'),
        text: 'TypeScript React Node.js',
        derived: { techStack: ['TypeScript'], recentSkills: [], titles: [], yearsOfExperience: 6 },
      },
      at,
    );

  it('sanitises the display filename and never uses it as a path', async () => {
    const resume = await upload('../../.ssh/authorized_keys', NOW);

    expect(resume.filename).toBe('authorized_keys');
    // The file on disk is named by id, so the uploaded string never reaches the path.
    expect(await repos.resumes.file(resume.id)).not.toBeNull();
  });

  it('keeps the extracted text server-side', async () => {
    const resume = await upload('resume.pdf', NOW);

    expect(repos.resumes.text(resume.id)).toBe('TypeScript React Node.js');
    expect(resume.textLength).toBe(24);
    // resumeSchema has no `text` field, so it cannot be shipped to the browser.
    expect(resume).not.toHaveProperty('text');
  });

  it('prunes old uploads but keeps the one the profile points at', async () => {
    const oldest = await upload('v1.pdf', '2026-09-01T00:00:00.000Z');
    const middle = await upload('v2.pdf', '2026-09-02T00:00:00.000Z');
    const newest = await upload('v3.pdf', '2026-09-03T00:00:00.000Z');
    repos.profiles.attachResume(oldest.id, NOW);

    expect(await repos.resumes.prune(1)).toBe(1);
    expect(repos.resumes.get(middle.id)).toBeNull();
    expect(repos.resumes.get(oldest.id)).not.toBeNull();
    expect(repos.resumes.get(newest.id)).not.toBeNull();
    expect(await repos.resumes.file(middle.id)).toBeNull();
  });
});

describe('SettingsRepo', () => {
  it('falls back rather than throwing on a corrupt value', () => {
    repos.settings.set(SETTING.uiPreferences, 'not json at all', NOW);
    expect(repos.settings.getJson(SETTING.uiPreferences, { theme: 'dark' })).toEqual({
      theme: 'dark',
    });
  });

  it('round-trips JSON and overwrites on re-set', () => {
    repos.settings.setJson(SETTING.lastSearchRequest, makeSearchRequest({ minScore: 0.9 }), NOW);
    expect(
      repos.settings.getJson<SearchRequest | null>(SETTING.lastSearchRequest, null),
    ).toMatchObject({ minScore: 0.9 });

    repos.settings.set(SETTING.seedVersion, '2026-09-05', NOW);
    repos.settings.set(SETTING.seedVersion, '2026-10-01', NOW);
    expect(repos.settings.get(SETTING.seedVersion)).toBe('2026-10-01');

    repos.settings.delete(SETTING.seedVersion);
    expect(repos.settings.get(SETTING.seedVersion)).toBeNull();
  });
});
