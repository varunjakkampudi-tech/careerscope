/**
 * The search runner — everything that happens between "the user pressed Search"
 * and "there are leads on screen".
 *
 * The pipeline is fixed and each stage exists for a reason:
 *
 *   fetch → normalise → dedupe → **score** → cap → enrich → store
 *
 * The ordering of the last three is the only non-obvious part, and it is the
 * whole performance story. Scoring is pure and costs microseconds; enrichment is
 * network I/O against dozens of employers' web servers and costs seconds each.
 * So the run scores *everything*, keeps the best `maxResults`, and only then
 * spends requests enriching the companies behind jobs the user will actually
 * see. Enriching first — the obvious order — would spend most of a run's time on
 * companies whose jobs are then discarded.
 *
 * Enrichment adds website, portal and email; none of those feed the score. That
 * is what makes the reordering safe rather than merely faster: no lead's score
 * depends on a stage that now runs after scoring.
 *
 * Every stage publishes progress through the event bus, so a run that takes four
 * minutes shows what it is doing for all four of them. And every stage checks
 * for cancellation, because a run the user has walked away from should stop
 * making requests to other people's servers.
 */

import {
  buildCandidateContext,
  rerankLeads,
  scoreJob,
  type RerankClient,
  type RerankInput,
} from '@job-radar/matching';
import {
  DEFAULT_BOARDS,
  dedupeJobs,
  describeFailure,
  isAbortError,
  mergeBoards,
  normalizeJob,
  resolveProviders,
  type BoardRef,
  type HttpClient,
  type JobProvider,
  type ProviderEvent,
} from '@job-radar/providers';
import type {
  CandidateContext,
  Job,
  Lead,
  MatchBreakdown,
  MatchableProfile,
  ProviderQuery,
  SearchRequest,
  SearchRun,
  SourceId,
  SourceStat,
} from '@job-radar/shared';
import { emptyStats, type Repos } from '../db/repo/index.js';
import type { Logger } from '../logger.js';
import { now } from '../util/time.js';
import type { CompanyHints, CompanyResolver } from './companyResolver.js';
import type { RunEventBus } from './events.js';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Progress checkpoints.
 *
 * These are hand-assigned rather than derived because they encode how long each
 * stage *feels*, not how much work it does. Fetching is well over half the wall
 * clock of a typical run, so it owns half the bar; scoring is instantaneous and
 * owns almost none of it. A bar that jumps 0 → 90% and then sits still for two
 * minutes is worse than no bar.
 */
const STAGE_PROGRESS = {
  preparing: 0.02,
  fetching: 0.55,
  deduping: 0.6,
  scoring: 0.66,
  enriching: 0.86,
  reranking: 0.94,
  storing: 0.99,
} as const;

/**
 * Boards queried at once.
 *
 * Not a politeness limit — `HttpClient` already rate-limits per host, and every
 * provider talks to a different one. This is a memory and socket bound: with all
 * twelve sources enabled the run would otherwise hold a dozen concurrent
 * paginating crawls and every page each of them has in flight.
 */
const FETCH_CONCURRENCY = 4;

/**
 * How long one source gets before the run moves on without it.
 *
 * The run-level timeout in `queue.ts` is a backstop that fails the whole run and
 * discards everything it had collected. That is the right answer for a runner
 * that has genuinely wedged, and the wrong one for the common case: a single
 * board rate-limiting us. `HttpClient` retries a 429 up to three times with
 * backoff, so one provider walking eighty employers can legitimately spend an
 * hour being polite while the other eight finished minutes ago — and then the
 * backstop throws away every posting all nine of them found.
 *
 * Three minutes is comfortably above what a healthy source takes — the slowest
 * full walk observed locally was 43s — and the budget starts when that source
 * starts, so the stage's worst case is `ceil(sources / FETCH_CONCURRENCY)`
 * budgets: three waves of three minutes with all twelve sources selected. That
 * leaves a third of the 15-minute run limit for scoring, enrichment and storage
 * even when every board is misbehaving at once.
 *
 * A source that runs out keeps everything it had already yielded and is reported
 * as partial — the same trade this stage already makes for a source that errors.
 *
 * Overridable through `SearchRunnerDeps.sourceBudgetMs`, the same way `queue.ts`
 * takes its timeout, so a test can pin the behaviour without waiting minutes.
 */
const DEFAULT_SOURCE_BUDGET_MS = 3 * 60 * 1000;

/** Companies enriched per run. Beyond this the marginal lead is not worth the requests. */
const MAX_ENRICHED_COMPANIES = 60;

