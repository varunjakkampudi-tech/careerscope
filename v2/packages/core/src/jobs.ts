import { z } from 'zod';
import { searchSourceSchema } from './commands.js';
import { matchBreakdownSchema } from '../../../../packages/shared/dist/index.js';

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
    title: z.string().min(1).max(500),
    company: z.string().min(1).max(500),
    location: z.string().max(500),
    description: z.string().max(100_000),
    source: searchSourceSchema,
    sourceUrl: publicLink,
    applyUrl: publicLink,
    postedAt: z.string().datetime().nullable(),
    match,
  })
  .strict();

export type CollectedJob = z.infer<typeof collectedJobSchema>;
export type CollectedJobInput = z.input<typeof collectedJobSchema>;
export const collectedJobsSchema = z.array(collectedJobSchema).max(100);
