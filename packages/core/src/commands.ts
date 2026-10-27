/**
 * Command envelope and search-creation schemas shared by the API (which enqueues) and the search
 * worker (which consumes). Validated with Zod at both ends.
 */

import { z } from 'zod';

/** Envelope for every queued command. `.strict()` rejects unknown keys; `ownerId` scopes all work to one user. */
export const commandSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum([
      'search.collect',
      'job.rank',
      'company.enrich',
      'resume.parse',
      'email.process',
      'export.generate',
      'application.prepare',
    ]),
    version: z.literal(1),
    aggregateId: z.string().uuid(),
    ownerId: z.string().uuid(),
    occurredAt: z.string().datetime(),
    correlationId: z.string().uuid(),
    causationId: z.string().uuid().optional(),
  })
  .strict();

export type Command = z.infer<typeof commandSchema>;

/** Sources the launch search worker can run; the list is sorted and de-duplicated by `createSearchSchema`. */
export const searchSourceSchema = z.enum([
  'remoteok',
  'himalayas',
  'greenhouse',
  'lever',
  'ashby',
  'workable',
]);

/** Body of a search request. Sources must be unique; they are sorted so equal sets have the same order. */
export const createSearchSchema = z
  .object({
    query: z.string().trim().min(2).max(160),
    useProfileTitles: z.boolean().optional(),
    // Distinguishes an unattended, scheduler-created run from a human clicking
    // "search", so "was this run automated" is recorded in the data instead of
    // being inferred from the idempotency-key string. Defaults to 'manual'.
    origin: z.enum(['manual', 'scheduled']).optional().default('manual'),
    sources: z
      .array(searchSourceSchema)
      .min(1)
      .max(6)
      .refine((sources) => new Set(sources).size === sources.length, 'Duplicate sources')
      .transform((sources) => sources.sort()),
  })
  .strict();

export type CreateSearch = z.infer<typeof createSearchSchema>;

/**
 * What a CALLER may hand in, as opposed to what the schema produces.
 *
 * `origin` above is `.optional().default('manual')`, and a Zod default makes a
 * field optional on INPUT and required on OUTPUT. `z.infer` is the output type,
 * so typing a parameter with it demands a shape that only exists after
 * `.parse()` — every valid unparsed call is rejected. The two types are not
 * interchangeable and the distinction is the whole point of having both.
 */
export type CreateSearchInput = z.input<typeof createSearchSchema>;

/**
 * Full-jitter exponential backoff in milliseconds: up to 1 s doubling per attempt, capped at 5
 * minutes, then scaled by `random()`. `attempt` is 1-based; anything else throws.
 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Invalid attempt');
  return Math.floor(Math.min(300_000, 1_000 * 2 ** Math.min(attempt - 1, 9)) * random());
}
