import { z } from 'zod';
import {
  candidateSchema,
  preferencesSchema,
  applicationSchema,
} from '../../../../packages/shared/dist/index.js';
import type { Database } from './database.js';
import { Conflict } from './errors.js';

const link = candidateSchema.shape.portfolio.refine((value) => {
  if (!value) return true;
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'Profile links must use HTTPS without credentials');

const fields = {
  candidate: candidateSchema
    .extend({
      email: candidateSchema.shape.email.max(254),
      linkedin: link,
      github: link,
      portfolio: link,
    })
    .strict(),
  preferences: preferencesSchema.strict(),
  application: applicationSchema.strict(),
};

export const writableProfileSchema = z
  .object({
    candidate: z.unknown(),
    preferences: z.unknown(),
    application: z.unknown(),
  })
  .strict()
  .transform((input, context) => {
    const candidate = fields.candidate.safeParse(input.candidate);
    const preferences = fields.preferences.safeParse(input.preferences);
    const application = fields.application.safeParse(input.application);
    if (!candidate.success || !preferences.success || !application.success) {
      context.addIssue({ code: 'custom', message: 'Invalid candidate profile' });
      return z.NEVER;
    }
    return {
      candidate: candidate.data,
      preferences: preferences.data,
      application: application.data,
    };
  });

export const saveProfileSchema = z
  .object({
    revision: z.number().int().min(0).max(2_147_483_646),
    profile: writableProfileSchema,
  })
  .strict();

export type WritableProfile = z.infer<typeof writableProfileSchema>;
export type MatchingProfile = {
  candidate: Pick<WritableProfile['candidate'], 'location'>;
  preferences: WritableProfile['preferences'];
  application: Pick<
    WritableProfile['application'],
    'expectedCtc' | 'yearsOfExperience' | 'willingToRelocate'
  >;
};

export function matchingProfile(profile: WritableProfile): MatchingProfile {
  return {
    candidate: { location: profile.candidate.location },
    preferences: profile.preferences,
    application: {
      expectedCtc: profile.application.expectedCtc,
      yearsOfExperience: profile.application.yearsOfExperience,
      willingToRelocate: profile.application.willingToRelocate,
    },
  };
}
export type ProfileRecord = { revision: number; profile: WritableProfile; updatedAt: Date };

export class ProfileRevisionConflict extends Conflict {}

export class ProfileRepository {
  constructor(private readonly database: Database) {}

  async get(ownerId: string): Promise<ProfileRecord | null> {
    const result = await this.database.pool.query<ProfileRecord>(
      'SELECT revision, data AS profile, updated_at AS "updatedAt" FROM candidate_profiles WHERE owner_id = $1',
      [ownerId],
    );
    return result.rows[0] ?? null;
  }

  async save(ownerId: string, input: unknown): Promise<ProfileRecord> {
    const { revision, profile } = saveProfileSchema.parse(input);
    const result =
      revision === 0
        ? await this.database.pool.query<ProfileRecord>(
            `INSERT INTO candidate_profiles (owner_id, data, revision)
          VALUES ($1, $2::jsonb, 1) ON CONFLICT (owner_id) DO NOTHING
          RETURNING revision, data AS profile, updated_at AS "updatedAt"`,
            [ownerId, JSON.stringify(profile)],
          )
        : await this.database.pool.query<ProfileRecord>(
            `UPDATE candidate_profiles
          SET data = $2::jsonb, revision = revision + 1, updated_at = now()
          WHERE owner_id = $1 AND revision = $3
          RETURNING revision, data AS profile, updated_at AS "updatedAt"`,
            [ownerId, JSON.stringify(profile), revision],
          );
    if (!result.rows[0]) throw new ProfileRevisionConflict('Profile revision changed');
    return result.rows[0];
  }
}
