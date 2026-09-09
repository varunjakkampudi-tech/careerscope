import { z } from 'zod';

export const applicationStatusSchema = z.enum([
  'running',
  'needs_input',
  'ready',
  'submitting',
  'submitted',
  'failed',
  'cancelled',
]);
export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;

export const applicationEventSchema = z.object({
  at: z.string(),
  message: z.string().max(2000),
});

export const applicationRunSchema = z
  .object({
    id: z.string(),
    leadId: z.string(),
    status: applicationStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    events: z.array(applicationEventSchema),
    currentUrl: z.string().nullable(),
    question: z.string().nullable(),
    confirmation: z.string().nullable(),
    requestId: z.string().nullable().default(null),
    outcomeUnknown: z.boolean().optional(),
    retryOf: z.string().nullable().default(null),
  })
  .transform((run) => ({
    ...run,
    outcomeUnknown: run.outcomeUnknown ?? run.status === 'failed',
  }));
export type ApplicationRun = z.infer<typeof applicationRunSchema>;

export function canTransitionApplication(from: ApplicationStatus, to: ApplicationStatus): boolean {
  const transitions: Record<ApplicationStatus, ApplicationStatus[]> = {
    running: ['needs_input', 'ready', 'failed', 'cancelled'],
    needs_input: ['running', 'cancelled'],
    ready: ['submitting', 'cancelled'],
    submitting: ['submitted', 'failed'],
    submitted: [],
    failed: [],
    cancelled: [],
  };
  return transitions[from].includes(to);
}
