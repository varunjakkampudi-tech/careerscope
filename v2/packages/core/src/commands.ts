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
    sources: z
      .array(searchSourceSchema)
      .min(1)
      .max(5)
      .refine((sources) => new Set(sources).size === sources.length, 'Duplicate sources')
      .transform((sources) => sources.sort()),
  })
  .strict();

export type CreateSearch = z.infer<typeof createSearchSchema>;

export function retryDelay(attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Invalid attempt');
  return Math.floor(Math.min(300_000, 1_000 * 2 ** Math.min(attempt - 1, 9)) * random());
}
