import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
// `zod/v4` rather than the package root, because `zodOutputFormat` is typed
// against the v4 API. The rest of the repo is on v3 classic; this schema is
// local to the module and never crosses into `@job-radar/shared`.
import { z } from 'zod/v4';
import type { CandidateContext, Job, MatchBreakdown } from '@job-radar/shared';
import { applyRerank } from './score.js';

/**
 * An optional second opinion on the top of the shortlist.
 *
 * The deterministic engine is good at logistics — salary, location, seniority,
 * recency — and blunt about substance: it counts skill tokens without knowing
 * whether five years of React at an agency is the same thing the JD is asking
 * for. This pass reads the resume against the JD and answers that question,
 * then `applyRerank` folds its answer in at 40% weight.
 *
 * Three properties matter more than accuracy here:
 *
 *   1. **It cannot break a run.** Every failure path — no key, refusal, bad
 *      JSON, network error, abort — leaves the deterministic score standing and
 *      reports a warning. `rerankLeads` never throws.
 *   2. **It cannot overrule a gate.** `applyRerank` no-ops on excluded leads.
 *   3. **It cannot fake confidence.** Snippet-only leads are skipped rather
 *      than judged from two lines of teaser text.
 */

export const DEFAULT_RERANK_MODEL = 'claude-opus-5';
/** How far down the shortlist to look. Beyond this the blend changes nothing useful. */
export const DEFAULT_RERANK_TOP_N = 40;
/** Postings per request. Small enough to stay well inside the output budget. */
export const DEFAULT_RERANK_BATCH_SIZE = 8;
export const DEFAULT_RERANK_CONCURRENCY = 2;
/** Per-JD cap. Above this a description is boilerplate, benefits and legal text. */
export const MAX_DESCRIPTION_CHARS = 6_000;
export const MAX_RESUME_CHARS = 20_000;
/**
 * Comfortably under the SDK's non-streaming ceiling (~21k), so `messages.parse`
 * never has to become a streaming call to satisfy a guard.
 */
export const RERANK_MAX_TOKENS = 8_192;

const TRUNCATED = '\n\n[…truncated for length; this is a partial view of the text]';

/* -------------------------------------------------------------------------- */
/* Contract                                                                   */
/* -------------------------------------------------------------------------- */

/** A scored lead on its way through the pipeline. */
export interface RerankInput {
  job: Job;
  match: MatchBreakdown;
}

/**
 * The slice of the Anthropic client this module uses. Narrow on purpose: tests
 * pass a stub, and the real `Anthropic` instance satisfies it structurally.
 */
export interface RerankClient {
  messages: {
    parse(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: unknown,
    ): Promise<{ stop_reason: string | null; parsed_output: unknown }>;
  };
}

/**
 * Compile-time proof that a real `Anthropic` instance satisfies the interface
 * above. If the SDK's `messages.parse` signature drifts, this line fails the
 * build rather than the first live call failing in production.
 */
type Assert<T extends true> = T;
export type RerankClientIsSdkCompatible = Assert<Anthropic extends RerankClient ? true : false>;

export interface RerankOptions {
  client: RerankClient;
  model?: string;
  topN?: number;
  batchSize?: number;
  concurrency?: number;
  /** Called for anything the user should see in the run log. Never throws. */
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
}

/**
 * The model's verdict on one posting.
 *
 * Deliberately free of `min`/`max`/`length` constraints: those become JSON
 * Schema keywords that the structured-output grammar may or may not honour, and
 * a rejected request would cost the whole batch. The bounds are stated in the
 * prompt for guidance and enforced in code — `applyRerank` clamps the score
 * regardless of what comes back.
 */
const assessmentSchema = z.object({
  id: z.string().describe('The posting id, copied exactly as given.'),
  score: z
    .number()
    .describe('How well the candidate fits this role, from 0.0 to 1.0. Use the anchors given.'),
  rationale: z
    .string()
    .describe('One sentence, under 200 characters, naming the specific evidence behind the score.'),
  missingSkills: z
    .array(z.string())
    .describe('Up to five things the posting needs that the resume does not evidence.'),
});

const rerankBatchSchema = z.object({
  assessments: z.array(assessmentSchema).describe('One entry per posting, in the order given.'),
});

type RerankBatch = z.infer<typeof rerankBatchSchema>;

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Blend a semantic score into the top of the shortlist.
 *
 * Returns a new array in the same order as `items`; leads that were skipped or
 * whose batch failed come back untouched, so the caller can treat the result as
 * a drop-in replacement without checking which is which.
 */
