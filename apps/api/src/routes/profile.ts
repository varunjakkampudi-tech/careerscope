/**
 * The candidate profile — one row, `id = 'local'`.
 *
 * `PUT` deep-merges rather than replacing. The onboarding form saves a section
 * at a time, and a whole-document PUT would mean the resume-derived tech stack
 * is wiped every time someone corrects their phone number. `profileUpdateSchema`
 * is built for exactly this: each section is optional and partial.
 *
 * `DELETE` exists because the settings screen offers "wipe my data", and an app
 * that holds a person's CTC and phone number should be able to forget them
 * without the user going looking for a database file.
 */

import { profileSchema, profileUpdateSchema, type Profile } from '@job-radar/shared';
import { buildCandidateContext, scoreJob } from '@job-radar/matching';
import type { FastifyInstance } from 'fastify';
import { ApiProblem, parseOrThrow } from '../errors.js';
import { now } from '../util/time.js';
import type { RouteOptions } from './index.js';

export async function profileRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { repos } = options.container;

  function ensureSearchIdle() {
    if (repos.runs.active()) {
      throw new ApiProblem(
        409,
        'run_in_progress',
        'A search is running. Wait for it to finish before saving your profile.',
      );
    }
  }

  function rescore(profile: Profile, at: string) {
    const resume = profile.resumeId ? repos.resumes.get(profile.resumeId) : null;
    const candidate = buildCandidateContext(
      { ...profile, derived: resume?.derived ?? null },
      profile.resumeId ? (repos.resumes.text(profile.resumeId) ?? '') : '',
    );
    for (const lead of repos.leads.forProfile()) {
      repos.leads.upsert(
        {
          jobId: lead.job.id,
          runId: lead.runId,
          breakdown: scoreJob(lead.job, candidate, { windowDays: 30 }),
        },
        at,
      );
    }
  }

  /**
   * The profile, or `null` when onboarding has not happened yet.
   *
   * Deliberately **not** a 404. This is a singleton: `/api/profile` always
   * addresses something in a single-user app, and what varies is whether that
   * something has been filled in. A 404 would make the ordinary first-run state
   * an exception — one the browser logs to the console on every cold load, and
   * one every caller has to catch and translate back into "not yet". Returning
   * the empty representation keeps "absent" in the data where it belongs.
   */
  app.get('/profile', async () => {
    return { profile: repos.profiles.get() };
  });

  /**
   * Whether onboarding has been completed.
   *
   * Still separate from `GET /profile`, and not redundant with it: this answers
   * the routing question at boot without shipping the candidate's phone number
   * and salary to do it. `App.tsx` blocks its first paint on this call, so it
   * stays as small as the question it answers.
   */
  app.get('/profile/status', async () => {
    const profile = repos.profiles.get();
    return {
      exists: profile !== null,
      hasResume: profile?.resumeId != null,
      updatedAt: profile?.updatedAt ?? null,
    };
  });

  /** Full replace. Used by onboarding, which has every field in hand. */
  app.post('/profile', async (request, reply) => {
    const profile = parseOrThrow(profileSchema, request.body, 'profile');
    ensureSearchIdle();
    const at = now();
    const saved = repos.db.tx(() => {
      const savedProfile = repos.profiles.save(profile, at);
      rescore(savedProfile, at);
      return savedProfile;
    });
    return reply.status(201).send({ profile: saved });
  });

  /** Partial update, deep-merged. Used by every later edit. */
  app.put('/profile', async (request) => {
    const patch = parseOrThrow(profileUpdateSchema, request.body, 'profile update');
    ensureSearchIdle();

    const at = now();
    const updated = repos.db.tx(() => {
      const savedProfile = repos.profiles.update(patch, at);
      if (savedProfile) rescore(savedProfile, at);
      return savedProfile;
    });
    if (!updated) {
      // `update` returns null when there is nothing to merge into. Telling the
      // caller to POST first is more useful than a bare 404, because the two
      // endpoints differ only in whether the profile already exists.
      throw new ApiProblem(
        409,
        'profile_missing',
        'No profile to update yet — POST /api/profile with a complete profile first',
      );
    }
    return { profile: updated };
  });

  app.delete('/profile', async (_request, reply) => {
    if (options.container.applications.runs.active())
      throw ApiProblem.conflict('Cancel the active application before deleting your profile.');
    repos.profiles.delete();
    return reply.status(204).send();
  });
}
