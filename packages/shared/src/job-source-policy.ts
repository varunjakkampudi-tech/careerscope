/**
 * Permission gate for job discovery sources. A source is usable only with a current, reviewed
 * permission profile; collaborators are the API search routes and `core` search creation.
 */

import { z } from 'zod';
import { type SourceId } from './constants.js';

/**
 * Launch discovery is limited to these ATS board integrations. Candidate-
 * supplied links are not provider collection and are not covered by this
 * source catalog. Other providers are unavailable for launch.
 */
export const LAUNCH_JOB_SOURCE_CANDIDATES = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
] as const satisfies readonly SourceId[];

/**
 * Record of the rights granted for one source. `reviewBy` must be later than `approvedAt`, so a
 * profile always has a finite validity window.
 */
export const jobSourcePermissionProfileSchema = z
  .object({
    source: z.enum(LAUNCH_JOB_SOURCE_CANDIDATES),
    approvalRef: z.string().min(8).max(120),
    evidenceRef: z.string().min(3).max(240),
    approvedAt: z.string().datetime(),
    reviewBy: z.string().datetime(),
    rights: z
      .object({
        collection: z.boolean(),
        storage: z.boolean(),
        transformation: z.boolean(),
        candidateDisplay: z.boolean(),
        aiProcessing: z.boolean(),
        publicDisplay: z.boolean(),
        redistribution: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .refine((profile) => Date.parse(profile.reviewBy) > Date.parse(profile.approvedAt));

export type JobSourcePermissionProfile = z.infer<typeof jobSourcePermissionProfileSchema>;

/**
 * Empty: no source has recorded rights evidence, so discovery is closed.
 * Adding a profile requires a reviewed, source-specific permission record;
 * credentials or full provider terms must never be stored here.
 */
export const APPROVED_JOB_SOURCE_PROFILES: readonly JobSourcePermissionProfile[] =
  jobSourcePermissionProfileSchema.array().parse([]);

/** User-facing message returned when no permitted source is available. */
export const JOB_SOURCE_PERMISSION_PENDING_MESSAGE =
  'Job discovery is unavailable until the selected source has an approved, current permission profile.';

/**
 * True only for a launch-candidate source whose profile is currently valid and grants collection,
 * storage, transformation and candidate display. Expired or not-yet-approved profiles fail closed.
 */
export function isJobSourcePermittedForCandidateDiscovery(
  source: SourceId,
  profiles: readonly JobSourcePermissionProfile[] = APPROVED_JOB_SOURCE_PROFILES,
  now = Date.now(),
): boolean {
  if (!(LAUNCH_JOB_SOURCE_CANDIDATES as readonly string[]).includes(source)) return false;
  const profile = profiles.find((candidate) => candidate.source === source);
  if (!profile || Date.parse(profile.approvedAt) > now || Date.parse(profile.reviewBy) <= now)
    return false;
  return (
    profile.rights.collection &&
    profile.rights.storage &&
    profile.rights.transformation &&
    profile.rights.candidateDisplay
  );
}

/** Launch sources that currently pass {@link isJobSourcePermittedForCandidateDiscovery}. */
export function permittedCandidateDiscoverySources(
  profiles: readonly JobSourcePermissionProfile[] = APPROVED_JOB_SOURCE_PROFILES,
  now = Date.now(),
) {
  return LAUNCH_JOB_SOURCE_CANDIDATES.filter((source) =>
    isJobSourcePermittedForCandidateDiscovery(source, profiles, now),
  );
}

/** The subset of `sources` that is not currently permitted. */
export function unpermittedCandidateDiscoverySources(
  sources: readonly SourceId[],
  profiles: readonly JobSourcePermissionProfile[] = APPROVED_JOB_SOURCE_PROFILES,
  now = Date.now(),
) {
  return sources.filter(
    (source) => !isJobSourcePermittedForCandidateDiscovery(source, profiles, now),
  );
}
