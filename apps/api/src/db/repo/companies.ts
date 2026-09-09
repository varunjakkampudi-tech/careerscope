/**
 * Companies.
 *
 * The distinguishing rule of this table, enforced here rather than left to
 * callers: **enrichment may fill a blank, never overwrite a better answer with a
 * worse one.** `upsertFromJob` writes only fields that are currently null, and
 * `applyResolution` only replaces a value when the incoming confidence is at
 * least as strong. Without that, a run in which one board happens to omit the
 * company website would erase a link a previous run verified.
 */

import { companySlug } from '@job-radar/providers';
import { companySchema, type Company, type Confidence, type Job } from '@job-radar/shared';
import { fromJson, toStringOrNull, toText, type Db, type Row } from '../index.js';

/** Ranked so a stronger observation can be compared against a weaker one. */
const CONFIDENCE_RANK: Record<Confidence, number> = {
  unverified: 0,
  probable: 1,
  verified: 2,
};

function rowToCompany(row: Row): Company {
  return companySchema.parse({
    id: toText(row['id']),
    name: toText(row['name']),
    website: toStringOrNull(row['website']),
    careersUrl: toStringOrNull(row['careers_url']),
    atsType: toStringOrNull(row['ats_type']),
    atsPortalUrl: toStringOrNull(row['ats_portal_url']),
    careersEmail: toStringOrNull(row['careers_email']),
    emailConfidence: toText(row['email_confidence']),
    websiteConfidence: toText(row['website_confidence']),
    linkedinUrl: toStringOrNull(row['linkedin_url']),
    note: toStringOrNull(row['note']),
    resolvedAt: toStringOrNull(row['resolved_at']),
  });
}

const SELECT = 'SELECT * FROM companies';

export class CompanyRepo {
  constructor(private readonly db: Db) {}

  get(id: string): Company | null {
    const row = this.db.get(`${SELECT} WHERE id = :id`, { id });
    return row ? rowToCompany(row) : null;
  }

