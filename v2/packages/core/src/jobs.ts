import { z } from 'zod';
import { searchSourceSchema } from './commands.js';
import { matchBreakdownSchema } from '@job-radar/shared';

const match = z.unknown().transform((value, context) => {
  if (value == null) return null;
  const parsed = matchBreakdownSchema.strict().safeParse(value);
  if (!parsed.success) {
    context.addIssue({ code: 'custom', message: 'Invalid match breakdown' });
    return z.NEVER;
  }
  return parsed.data;
});

const publicLink = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  }, 'Job links must use HTTPS without credentials');

export const collectedJobSchema = z
  .object({
    fingerprint: z.string().min(1).max(256),
    /**
     * The board's own id for this specific posting. Kept alongside the
     * fingerprint (which only records title+company+location) for
     * transparency and any future reconciliation. Optional so that rows
     * stored before this field existed keep parsing; every job collected
     * from now on carries it.
     */
    sourceJobId: z.string().min(1).max(256).optional(),
    title: z.string().min(1).max(500),
    company: z.string().min(1).max(500),
    location: z.string().max(500),
    description: z.string().max(100_000),
    source: searchSourceSchema,
    sourceUrl: publicLink,
    sourceLinks: z
      .array(z.object({ source: searchSourceSchema, url: publicLink }).strict())
      .max(500)
      .optional(),
    applyUrl: publicLink,
    postedAt: z.string().datetime().nullable(),
    match,
  })
  .strict();

export type CollectedJob = z.infer<typeof collectedJobSchema>;
export type CollectedJobInput = z.input<typeof collectedJobSchema>;
export const collectedJobsSchema = z.array(collectedJobSchema).max(100);

export const sourceOutcomeSchema = z
  .object({
    source: searchSourceSchema,
    // 'empty' is distinct from 'completed': the provider ran without error but
    // yielded zero rows on an HTTP 200. That is exactly what a job board
    // changing its markup looks like from the inside, and it must never be
    // reported the same way as "found real results" - a source that has
    // silently broken looks identical to a quiet day unless this is tracked
    // as its own state.
    status: z.enum(['completed', 'empty', 'failed']),
    accepted: z.number().int().min(0).max(100),
    limited: z.boolean(),
    errorCode: z.enum(['source_failed', 'source_timeout', 'invalid_response']).nullable(),
  })
  .strict()
  .refine((value) => (value.status !== 'failed') === (value.errorCode === null))
  .refine((value) => value.status !== 'empty' || value.accepted === 0);

export const sourceOutcomesSchema = z
  .array(sourceOutcomeSchema)
  .min(1)
  .max(5)
  .refine((values) => new Set(values.map((value) => value.source)).size === values.length);

export type SourceOutcome = z.infer<typeof sourceOutcomeSchema>;

export function collectionStatus(jobs: CollectedJobInput[], outcomes: SourceOutcome[]) {
  if (outcomes.every((outcome) => outcome.status === 'completed')) return 'completed';
  return jobs.length || outcomes.some((outcome) => outcome.status !== 'failed')
    ? 'partial'
    : 'failed';
}
