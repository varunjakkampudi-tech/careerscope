import { z } from 'zod';

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

export const searchSourceSchema = z.enum([
  'remoteok',
  'himalayas',
  'greenhouse',
  'lever',
  'workable',
]);

export const createSearchSchema = z
  .object({
    query: z.string().trim().min(2).max(160),
    useProfileTitles: z.boolean().optional(),
    // CS-26: distinguishes an unattended, scheduler-created run from a human
    // clicking "search" - without this, "was this run automated" is only
    // recoverable by reverse-engineering the idempotency-key string, which
    // is a convention invisible to the schema, to any future UI, and to an
    // auditor. Optional and defaulted so every existing manual caller is
    // unaffected.
    origin: z.enum(['manual', 'scheduled']).optional().default('manual'),
    sources: z
      .array(searchSourceSchema)
      .min(1)
      .max(5)
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

export function retryDelay(attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Invalid attempt');
  return Math.floor(Math.min(300_000, 1_000 * 2 ** Math.min(attempt - 1, 9)) * random());
}