/** Employers contacted at once. Low on purpose — these are small web servers. */
const ENRICH_CONCURRENCY = 3;

/**
 * Slack over the result budget when asking a single provider.
 *
 * Dedupe removes a large fraction of a multi-source fetch — the same role
 * appears on the ATS, the aggregator and the remote board — so fetching exactly
 * `maxResults / providers` from each would land well under the budget after
 * merging. Doubling covers that without turning a 200-lead request into a
 * thousand-job crawl.
 */
const PER_PROVIDER_OVERSHOOT = 2;
const MIN_PER_PROVIDER = 20;

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface SearchRunnerDeps {
  repos: Repos;
  events: RunEventBus;
  logger: Logger;
  http: HttpClient;
  /** Every provider this build knows about; `resolveProviders` picks from these. */
  providers: readonly JobProvider[];
  resolver?: CompanyResolver | undefined;
  /** Absent unless a key is configured; its absence is how rerank stays optional. */
  rerankClient?: RerankClient | undefined;
  rerankModel?: string | undefined;
  clock?: (() => string) | undefined;
  /** Per-source fetch budget; defaults to `DEFAULT_SOURCE_BUDGET_MS`. */
  sourceBudgetMs?: number | undefined;
  /** Boards discovered by enrichment, folded back in for later runs. */
  onBoardsDiscovered?: ((boards: readonly BoardRef[]) => void) | undefined;
}

export interface RunOutcome {
  run: SearchRun;
  leads: Lead[];
}

/** Thrown when a run is cancelled, so the caller can tell it from a failure. */
export class RunCancelled extends Error {
  constructor() {
    super('Run cancelled');
    this.name = 'RunCancelled';
  }
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

export class SearchRunner {
  private readonly clock: () => string;
  private readonly sourceBudgetMs: number;

  constructor(private readonly deps: SearchRunnerDeps) {
    this.clock = deps.clock ?? now;
    this.sourceBudgetMs = deps.sourceBudgetMs ?? DEFAULT_SOURCE_BUDGET_MS;
  }

  /**
   * Executes a queued run to completion.
   *
   * Returns rather than throws for an ordinary failure — a run that failed is a
   * row with a status and an error message, which is exactly what the UI needs
   * in order to render it. The queue reads the returned status instead of
   * catching.
   */
  async execute(runId: string, signal: AbortSignal): Promise<RunOutcome> {
    const { repos, events, logger } = this.deps;

    const run = repos.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    const state = new RunState(run.request, this.selected(run.request));
    repos.runs.start(runId, this.clock());

    try {
      const context = this.prepare(runId, state);
      const jobs = await this.fetch(runId, state, context.query, signal);
      const scored = this.score(runId, state, jobs, context.candidate);
      const kept = this.cap(scored, run.request.maxResults);

      await this.enrich(runId, state, kept, signal);
      const reranked = await this.rerankIfEnabled(runId, state, kept, context.candidate, signal);
      const leads = this.store(runId, state, reranked);

      // `finish` writes the row; the run is read back because the caller needs
      // the completed shape — status, timings and final stats — not the queued
      // one it started from.
      repos.runs.finish(runId, 'completed', this.clock());
      const finished = repos.runs.get(runId) ?? run;
      events.publish(runId, { type: 'done', run: finished });
      logger.info(
        { runId, leads: leads.length, matched: state.stats.matched },
        'search run completed',
      );
      return { run: finished, leads };
    } catch (error) {
      if (error instanceof RunCancelled || isAbortError(error)) {
        // Whoever aborted owns the terminal row and the terminal event: a user
        // cancel writes `cancelled` before signalling, a timeout writes `failed`
        // once this returns. The runner does not know which happened and must
        // not invent a message for it — unwinding cleanly is the whole job here.
        logger.info({ runId }, 'search run aborted');
        return { run: repos.runs.get(runId) ?? run, leads: [] };
      }

      const message = describeFailure(error);
      logger.error({ runId, err: error }, 'search run failed');
      repos.runs.finish(runId, 'failed', this.clock(), message);
      events.publish(runId, { type: 'error', message });
      return { run: repos.runs.get(runId) ?? run, leads: [] };
    }
  }

  /** The providers this run will actually query, in registry order. */
  private selected(request: SearchRequest): JobProvider[] {
    return resolveProviders(this.deps.providers, request.sources);
  }

