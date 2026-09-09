/**
 * Jobs.
 *
 * The one rule that matters here is **upsert by fingerprint, and let a richer
 * observation win**. The same posting turns up on Greenhouse (full JD, direct
 * apply link) and again on an aggregator (title, snippet, tracking URL). Both
 * hash to the same fingerprint, so they collapse to one row — and the row must
 * end up holding the Greenhouse version regardless of which arrived second.
 *
 * `upsert` therefore does not blindly overwrite. It keeps the longer description,
 * keeps `has_full_description` once it is true, and keeps a salary that has
 * numbers over one that has only text. Only `last_seen_at` is unconditional,
 * because "still listed today" is the newest fact by definition.
 */

import { jobSchema, type Job, type Salary } from '@job-radar/shared';
import { fromJson, toBool, toStringOrNull, toText, type Db, type Row } from '../index.js';

/**
 * Jobs are stored with a company id; the UI needs the company's enriched fields
 * alongside. One LEFT JOIN beats an N+1, and LEFT rather than INNER so a job
 * whose company row was somehow removed still renders instead of vanishing.
 */
const SELECT = `
  SELECT j.*,
         c.name               AS c_name,
         c.website            AS c_website,
         c.careers_url        AS c_careers_url,
         c.ats_portal_url     AS c_ats_portal_url,
         c.careers_email      AS c_careers_email,
         c.email_confidence   AS c_email_confidence
    FROM jobs j
    LEFT JOIN companies c ON c.id = j.company_id`;

export function rowToJob(row: Row): Job {
  return jobSchema.parse({
    id: toText(row['id']),
    fingerprint: toText(row['fingerprint']),
    source: toText(row['source']),
    sourceJobId: toText(row['source_job_id']),
    title: toText(row['title']),
    company: {
      id: toText(row['company_id']),
      // Falls back to the id when the join found nothing: the slug is ugly but
      // it is still the company's name, which beats an empty cell.
      name: toStringOrNull(row['c_name']) ?? toText(row['company_id']),
      website: toStringOrNull(row['c_website']),
      careersUrl: toStringOrNull(row['c_careers_url']),
      atsPortalUrl: toStringOrNull(row['c_ats_portal_url']),
      careersEmail: toStringOrNull(row['c_careers_email']),
      emailConfidence: toStringOrNull(row['c_email_confidence']) ?? 'unverified',
    },
    location: toText(row['location']),
    isRemote: toBool(row['is_remote']),
    employmentType: toStringOrNull(row['employment_type']),
    salary: fromJson<Salary>(row['salary'], 'jobs.salary'),
    postedAt: toStringOrNull(row['posted_at']),
    descriptionText: toText(row['description_text']),
    hasFullDescription: toBool(row['has_full_description']),
    techStack: fromJson<string[]>(row['tech_stack'], 'jobs.tech_stack'),
    requiredYears: fromJson<{ min: number | null; max: number | null }>(
      row['required_years'],
      'jobs.required_years',
    ),
    applyUrl: toText(row['apply_url']),
    sourceUrl: toText(row['source_url']),
    sourcePublisher: toStringOrNull(row['source_publisher']),
    firstSeenAt: toText(row['first_seen_at']),
    lastSeenAt: toText(row['last_seen_at']),
  });
}

export class JobRepo {
  constructor(private readonly db: Db) {}

  get(id: string): Job | null {
    const row = this.db.get(`${SELECT} WHERE j.id = :id`, { id });
    return row ? rowToJob(row) : null;
  }

  byFingerprint(fingerprint: string): Job | null {
    const row = this.db.get(`${SELECT} WHERE j.fingerprint = :fingerprint`, { fingerprint });
    return row ? rowToJob(row) : null;
  }