export async function rerankLeads(
  items: readonly RerankInput[],
  candidate: CandidateContext,
  options: RerankOptions,
): Promise<RerankInput[]> {
  const {
    client,
    model = DEFAULT_RERANK_MODEL,
    topN = DEFAULT_RERANK_TOP_N,
    batchSize = DEFAULT_RERANK_BATCH_SIZE,
    concurrency = DEFAULT_RERANK_CONCURRENCY,
    onWarning,
    signal,
  } = options;

  const warn = (message: string) => {
    try {
      onWarning?.(message);
    } catch {
      // A broken logger is not a reason to lose the leads.
    }
  };

  const results = items.map((item) => ({ ...item }));
  const eligible = selectEligible(results, topN);

  if (eligible.length === 0) return results;

  const skipped = results.length - countEligibleOverall(results);
  if (skipped > 0) {
    warn(
      `Skipped ${skipped} lead${skipped === 1 ? '' : 's'} in the semantic pass — ` +
        'excluded, or the full description was never fetched.',
    );
  }

  const system = buildSystemBlocks(candidate);
  const batches = chunk(eligible, Math.max(1, batchSize));

  await mapWithConcurrency(batches, Math.max(1, concurrency), async (batch, index) => {
    if (signal?.aborted) return;

    try {
      const assessments = await assessBatch(batch, { client, model, system, signal });
      applyAssessments(batch, assessments, warn);
    } catch (error) {
      // The deterministic score stands. That is the whole point of the design:
      // the semantic pass is an enhancement, never a dependency.
      warn(
        `Semantic pass failed for batch ${index + 1} of ${batches.length} ` +
          `(${batch.length} leads kept their heuristic score): ${describeError(error)}`,
      );
    }
  });

  return results;
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A lead is worth a token spend when a gate has not already killed it and there
 * is a real description to read. Judging a snippet-only listing would produce a
 * confident-sounding rationale drawn from a two-line teaser — worse than saying
 * nothing, because the drawer renders it as though we knew.
 */
function isEligible(item: RerankInput): boolean {
  return item.match.excludedReason === null && item.match.confidence === 'high';
}

function countEligibleOverall(items: readonly RerankInput[]): number {
  return items.reduce((count, item) => (isEligible(item) ? count + 1 : count), 0);
}

/** The strongest `topN` eligible leads by heuristic score. */
function selectEligible(items: RerankInput[], topN: number): RerankInput[] {
  return items
    .filter(isEligible)
    .sort((a, b) => b.match.heuristicScore - a.match.heuristicScore)
    .slice(0, Math.max(0, topN));
}

/* -------------------------------------------------------------------------- */
/* One request                                                                */
/* -------------------------------------------------------------------------- */

interface AssessArgs {
  client: RerankClient;
  model: string;
  system: Anthropic.TextBlockParam[];
  signal?: AbortSignal;
}

async function assessBatch(
  batch: readonly RerankInput[],
  { client, model, system, signal }: AssessArgs,
): Promise<RerankBatch['assessments']> {
  const response = await client.messages.parse(
    {
      model,
      max_tokens: RERANK_MAX_TOKENS,
      thinking: { type: 'adaptive' },
      system,
      messages: [{ role: 'user', content: renderBatch(batch) }],
      output_config: { effort: 'low', format: zodOutputFormat(rerankBatchSchema) },
      // No `fallbacks`: that path runs through `client.beta.messages`, and a
      // refused or unavailable turn already has a defined correct behaviour
      // here — the deterministic score stands untouched.
    },
    signal ? { signal } : undefined,
  );

  if (response.stop_reason === 'refusal') {
    throw new Error('the model declined to assess this batch');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('the response was cut off before it was complete');
  }
  if (response.parsed_output === null || response.parsed_output === undefined) {
    throw new Error('the response did not parse against the expected shape');
  }

  // Re-validated rather than trusted: `parsed_output` is typed `unknown` on the
  // narrow client interface, and a stub in a test can return anything at all.
  const parsed = rerankBatchSchema.safeParse(response.parsed_output);
  if (!parsed.success) {
    throw new Error(`the response did not match the schema (${parsed.error.issues.length} issues)`);
  }

  return parsed.data.assessments;
}

/**
 * Fold verdicts back into the batch. Matched by id, so a short, reordered or
 * partly-hallucinated response degrades per-lead instead of per-batch: anything
 * unmatched simply keeps its heuristic score.
 */
function applyAssessments(
  batch: readonly RerankInput[],
  assessments: readonly RerankBatch['assessments'][number][],
  warn: (message: string) => void,
): void {
  const byId = new Map(batch.map((item) => [item.job.id, item]));
  let applied = 0;

  for (const assessment of assessments) {
    const item = byId.get(assessment.id);
    if (!item) continue; // An id we never sent. Ignore it rather than guess.
    if (!Number.isFinite(assessment.score)) continue;

    item.match = applyRerank(item.match, assessment.score, assessment.rationale.trim());
    byId.delete(assessment.id);
    applied += 1;
  }

  if (byId.size > 0) {
    warn(
      `The semantic pass returned no verdict for ${byId.size} of ${batch.length} leads in a batch; ` +
        'they kept their heuristic score.',
    );
  }
  if (applied === 0 && batch.length > 0) {
    warn('A semantic batch came back with nothing usable.');
  }
}

/* -------------------------------------------------------------------------- */
/* Prompt                                                                     */
/* -------------------------------------------------------------------------- */

const INSTRUCTIONS = [
  "You are assessing how well one candidate's actual experience fits a set of job postings.",
  '',
  'Judge the substance of the work only: the problems the role solves, the depth it needs,',
  'and whether the resume shows evidence of doing that work. Ignore salary, location,',
  'commute, remote policy and how recently the job was posted — those are scored separately',
  'and deterministically elsewhere, and double-counting them here would distort the result.',
  '',
  'Score anchors:',
  '  1.0  the candidate has already done this job, at this level, on this kind of system',
  '  0.85 a clear fit — the day-to-day work is what the resume describes',
  '  0.6  adjacent — transferable, with a real ramp on some core part of the role',
  '  0.3  same broad industry, different craft',
  '  0.0  a different discipline entirely',
  '',
  'Be sceptical. A keyword appearing in both documents is not evidence of depth; look for',
  'what the candidate built and owned. Prefer the lower of two defensible scores.',
  'If a description is too thin to judge honestly, score it 0.5 and say so in the rationale.',
  '',
  'Return exactly one assessment per posting, copying each id verbatim.',
].join('\n');

/**
 * The static half of the request: rules, then the candidate.
 *
 * The cache breakpoint sits on the last block, so both are cached together and
 * only the volatile posting text changes between batches. Whether the cache
 * actually engages depends on the resume clearing the ~1024-token minimum; a
 * short resume simply misses it, which costs a little and breaks nothing.
 */
function buildSystemBlocks(candidate: CandidateContext): Anthropic.TextBlockParam[] {
  return [
    { type: 'text', text: INSTRUCTIONS },
    {
      type: 'text',
      text: renderCandidate(candidate),
      cache_control: { type: 'ephemeral' },
    },
  ];
}

function renderCandidate(candidate: CandidateContext): string {
  const lines = ['<candidate>'];

  if (candidate.titles.length > 0) {
    lines.push(`Target roles: ${candidate.titles.join(', ')}`);
  }
  lines.push(`Years of experience: ${candidate.yearsOfExperience}`);
  if (candidate.skills.length > 0) {
    lines.push(`Stack: ${candidate.skills.join(', ')}`);
  }
  if (candidate.recentSkills.length > 0) {
    lines.push(`Used in the most recent role: ${candidate.recentSkills.join(', ')}`);
  }

  const resume = candidate.resumeText.trim();
  lines.push(
    '',
    '<resume>',
    resume
      ? clip(resume, MAX_RESUME_CHARS)
      : '(No resume text available — judge from the summary above.)',
    '</resume>',
  );
  lines.push('</candidate>');

  return lines.join('\n');
}

function renderBatch(batch: readonly RerankInput[]): string {
  const postings = batch.map((item) => renderJob(item.job)).join('\n\n');
  return `Assess each posting below against the candidate.\n\n${postings}`;
}

function renderJob(job: Job): string {
  const description = job.descriptionText.trim();
  return [
    `<posting id="${job.id}">`,
    `Title: ${job.title}`,
    `Company: ${job.company.name}`,
    '<description>',
    description ? clip(description, MAX_DESCRIPTION_CHARS) : '(No description text.)',
    '</description>',
    '</posting>',
  ].join('\n');
}

/**
 * Truncation is marked, never silent. A model shown a clipped JD that reads as
 * complete will confidently score the half it was given.
 */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}${TRUNCATED}`;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run `fn` over every item, never more than `limit` in flight at once. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