  /* ---------------------------------------------------------------------- */
  /* Stage 1 — prepare                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Assembles the two things every later stage needs: the query to send to
   * providers, and the candidate to score against.
   *
   * The profile row on its own is not enough for the matching engine — it has no
   * `derived` field, because the parsed resume lives on the resume row. Joining
   * them here is what makes `MatchableProfile` satisfiable.
   */
  private prepare(
    runId: string,
    state: RunState,
  ): { query: ProviderQuery; candidate: CandidateContext } {
    this.stage(runId, state, 'preparing');

    const profile = this.deps.repos.profiles.getForProcessing();
    if (!profile) {
      throw new Error('No profile saved yet — complete onboarding before searching');
    }

    const resume = profile.resumeId ? this.deps.repos.resumes.get(profile.resumeId) : null;
    const resumeText = profile.resumeId
      ? (this.deps.repos.resumes.text(profile.resumeId) ?? '')
      : '';

    const matchable: MatchableProfile = {
      candidate: { location: profile.candidate.location },
      preferences: profile.preferences,
      application: profile.application,
      derived: resume?.derived ?? null,
    };
    const candidate = buildCandidateContext(matchable, resumeText);

    if (!resume) {
      this.log(runId, 'warn', 'No resume attached — matching on the profile fields alone');
    }

    const request = state.request;
    const query: ProviderQuery = {
      // A per-run override beats the profile, which is what makes "just search
      // for SRE roles this once" possible without editing the profile.
      titles: request.titles ?? profile.preferences.titles,
      locations: request.locations ?? profile.preferences.locations,
      excludeKeywords: profile.preferences.excludeKeywords,
      remoteOnly: profile.preferences.remoteOnly,
      employmentTypes: profile.preferences.employmentTypes,
      postedWithinDays: request.postedWithinDays,
      maxResults: perProviderBudget(request.maxResults, state.providers.length),
    };

    this.log(
      runId,
      'info',
      `Searching ${state.providers.length} source(s) for ${query.titles.length} role(s)`,
    );
    return { query, candidate };
  }

  /* ---------------------------------------------------------------------- */
  /* Stage 2 — fetch                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Queries every selected provider, bounded by concurrency, and normalises what
   * comes back.
   *
   * One provider failing is a log line, not a failed run: a run that queried
   * eleven boards successfully and lost the twelfth to a timeout has eleven
   * boards' worth of leads, and throwing them away to report an error would be
   * the wrong trade every time.
   */
  private async fetch(
    runId: string,
    state: RunState,
    query: ProviderQuery,
    signal: AbortSignal,
  ): Promise<Job[]> {
    this.stage(runId, state, 'fetching');
    if (state.providers.length === 0) {
      throw new Error('None of the selected sources are available — check API keys in Settings');
    }

    const collected: Job[] = [];
    let completed = 0;

    await mapConcurrent(state.providers, FETCH_CONCURRENCY, async (provider) => {
      throwIfCancelled(signal);
      const started = Date.now();
      const stat = state.sourceStat(provider.id);

      // The provider sees a signal that fires on *either* the run being
      // cancelled or its own budget running out. Keeping the budget as its own
      // handle is what makes the two distinguishable afterwards: an abort with
      // `budget.aborted` set is this source running long, anything else is the
      // run ending underneath it.
      const budget = AbortSignal.timeout(this.sourceBudgetMs);
      const scoped = AbortSignal.any([signal, budget]);

      try {
        for await (const raw of provider.search(query, {
          http: this.deps.http,
          signal: scoped,
          log: (event: ProviderEvent) => {
            if (event.level === 'warn' || event.level === 'error') {
              stat.message = `Results may be incomplete: ${event.message}`;
              if (event.level === 'error') stat.errors += 1;
            }
            this.providerLog(runId, event);
          },
        })) {
          // Deliberately the run signal, not `scoped`: the budget expiring must
          // reach the catch below as this provider's problem, not unwind the run.
          throwIfCancelled(signal);
          collected.push(normalizeJob(raw));
          stat.fetched += 1;
          state.stats.fetched += 1;
        }
      } catch (error) {
        // A cancelled run belongs to the run, not to this provider, so it
        // escapes. The run signal aborting always wins that judgement — if it is
        // set, this is the run ending underneath us whatever else also fired.
        if (error instanceof RunCancelled) throw error;
        if (isAbortError(error) && signal.aborted) throw error;
        // The budget expiring is handled in `finally`, which also covers the
        // provider that absorbed the abort and simply stopped iterating.
        if (!budget.aborted) {
          stat.errors += 1;
          stat.message = describeFailure(error);
          this.log(runId, 'warn', `${provider.label}: ${stat.message}`, provider.id);
        }
      } finally {
        stat.durationMs = Date.now() - started;
        if (budget.aborted && !signal.aborted) {
          // Not counted as an error: nothing failed, and the postings it did
          // yield are kept and scored like any other. But "12 kept" reads as a
          // complete answer unless we say the source was cut off rather than
          // exhausted.
          stat.message = `Stopped after ${humanDuration(this.sourceBudgetMs)} — still responding, so these results are partial.`;
          this.log(runId, 'warn', `${provider.label}: ${stat.message}`, provider.id);
        }
        completed += 1;
        // Progress inside the fetch stage tracks providers finished, so a run
        // against twelve boards moves eleven times instead of sitting at 5%.
        this.progress(
          runId,
          state,
          'fetching',
          STAGE_PROGRESS.preparing +
            (STAGE_PROGRESS.fetching - STAGE_PROGRESS.preparing) *
              (completed / state.providers.length),
        );
      }
    });

    throwIfCancelled(signal);
    this.log(runId, 'info', `Fetched ${collected.length} postings`);
    return collected;
  }