  /**
   * Inserts or merges a job, returning the stored row.
   *
   * `normalizeJob` already sets `id = fingerprint`, so the primary key and the
   * dedupe key are the same value and there is no lookup to do first.
   */
  upsert(job: Job, at: string): Job {
    const parsed = jobSchema.parse(job);
    this.db.run(
      `INSERT INTO jobs (id, fingerprint, source, source_job_id, title, company_id, location,
                         is_remote, employment_type, salary, salary_annual_min, salary_annual_max,
                         posted_at, description_text, has_full_description, tech_stack,
                         required_years, apply_url, source_url, source_publisher,
                         first_seen_at, last_seen_at)
       VALUES (:id, :fingerprint, :source, :sourceJobId, :title, :companyId, :location,
               :isRemote, :employmentType, :salary, :salaryAnnualMin, :salaryAnnualMax,
               :postedAt, :descriptionText, :hasFullDescription, :techStack,
               :requiredYears, :applyUrl, :sourceUrl, :sourcePublisher, :at, :at)
       ON CONFLICT(fingerprint) DO UPDATE SET
         -- Always true: the posting is live right now.
         last_seen_at = excluded.last_seen_at,

         -- A full JD beats a snippet, and a longer JD beats a shorter one. This
         -- is what lets an aggregator hit be upgraded by the ATS hit that
         -- follows it, in either arrival order.
         description_text = CASE
           WHEN excluded.has_full_description > jobs.has_full_description
             OR (excluded.has_full_description = jobs.has_full_description
               AND length(excluded.description_text) > length(jobs.description_text))
             THEN excluded.description_text
           ELSE jobs.description_text
         END,
         has_full_description = CASE
           WHEN excluded.has_full_description = 1 THEN 1
           ELSE jobs.has_full_description
         END,
         tech_stack = CASE
           WHEN excluded.has_full_description > jobs.has_full_description
             OR (excluded.has_full_description = jobs.has_full_description
               AND json_array_length(excluded.tech_stack) > json_array_length(jobs.tech_stack))
             THEN excluded.tech_stack
           ELSE jobs.tech_stack
         END,
         required_years = CASE
           WHEN excluded.has_full_description > jobs.has_full_description
             OR (excluded.has_full_description = jobs.has_full_description
               AND length(excluded.description_text) > length(jobs.description_text))
             THEN excluded.required_years
           ELSE jobs.required_years
         END,

         -- A figure beats a description of a figure. "Competitive salary" must
         -- never displace "₹28,00,000 – ₹38,00,000".
         salary = CASE
           WHEN jobs.salary_annual_max IS NULL AND excluded.salary_annual_max IS NOT NULL
             THEN excluded.salary
           ELSE jobs.salary
         END,
         salary_annual_min = COALESCE(jobs.salary_annual_min, excluded.salary_annual_min),
         salary_annual_max = COALESCE(jobs.salary_annual_max, excluded.salary_annual_max),

         posted_at        = COALESCE(jobs.posted_at, excluded.posted_at),
         employment_type  = COALESCE(jobs.employment_type, excluded.employment_type),
         source_publisher = COALESCE(jobs.source_publisher, excluded.source_publisher),

         -- Prefer an apply URL that is not an aggregator redirect. An ATS row
         -- arriving second should replace a tracking link with the real form.
         apply_url = CASE
           WHEN excluded.has_full_description = 1 AND jobs.has_full_description = 0
             THEN excluded.apply_url
           ELSE jobs.apply_url
         END`,
      {
        id: parsed.id,
        fingerprint: parsed.fingerprint,
        source: parsed.source,
        sourceJobId: parsed.sourceJobId,
        title: parsed.title,
        companyId: parsed.company.id,
        location: parsed.location,
        isRemote: parsed.isRemote,
        employmentType: parsed.employmentType,
        salary: parsed.salary,
        salaryAnnualMin: parsed.salary.annualMin,
        salaryAnnualMax: parsed.salary.annualMax,
        postedAt: parsed.postedAt,
        descriptionText: parsed.descriptionText,
        hasFullDescription: parsed.hasFullDescription,
        techStack: parsed.techStack,
        requiredYears: parsed.requiredYears,
        applyUrl: parsed.applyUrl,
        sourceUrl: parsed.sourceUrl,
        sourcePublisher: parsed.sourcePublisher,
        at,
      },
    );
    return this.byFingerprint(parsed.fingerprint)!;
  }

  /** One transaction for a run's whole batch — a few hundred inserts otherwise fsync individually. */
  upsertMany(jobs: readonly Job[], at: string): Job[] {
    return this.db.tx(() => jobs.map((job) => this.upsert(job, at)));
  }

  /**
   * Jobs no longer seen and not attached to any lead.
   *
   * A job the user has saved or applied to is kept forever regardless of age —
   * losing the record of a job you applied to is the one deletion that would
   * actually hurt.
   */
  pruneStale(before: string): number {
    return this.db.run(
      `DELETE FROM jobs
        WHERE last_seen_at < :before
          AND id NOT IN (SELECT job_id FROM leads)`,
      { before },
    ).changes;
  }

  count(): number {
    return Number(this.db.get('SELECT COUNT(*) AS n FROM jobs')?.['n'] ?? 0);
  }
}
