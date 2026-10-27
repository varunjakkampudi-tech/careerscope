/**
 * Reasons a candidate can give when flagging a job. Validated by the API and stored by `core`
 * as job feedback.
 */

import { z } from 'zod';

/** Allowed feedback reasons, in the order the UI offers them. */
export const jobFeedbackReasons = [
  'irrelevant',
  'duplicate',
  'incorrect',
  'unavailable',
  'suspicious',
] as const;

export const jobFeedbackReasonSchema = z.enum(jobFeedbackReasons);
export type JobFeedbackReason = z.infer<typeof jobFeedbackReasonSchema>;