  /* ---------------------------------------------------------------------- */
  /* Stage 3 — score                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Dedupes, then scores every survivor.
   *
   * Both happen here because they are the same instant of wall clock — dedupe is
   * a hash and a merge, scoring is arithmetic over already-parsed text. They are
   * reported as two stages because the counts are worth showing separately, not
   * because there is any real time between them.
   */
  private score(
    runId: string,
    state: RunState,
    jobs: readonly Job[],
    candidate: CandidateContext,
  ): ScoredJob[] {
    this.stage(runId, state, 'deduping');
    const unique = dedupeJobs(jobs);
    state.stats.deduped = unique.length;
    this.log(
      runId,
      'info',
      `${unique.length} unique postings after merging ${jobs.length - unique.length} duplicate(s)`,
    );

    this.stage(runId, state, 'scoring');
    const scored = unique.map((job) => ({
      job,
      match: scoreJob(job, candidate, { windowDays: state.request.postedWithinDays }),
    }));
    state.stats.scored = scored.length;
    state.stats.matched = scored.filter(
      (item) => item.match.score >= state.request.minScore,
    ).length;

    this.log(
      runId,
      'info',
      `${state.stats.matched} of ${scored.length} at or above ${Math.round(state.request.minScore * 100)}%`,
    );
    return scored;
  }

  /**
   * Keeps the best `maxResults`.
   *
   * Sorted by score, so the cap removes the worst matches rather than whichever
   * board happened to answer last. Excluded jobs sink on their own — a hard gate
   * scores them at zero — so they fall off the end without a special case.
   */
  private cap(scored: readonly ScoredJob[], maxResults: number): ScoredJob[] {
    const ordered = [...scored].sort(byScoreDesc);
    return ordered.length <= maxResults ? ordered : ordered.slice(0, maxResults);
  }

