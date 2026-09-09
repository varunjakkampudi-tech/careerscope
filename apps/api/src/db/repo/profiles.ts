/**
 * The candidate profile.
 *
 * One row in practice — `LOCAL_PROFILE_ID` — but the table is keyed and
 * user-scoped so multi-user is a migration rather than a rewrite.
 *
 * The interesting method is `update`, which deep-merges. The UI edits one field
 * at a time and `PUT /api/profile` carries only what changed; a shallow merge
 * would let a form that sends `{ preferences: { remoteOnly: true } }` erase the
 * tech stack.
 */

import {
  profileSchema,
  type Profile,
  type ProfileUpdate,
  type Candidate,
  type Preferences,
  type ApplicationDetails,
} from '@job-radar/shared';
import { fromJson, toStringOrNull, toText, type Db, type Row } from '../index.js';
import { LOCAL_PROFILE_ID, LOCAL_USER_ID } from '../../util/ids.js';

function rowToProfile(row: Row): Profile {
  return profileSchema.parse({
    id: toText(row['id']),
    candidate: fromJson<Candidate>(row['candidate'], 'profiles.candidate'),
    preferences: fromJson<Preferences>(row['preferences'], 'profiles.preferences'),
    application: fromJson<ApplicationDetails>(row['application'], 'profiles.application'),
    resumeId: toStringOrNull(row['resume_id']),
    updatedAt: toText(row['updated_at']),
  });
}

export class ProfileRepo {
  constructor(private readonly db: Db) {}

  get(id: string = LOCAL_PROFILE_ID): Profile | null {
    const row = this.db.get('SELECT * FROM profiles WHERE id = :id', { id });
    return row ? rowToProfile(row) : null;
  }

  exists(id: string = LOCAL_PROFILE_ID): boolean {
    return this.db.get('SELECT 1 FROM profiles WHERE id = :id', { id }) !== undefined;
  }

  /** Replaces the whole profile. Used by the onboarding form, which sends all of it. */
  save(profile: Profile, at: string, id: string = LOCAL_PROFILE_ID): Profile {
    const parsed = profileSchema.parse(profile);
    this.db.run(
      `INSERT INTO profiles (id, user_id, candidate, preferences, application, resume_id,
                             created_at, updated_at)
       VALUES (:id, :userId, :candidate, :preferences, :application, :resumeId, :at, :at)
       ON CONFLICT(id) DO UPDATE SET
         candidate   = excluded.candidate,
         preferences = excluded.preferences,
         application = excluded.application,
         resume_id   = excluded.resume_id,
         updated_at  = excluded.updated_at`,
      {
        id,
        userId: LOCAL_USER_ID,
        candidate: parsed.candidate,
        preferences: parsed.preferences,
        application: parsed.application,
        resumeId: parsed.resumeId,
        at,
      },
    );
    return this.get(id)!;
  }

  /**
   * Merges a partial update into the stored profile.
   *
   * The merge is one level deep on purpose — deep enough that
   * `{ preferences: { remoteOnly: true } }` keeps the tech stack, shallow enough
   * that `{ preferences: { techStack: [...] } }` *replaces* the array rather
   * than appending to it. Array-append would make removing a skill impossible
   * through this endpoint.
   */
  update(patch: ProfileUpdate, at: string, id: string = LOCAL_PROFILE_ID): Profile | null {
    const current = this.get(id);
    if (!current) return null;

    const merged: Profile = profileSchema.parse({
      ...current,
      candidate: { ...current.candidate, ...(patch.candidate ?? {}) },
      preferences: { ...current.preferences, ...(patch.preferences ?? {}) },
      application: { ...current.application, ...(patch.application ?? {}) },
      resumeId: patch.resumeId !== undefined ? patch.resumeId : current.resumeId,
    });
    return this.save(merged, at, id);
  }

  /** Called after a resume upload; the rest of the profile is untouched. */
  attachResume(resumeId: string, at: string, id: string = LOCAL_PROFILE_ID): void {
    this.db.run('UPDATE profiles SET resume_id = :resumeId, updated_at = :at WHERE id = :id', {
      id,
      resumeId,
      at,
    });
  }

  delete(id: string = LOCAL_PROFILE_ID): void {
    // Runs and leads cascade; resumes do not, because the file on disk has to be
    // unlinked too and that is the resume repo's job.
    this.db.run('DELETE FROM profiles WHERE id = :id', { id });
  }
}