  getMany(ids: readonly string[]): Map<string, Company> {
    const found = new Map<string, Company>();
    // Chunked because SQLite caps a statement at 999 bound parameters by
    // default, and a large run can touch more companies than that.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const params = Object.fromEntries(chunk.map((id, index) => [`id${index}`, id]));
      const placeholders = chunk.map((_, index) => `:id${index}`).join(', ');
      for (const row of this.db.all(`${SELECT} WHERE id IN (${placeholders})`, params)) {
        const company = rowToCompany(row);
        found.set(company.id, company);
      }
    }
    return found;
  }

  byName(name: string): Company | null {
    return this.get(companySlug(name));
  }

  search(term: string, limit = 25): Company[] {
    return this.db
      .all(`${SELECT} WHERE name LIKE :term COLLATE NOCASE ORDER BY name LIMIT :limit`, {
        term: `%${term}%`,
        limit,
      })
      .map(rowToCompany);
  }

  /**
   * Records the employer named by a job, filling in anything the board happened
   * to include.
   *
   * `COALESCE(existing, incoming)` is the whole idea: an ATS that returns a
   * careers URL populates it, and a later aggregator listing the same employer
   * with no URL leaves it alone.
   */
  upsertFromJob(job: Job, now: string): void {
    const company = job.company;
    this.db.run(
      `INSERT INTO companies (id, name, website, careers_url, ats_portal_url, careers_email,
                              email_confidence, website_confidence, created_at)
       VALUES (:id, :name, :website, :careersUrl, :atsPortalUrl, :careersEmail,
               :emailConfidence, :websiteConfidence, :now)
       ON CONFLICT(id) DO UPDATE SET
         website        = COALESCE(companies.website, excluded.website),
         careers_url    = COALESCE(companies.careers_url, excluded.careers_url),
         ats_portal_url = COALESCE(companies.ats_portal_url, excluded.ats_portal_url),
         careers_email  = COALESCE(companies.careers_email, excluded.careers_email),
         website_confidence = CASE
           WHEN companies.website IS NULL AND excluded.website IS NOT NULL
             THEN excluded.website_confidence
           ELSE companies.website_confidence
         END,
         resolved_at = CASE
           WHEN (companies.website IS NULL AND excluded.website IS NOT NULL)
             OR (companies.careers_url IS NULL AND excluded.careers_url IS NOT NULL)
             OR (companies.ats_portal_url IS NULL AND excluded.ats_portal_url IS NOT NULL)
             THEN NULL
           ELSE companies.resolved_at
         END,
         email_confidence = CASE
           WHEN companies.careers_email IS NULL AND excluded.careers_email IS NOT NULL
             THEN excluded.email_confidence
           ELSE companies.email_confidence
         END`,
      {
        id: company.id,
        name: company.name,
        website: company.website,
        careersUrl: company.careersUrl,
        atsPortalUrl: company.atsPortalUrl,
        careersEmail: company.careersEmail,
        emailConfidence: company.emailConfidence,
        // An ATS that names the employer's own site is a strong signal; a bare
        // company name from an aggregator is not, and normalizeJob sends null
        // in that case, so this branch never fires on a guess.
        websiteConfidence: company.website ? 'probable' : 'unverified',
        now,
      },
    );
  }

  /** Which of these have never been looked at by enrichment. */
  unresolved(ids: readonly string[]): string[] {
    if (ids.length === 0) return [];
    const pending: string[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const params = Object.fromEntries(chunk.map((id, index) => [`id${index}`, id]));
      const placeholders = chunk.map((_, index) => `:id${index}`).join(', ');
      for (const row of this.db.all(
        `SELECT id FROM companies WHERE id IN (${placeholders}) AND resolved_at IS NULL`,
        params,
      )) {
        pending.push(toText(row['id']));
      }
    }
    return pending;
  }

  /**
   * Writes what enrichment found.
   *
   * A field is only replaced when the new observation is at least as confident
   * as the stored one, so a heuristic guess never displaces a verified value —
   * and `resolved_at` is stamped either way, because "we looked and found
   * nothing" is a result worth remembering rather than re-deriving next run.
   */
  applyResolution(
    id: string,
    patch: {
      website?: string | null;
      websiteConfidence?: Confidence;
      careersUrl?: string | null;
      atsType?: string | null;
      atsPortalUrl?: string | null;
      careersEmail?: string | null;
      emailConfidence?: Confidence;
      linkedinUrl?: string | null;
      note?: string | null;
    },
    now: string,
  ): Company | null {
    const existing = this.get(id);
    if (!existing) return null;

    const stronger = (incoming: Confidence | undefined, current: Confidence) =>
      incoming !== undefined && CONFIDENCE_RANK[incoming] >= CONFIDENCE_RANK[current];

    // The confidence moves with the value it describes. Writing the incoming
    // confidence onto a value that was *not* adopted would quietly relabel a
    // verified website as probable, and the next weak observation would then be
    // strong enough to overwrite it — the guard would hold once and then fail.
    const adoptWebsite = stronger(patch.websiteConfidence, existing.websiteConfidence);
    const website = adoptWebsite ? (patch.website ?? existing.website) : existing.website;
    const websiteConfidence = adoptWebsite
      ? (patch.websiteConfidence ?? existing.websiteConfidence)
      : existing.websiteConfidence;

    const adoptEmail = stronger(patch.emailConfidence, existing.emailConfidence);
    const email = adoptEmail
      ? (patch.careersEmail ?? existing.careersEmail)
      : existing.careersEmail;
    const emailConfidence = adoptEmail
      ? (patch.emailConfidence ?? existing.emailConfidence)
      : existing.emailConfidence;

    this.db.run(
      `UPDATE companies SET
         website            = :website,
         website_confidence = :websiteConfidence,
         careers_url        = COALESCE(:careersUrl, careers_url),
         ats_type           = COALESCE(:atsType, ats_type),
         ats_portal_url     = COALESCE(:atsPortalUrl, ats_portal_url),
         careers_email      = :careersEmail,
         email_confidence   = :emailConfidence,
         linkedin_url       = COALESCE(:linkedinUrl, linkedin_url),
         note               = COALESCE(:note, note),
         resolved_at        = :now
       WHERE id = :id`,
      {
        id,
        website,
        // A null value is always unverified, whatever the observation claimed.
        websiteConfidence: website ? websiteConfidence : 'unverified',
        careersUrl: patch.careersUrl,
        atsType: patch.atsType,
        atsPortalUrl: patch.atsPortalUrl,
        careersEmail: email,
        emailConfidence: email ? emailConfidence : 'unverified',
        linkedinUrl: patch.linkedinUrl,
        note: patch.note,
        now,
      },
    );
    return this.get(id);
  }

  /**
   * Loads `seed/companies.json`, the hand-verified directory carried over
   * from the retired lead-collection script. Existing rows win: a company the
   * app has since resolved for itself knows more than a file from August.
   */
  seed(companies: readonly SeedCompany[], now: string): number {
    return this.db.tx(() => {
      let inserted = 0;
      for (const seed of companies) {
        if (!seed.website && !seed.atsPortalUrl && !seed.careersEmail) continue;
        const result = this.db.run(
          `INSERT INTO companies (id, name, website, website_confidence, ats_portal_url,
                                  careers_email, email_confidence, note, created_at)
           VALUES (:id, :name, :website, :websiteConfidence, :atsPortalUrl,
                   :careersEmail, :emailConfidence, :note, :now)
           ON CONFLICT(id) DO NOTHING`,
          {
            id: companySlug(seed.name),
            name: seed.name,
            website: seed.website,
            // Every one of these was opened and read by a human, which is a
            // stronger signal than anything the resolver can produce alone.
            websiteConfidence: seed.website ? 'verified' : 'unverified',
            atsPortalUrl: seed.atsPortalUrl,
            careersEmail: seed.careersEmail,
            emailConfidence: seed.emailConfidence,
            note:
              [seed.websiteNote, seed.emailNote, seed.listingNote].filter(Boolean).join(' · ') ||
              null,
            now,
          },
        );
        inserted += result.changes;
      }
      return inserted;
    });
  }

  count(): number {
    return Number(this.db.get('SELECT COUNT(*) AS n FROM companies')?.['n'] ?? 0);
  }
}

/** One entry of `seed/companies.json`. */
export interface SeedCompany {
  name: string;
  website: string | null;
  websiteNote: string | null;
  atsPortalUrl: string | null;
  directListingUrl: string | null;
  listingNote: string | null;
  careersEmail: string | null;
  emailConfidence: Confidence;
  emailNote: string | null;
  excludedFromApply: boolean;
  verified: boolean;
}

export function parseSeedFile(json: string): SeedCompany[] {
  const parsed = fromJson<{ companies?: SeedCompany[] }>(json, 'companies.json');
  return parsed.companies ?? [];
}