  /* ---------------------------------------------------------------------- */
  /* Stage 4 — enrich                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Fills in company website, careers portal and — where published — a careers
   * email, for the companies behind the leads being kept.
   *
   * Companies are written before enrichment because `applyResolution` updates a
   * row that has to exist, and because `jobs.company_id` is a foreign key. Only
   * companies never resolved before are looked up: a company enriched last week
   * is not enriched again, which is what keeps a second run fast.
   */
  private async enrich(
    runId: string,
    state: RunState,
    kept: readonly ScoredJob[],
    signal: AbortSignal,
  ): Promise<void> {
    this.stage(runId, state, 'enriching');
    const { repos } = this.deps;
    const at = this.clock();

    // Company rows first: enrichment updates them and jobs reference them.
    repos.db.tx(() => {
      for (const { job } of kept) repos.companies.upsertFromJob(job, at);
    });

    const resolver = this.deps.resolver;
    if (!resolver) return;

    // First posting wins the hints — they all point at the same employer, and
    // after the cap the first one is the highest-scoring.
    const hints = new Map<string, CompanyHints>();
    for (const { job } of kept) {
      if (hints.has(job.company.id)) continue;
      hints.set(job.company.id, {
        applyUrl: job.applyUrl,
        sourceUrl: job.sourceUrl,
        website: job.company.website,
        careersUrl: job.company.careersUrl,
      });
    }

    const pending = repos.companies.unresolved([...hints.keys()]).slice(0, MAX_ENRICHED_COMPANIES);
    if (pending.length === 0) return;

    this.log(runId, 'info', `Looking up ${pending.length} employer(s)`);
    const discovered: BoardRef[] = [];
    let done = 0;

    await mapConcurrent(pending, ENRICH_CONCURRENCY, async (companyId) => {
      throwIfCancelled(signal);
      const company = repos.companies.get(companyId);
      if (!company) return;

      const resolution = await resolver.resolve(company, hints.get(companyId) ?? {}, signal);
      repos.companies.applyResolution(
        companyId,
        {
          website: resolution.website,
          websiteConfidence: resolution.websiteConfidence,
          careersUrl: resolution.careersUrl,
          atsType: resolution.atsType,
          atsPortalUrl: resolution.atsPortalUrl,
          careersEmail: resolution.careersEmail,
          emailConfidence: resolution.emailConfidence,
          linkedinUrl: resolution.linkedinUrl,
          note: resolution.note,
        },
        this.clock(),
      );

      discovered.push(...resolution.discovered);
      state.stats.enriched += 1;
      done += 1;
      this.progress(
        runId,
        state,
        'enriching',
        STAGE_PROGRESS.scoring +
          (STAGE_PROGRESS.enriching - STAGE_PROGRESS.scoring) * (done / pending.length),
      );
    });

    if (discovered.length > 0) {
      // A detected board is the most valuable thing enrichment produces: the
      // next run queries it directly and gets a full JD instead of a snippet.
      this.deps.onBoardsDiscovered?.(mergeBoards(DEFAULT_BOARDS, discovered));
      this.log(runId, 'info', `Discovered ${discovered.length} ATS board reference(s)`);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Stage 5 — rerank                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * The optional Claude pass. Blends a semantic read of resume-vs-JD into the
   * heuristic score for the strongest candidates only.
   *
   * `rerankLeads` never throws and never drops an item, so a rate limit or a
   * malformed response degrades to the heuristic score rather than to an error.
   */
  private async rerankIfEnabled(
    runId: string,
    state: RunState,
    kept: readonly ScoredJob[],
    candidate: CandidateContext,
    signal: AbortSignal,
  ): Promise<ScoredJob[]> {
    const client = this.deps.rerankClient;
    if (!client || !state.request.useLlmRerank || kept.length === 0) return [...kept];

    this.stage(runId, state, 'reranking');
    const input: RerankInput[] = kept.map(({ job, match }) => ({ job, match }));

    const reranked = await rerankLeads(input, candidate, {
      client,
      ...(this.deps.rerankModel ? { model: this.deps.rerankModel } : {}),
      onWarning: (message) => this.log(runId, 'warn', `Semantic pass: ${message}`),
      signal,
    });

    // Rerank can move a lead across the threshold in either direction, so the
    // headline count is recomputed rather than carried forward. Re-sorted too:
    // the blend changes the order, and the order is what the UI shows.
    const ordered = reranked.map(({ job, match }) => ({ job, match })).sort(byScoreDesc);
    state.stats.matched = ordered.filter(
      (item) => item.match.score >= state.request.minScore,
    ).length;
    this.log(runId, 'info', 'Semantic rerank applied to the top candidates');
    return ordered;
  }

  /* ---------------------------------------------------------------------- */
  /* Stage 6 — store                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Writes jobs and leads, then streams the qualifying ones to the UI.
   *
   * One transaction for the batch, and publishing strictly afterwards — never
   * during. A subscriber that received a `lead` event for a row a rollback then
   * removed would render a lead that does not exist and 404 when clicked.
   */
  private store(runId: string, state: RunState, kept: readonly ScoredJob[]): Lead[] {
    this.stage(runId, state, 'storing');
    const { repos, events } = this.deps;
    const at = this.clock();

    const leads = repos.db.tx(() => {
      const stored = repos.jobs.upsertMany(
        kept.map((item) => item.job),
        at,
      );
      const byFingerprint = new Map(stored.map((job) => [job.fingerprint, job]));

      // `kept` is already ordered by score, and the run's leads should reach the
      // screen in that order too.
      const written: Lead[] = [];
      for (const item of kept) {
        const job = byFingerprint.get(item.job.fingerprint);
        if (!job) continue;
        written.push(repos.leads.upsert({ jobId: job.id, runId, breakdown: item.match }, at));
        state.countSourceKeep(job.source);
      }
      return written;
    });

    for (const lead of leads) {
      // Only leads the user asked to see are streamed. The rest are stored — the
      // threshold is a filter on the leads screen, not a decision to forget.
      if (lead.match.score >= state.request.minScore) {
        events.publish(runId, { type: 'lead', lead });
      }
    }

    this.log(runId, 'info', `Stored ${leads.length} lead(s)`);
    this.progress(runId, state, 'storing', STAGE_PROGRESS.storing);
    return leads;
  }

  /* ---------------------------------------------------------------------- */
  /* Progress + logging                                                     */
  /* ---------------------------------------------------------------------- */

  private stage(runId: string, state: RunState, stage: keyof typeof STAGE_PROGRESS): void {
    this.progress(runId, state, stage, STAGE_PROGRESS[stage]);
  }

  private progress(runId: string, state: RunState, stage: string, progress: number): void {
    const clamped = Math.min(1, Math.max(0, progress));
    this.deps.repos.runs.progress(runId, stage, clamped, state.stats);
    this.deps.events.publish(runId, {
      type: 'progress',
      stage,
      progress: clamped,
      stats: state.stats,
    });
  }

  private log(
    runId: string,
    level: 'info' | 'warn' | 'error',
    message: string,
    source: string | null = null,
  ): void {
    this.deps.logger[level]({ runId, source }, message);
    this.deps.events.publish(runId, { type: 'log', level, message, source });
  }

  /** Provider chatter, mapped onto the run log the user reads. */
  private providerLog(runId: string, event: ProviderEvent): void {
    // Debug output is for the process log only; the run log stays readable.
    if (event.level === 'debug') {
      this.deps.logger.debug({ runId, source: event.source }, event.message);
      return;
    }
    this.log(runId, event.level, event.message, event.source);
  }
}

/* -------------------------------------------------------------------------- */
/* Run-scoped state                                                           */
/* -------------------------------------------------------------------------- */

interface ScoredJob {
  job: Job;
  match: MatchBreakdown;
}

/**
 * The mutable counters a run accumulates.
 *
 * Held in one object rather than threaded through every method because the stats
 * block is published on every progress event, and a partially-updated copy would
 * show the user numbers that briefly disagree with each other.
 */
class RunState {
  readonly stats = emptyStats();
  private readonly bySource = new Map<SourceId, SourceStat>();

  constructor(
    readonly request: SearchRequest,
    readonly providers: readonly JobProvider[],
  ) {}

  /** The stat row for a source, created on first mention. */
  sourceStat(source: SourceId): SourceStat {
    let stat = this.bySource.get(source);
    if (!stat) {
      stat = { source, fetched: 0, kept: 0, errors: 0, durationMs: null, message: null };
      this.bySource.set(source, stat);
      this.stats.bySource.push(stat);
    }
    return stat;
  }

  /**
   * Credits a stored lead to the source that won its merge.
   *
   * `kept` is deliberately not `fetched`: a board that returned forty postings of
   * which two survived dedupe and the cap contributed two leads, and telling the
   * user it contributed forty would misrepresent which sources are worth having
   * enabled.
   */
  countSourceKeep(source: SourceId): void {
    this.sourceStat(source).kept += 1;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function byScoreDesc(a: ScoredJob, b: ScoredJob): number {
  return b.match.score - a.match.score;
}

/**
 * How many results to ask one provider for.
 *
 * See `PER_PROVIDER_OVERSHOOT` for the ratio. The floor matters as much: with a
 * dozen sources selected the arithmetic share is small enough that a board would
 * return two postings and stop, which is worse than useless — it looks like the
 * board had nothing to offer.
 */
export function perProviderBudget(maxResults: number, providerCount: number): number {
  const share = Math.ceil(maxResults / Math.max(1, providerCount)) * PER_PROVIDER_OVERSHOOT;
  return Math.max(MIN_PER_PROVIDER, Math.min(maxResults, share));
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new RunCancelled();
}

/**
 * A duration for a sentence a user reads, not a log line.
 *
 * Minutes above a minute, seconds below it, and never a decimal — the number is
 * there to say "we stopped waiting", and "2.9 min" implies a precision the
 * budget does not have. Floored at one second so a very short budget reads as a
 * duration rather than as "Stopped after 0s".
 */
function humanDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))}s`;
}

/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * Written out rather than pulled from a library because the semantics needed are
 * specific: a worker that throws must abort the whole batch (that is how
 * cancellation propagates out of the fetch stage), while a worker that handles
 * its own errors — as the provider loop does — never reaches this code.
 */
export async function mapConcurrent<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const size = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      await worker(item, index);
    }
  });

  await Promise.all(runners);
}
