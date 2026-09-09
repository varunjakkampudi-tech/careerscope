/**
 * Leads — a job, scored against a profile.
 *
 * This is the table the main screen reads, so the filtering, sorting and
 * counting all live here rather than being done in JavaScript over a full table
 * scan. Three decisions worth stating up front:
 *
 *  - **`score` is a real column**, not `json_extract(breakdown, '$.score')`. The
 *    default view is `ORDER BY score DESC` over every lead the user has; an
 *    expression index would work but a plain column is obvious to the next
 *    reader and free to maintain.
 *  - **Facets ignore the score filter.** The summary strip reads "412 leads · 87
 *    at ≥85%", which is only true if the denominator is the set *before* the
 *    threshold is applied — otherwise the slider always reports 100%.
 *  - **Sort keys come from a whitelist**, never from the query string. The one
 *    place in the app where a string reaches SQL unquoted is `ORDER BY`, so it
 *    is mapped through `SORT_COLUMNS` and nothing else.
 */

import {
  leadSchema,
  type Lead,
  type LeadQuery,
  type LeadPage,
  type LeadStatus,
  type MatchBreakdown,
  type SkillGap,
  type SkillGapEntry,
  type SkillGapQuery,
} from '@job-radar/shared';
import { fromJson, toNumberOrNull, toStringOrNull, toText, type Db, type Row } from '../index.js';
import { rowToJob } from './jobs.js';
import { LOCAL_PROFILE_ID, LOCAL_USER_ID, newId } from '../../util/ids.js';
import { daysAgo } from '../../util/time.js';

/**
 * `j.*` and the `c_*` aliases are exactly what `rowToJob` reads; the lead's own
 * columns are prefixed so `id` and `created_at` do not collide with the job's.
 */
const SELECT = `
  SELECT l.id          AS lead_id,
         l.run_id      AS lead_run_id,
         l.score       AS lead_score,
         l.breakdown   AS lead_breakdown,
         l.status      AS lead_status,
         l.note        AS lead_note,
         l.created_at  AS lead_created_at,
         l.updated_at  AS lead_updated_at,
         j.*,
         c.name             AS c_name,
         c.website          AS c_website,
         c.careers_url      AS c_careers_url,
         c.ats_portal_url   AS c_ats_portal_url,
         c.careers_email    AS c_careers_email,
         c.email_confidence AS c_email_confidence
    FROM leads l
    JOIN jobs j      ON j.id = l.job_id
    LEFT JOIN companies c ON c.id = j.company_id`;

function rowToLead(row: Row): Lead {
  return leadSchema.parse({
    id: toText(row['lead_id']),
    runId: toStringOrNull(row['lead_run_id']),
    job: rowToJob(row),
    match: fromJson<MatchBreakdown>(row['lead_breakdown'], 'leads.breakdown'),
    status: toText(row['lead_status']),
    note: toText(row['lead_note']),
    createdAt: toText(row['lead_created_at']),
    updatedAt: toText(row['lead_updated_at']),
  });
}

/** The only strings allowed into an ORDER BY. */
const SORT_COLUMNS: Record<LeadQuery['sort'], string> = {
  score: 'l.score',
  postedAt: 'j.posted_at',
  company: 'c.name COLLATE NOCASE',
  title: 'j.title COLLATE NOCASE',
  salary: 'j.salary_annual_max',
};

interface Where {
  sql: string;
  params: Record<string, unknown>;
}

/**
 * Builds the WHERE clause. `skipScore` exists for the facet queries, which need
 * the same filters with the threshold left off.
 */
function buildWhere(profileId: string, query: LeadQuery, skipScore = false): Where {
  const clauses = ['l.profile_id = :profileId'];
  const params: Record<string, unknown> = { profileId };

  if (!skipScore && query.minScore > 0) {
    clauses.push('l.score >= :minScore');
    params['minScore'] = query.minScore;
  }
  if (query.sources?.length) {
    const keys = query.sources.map((source, index) => {
      params[`source${index}`] = source;
      return `:source${index}`;
    });
    clauses.push(`j.source IN (${keys.join(', ')})`);
  }
  if (query.statuses?.length) {
    const keys = query.statuses.map((status, index) => {
      params[`status${index}`] = status;
      return `:status${index}`;
    });
    clauses.push(`l.status IN (${keys.join(', ')})`);
  }
  if (query.location) {
    clauses.push('j.location LIKE :location COLLATE NOCASE');
    params['location'] = `%${query.location}%`;
  }
  if (query.company) {
    clauses.push('c.name LIKE :company COLLATE NOCASE');
    params['company'] = `%${query.company}%`;
  }
  if (query.search) {
    // Title and company are what people actually type; the description is
    // included because "Kubernetes" is more often in the JD than the title.
    clauses.push(
      '(j.title LIKE :search COLLATE NOCASE OR c.name LIKE :search COLLATE NOCASE OR j.description_text LIKE :search COLLATE NOCASE)',
    );
    params['search'] = `%${query.search}%`;
  }
  if (query.remoteOnly) {
    clauses.push('j.is_remote = 1');
  }
  if (query.postedWithinDays !== undefined) {
    // A job with no posted date is excluded here rather than assumed recent.
    clauses.push('j.posted_at IS NOT NULL AND j.posted_at >= :postedAfter');
    params['postedAfter'] = daysAgo(query.postedWithinDays);
  }
  if (query.minSalary !== undefined) {
    clauses.push('j.salary_annual_max IS NOT NULL AND j.salary_annual_max >= :minSalary');
    params['minSalary'] = query.minSalary;
  }
  if (query.runId) {
    clauses.push('l.run_id = :runId');
    params['runId'] = query.runId;
  }

  return { sql: clauses.join(' AND '), params };
}

export interface UpsertLeadInput {
  jobId: string;
  runId: string | null;
  breakdown: MatchBreakdown;
}

export class LeadRepo {
  constructor(private readonly db: Db) {}

  get(id: string): Lead | null {
    const row = this.db.get(`${SELECT} WHERE l.id = :id`, { id });
    return row ? rowToLead(row) : null;
  }

  /**
   * One page of leads plus the facet counts for the summary strip.
   *
   * NULLs sort last in every direction: a job with no disclosed salary belongs
   * at the bottom of "highest paying" *and* the bottom of "lowest paying",
   * because in both cases the honest answer is "we don't know".
   */
  page(query: LeadQuery, profileId: string = LOCAL_PROFILE_ID): LeadPage {
    const where = buildWhere(profileId, query);
    const column = SORT_COLUMNS[query.sort];
    const direction = query.order === 'asc' ? 'ASC' : 'DESC';

    const items = this.db
      .all(
        `${SELECT} WHERE ${where.sql}
         ORDER BY ${column} IS NULL, ${column} ${direction}, l.created_at DESC
         LIMIT :limit OFFSET :offset`,
        { ...where.params, limit: query.limit, offset: query.offset },
      )
      .map(rowToLead);

    const total = Number(
      this.db.get(
        `SELECT COUNT(*) AS n FROM leads l JOIN jobs j ON j.id = l.job_id
           LEFT JOIN companies c ON c.id = j.company_id WHERE ${where.sql}`,
        where.params,
      )?.['n'] ?? 0,
    );

    return {
      items,
      total,
      limit: query.limit,
      offset: query.offset,
      ...this.facets(query, profileId),
    };
  }

  /**
   * Counts by source and status over the filtered set with the score threshold
   * removed, plus how many of those clear it. That is what makes the slider
   * legible: "412 leads · 87 at ≥85%" rather than "87 leads · 87 at ≥85%".
   */
  private facets(query: LeadQuery, profileId: string): Pick<LeadPage, 'facets'> {
    const where = buildWhere(profileId, query, true);
    const base = `FROM leads l JOIN jobs j ON j.id = l.job_id
                    LEFT JOIN companies c ON c.id = j.company_id
                   WHERE ${where.sql}`;

    const bySource: Record<string, number> = {};
    const sourceWhere = buildWhere(profileId, { ...query, sources: undefined }, true);
    for (const row of this.db.all(
      `SELECT j.source AS k, COUNT(*) AS n
         FROM leads l JOIN jobs j ON j.id = l.job_id
         LEFT JOIN companies c ON c.id = j.company_id
        WHERE ${sourceWhere.sql} GROUP BY j.source`,
      sourceWhere.params,
    )) {
      bySource[toText(row['k'])] = Number(row['n'] ?? 0);
    }

    const byStatus: Record<string, number> = {};
    for (const row of this.db.all(
      `SELECT l.status AS k, COUNT(*) AS n ${base} GROUP BY l.status`,
      where.params,
    )) {
      byStatus[toText(row['k'])] = Number(row['n'] ?? 0);
    }

    const aboveThreshold = Number(
      this.db.get(`SELECT COUNT(*) AS n ${base} AND l.score >= :threshold`, {
        ...where.params,
        threshold: query.minScore,
      })?.['n'] ?? 0,
    );

    return { facets: { bySource, byStatus, aboveThreshold } };
  }

  /**
   * Records a scored job.
   *
   * A re-run that finds the same job updates the score and re-points the lead at
   * the new run, but **never touches `status` or `note`** — those are the user's,
   * and silently resetting "applied" back to "new" because a nightly search saw
   * the posting again would be the worst bug in the app.
   */
  upsert(input: UpsertLeadInput, at: string, profileId: string = LOCAL_PROFILE_ID): Lead {
    this.db.run(
      `INSERT INTO leads (id, user_id, profile_id, run_id, job_id, score, breakdown,
                          status, note, created_at, updated_at)
       VALUES (:id, :userId, :profileId, :runId, :jobId, :score, :breakdown,
               'new', '', :at, :at)
       ON CONFLICT(profile_id, job_id) DO UPDATE SET
         score      = excluded.score,
         breakdown  = excluded.breakdown,
         run_id     = excluded.run_id,
         updated_at = excluded.updated_at`,
      {
        id: newId(),
        userId: LOCAL_USER_ID,
        profileId,
        runId: input.runId,
        jobId: input.jobId,
        score: input.breakdown.score,
        breakdown: input.breakdown,
        at,
      },
    );
    const row = this.db.get(`${SELECT} WHERE l.profile_id = :profileId AND l.job_id = :jobId`, {
      profileId,
      jobId: input.jobId,
    });
    return rowToLead(row!);
  }

  upsertMany(inputs: readonly UpsertLeadInput[], at: string, profileId = LOCAL_PROFILE_ID): Lead[] {
    return this.db.tx(() => inputs.map((input) => this.upsert(input, at, profileId)));
  }

  update(id: string, patch: { status?: LeadStatus; note?: string }, at: string): Lead | null {
    if (patch.status === undefined && patch.note === undefined) return this.get(id);
    this.db.run(
      `UPDATE leads SET
         status     = COALESCE(:status, status),
         note       = COALESCE(:note, note),
         updated_at = :at
       WHERE id = :id`,
      { id, status: patch.status, note: patch.note, at },
    );
    return this.get(id);
  }

  bulkUpdateStatus(ids: readonly string[], status: LeadStatus, at: string): number {
    if (ids.length === 0) return 0;
    return this.db.tx(() => {
      let changed = 0;
      for (const id of ids) {
        changed += this.db.run(
          'UPDATE leads SET status = :status, updated_at = :at WHERE id = :id',
          { id, status, at },
        ).changes;
      }
      return changed;
    });
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM leads WHERE id = :id', { id }).changes > 0;
  }

  /** Every lead of a run, newest score first — what the export and the run summary read. */
  byRun(runId: string): Lead[] {
    return this.db
      .all(`${SELECT} WHERE l.run_id = :runId ORDER BY l.score DESC`, { runId })
      .map(rowToLead);
  }

  forProfile(profileId: string = LOCAL_PROFILE_ID): Lead[] {
    return this.db.all(`${SELECT} WHERE l.profile_id = :profileId`, { profileId }).map(rowToLead);
  }

  /** Job ids already scored for this profile, so a re-run can skip re-scoring them. */
  scoredJobIds(profileId: string = LOCAL_PROFILE_ID): Set<string> {
    const rows = this.db.all('SELECT job_id FROM leads WHERE profile_id = :profileId', {
      profileId,
    });
    return new Set(rows.map((row) => toText(row['job_id'])));
  }

  counts(profileId: string = LOCAL_PROFILE_ID): {
    total: number;
    byStatus: Record<string, number>;
  } {
    const total = Number(
      this.db.get('SELECT COUNT(*) AS n FROM leads WHERE profile_id = :profileId', {
        profileId,
      })?.['n'] ?? 0,
    );
    const byStatus: Record<string, number> = {};
    for (const row of this.db.all(
      'SELECT status, COUNT(*) AS n FROM leads WHERE profile_id = :profileId GROUP BY status',
      { profileId },
    )) {
      byStatus[toText(row['status'])] = toNumberOrNull(row['n']) ?? 0;
    }
    return { total, byStatus };
  }

  /**
   * Which skills the near-miss leads asked for and did not find.
   *
   * A single lead's `missingSkills` is noise — one JD wanted Kafka. The same
   * list across every lead that landed just short of the threshold is a signal,
   * and it is the one question the leads table cannot answer by sorting.
   *
   * Three restrictions on what counts, all of them subtractive on purpose:
   *
   *  - **Dismissed leads are out.** The user has already said that posting is
   *    not of interest; counting its demands as "what is holding you back"
   *    argues from a job they rejected.
   *  - **Hard-gated and low-confidence leads are out**, matching the rule
   *    `isRerankable` already applies in `packages/matching/src/rerank.ts`. A
   *    missing-skill list extracted from a snippet mostly measures how short the
   *    snippet was, and a lead excluded for the wrong employment type says
   *    nothing about skills at all. Since low-confidence scores are capped at
   *    0.80 they would otherwise land *inside* the default near-miss window and
   *    dominate it — the least reliable rows crowding out the real ones.
   *  - **Skills are folded case-insensitively** (`LOWER`), because "Kafka" and
   *    "kafka" are one gap. `MIN` recovers a display casing deterministically,
   *    and ASCII ordering makes it prefer the capitalised form.
   *
   * The aggregate runs in SQLite over `json_each` rather than in JavaScript over
   * a full table read, for the same reason the filters do.
   */
  skillGap(query: SkillGapQuery, profileId: string = LOCAL_PROFILE_ID): SkillGap {
    // Rounded, because `0.85 - 0.15` is `0.7000000000000001` in binary floating
    // point and this value is rendered as a percentage in the UI.
    const nearMissFloor = Math.max(0, Math.round((query.threshold - query.band) * 1e4) / 1e4);
    /**
     * Bound exactly, per statement. `node:sqlite` rejects a named parameter the
     * statement does not reference, so a single shared bag would fail on the
     * count query the moment it stopped mentioning `:threshold`.
     */
    const band = { profileId, threshold: query.threshold, floor: nearMissFloor };

    /** Leads whose opinion counts. See the restrictions in the doc comment. */
    const scope = `FROM leads l
                    WHERE l.profile_id = :profileId
                      AND l.status <> 'dismissed'
                      AND json_extract(l.breakdown, '$.excludedReason') IS NULL
                      AND json_extract(l.breakdown, '$.confidence') = 'high'`;

    const totalLeads = Number(
      this.db.get(`SELECT COUNT(*) AS n ${scope}`, { profileId })?.['n'] ?? 0,
    );
    const nearMissLeads = Number(
      this.db.get(
        `SELECT COUNT(*) AS n ${scope} AND l.score >= :floor AND l.score < :threshold`,
        band,
      )?.['n'] ?? 0,
    );

    /**
     * `:path` is *bound*, not interpolated. SQLite reads a double-quoted string
     * in a JSON path position as an identifier and fails with "no such column",
     * and single-quoting it by hand would put string building back into the one
     * part of this file that has none.
     */
    const tally = (path: string, rank: string): SkillGapEntry[] =>
      this.db
        .all(
          `SELECT LOWER(s.value) AS k,
                  MIN(s.value)   AS label,
                  COUNT(*)       AS total,
                  SUM(CASE WHEN l.score >= :floor AND l.score < :threshold THEN 1 ELSE 0 END) AS near,
                  AVG(CASE WHEN l.score >= :floor AND l.score < :threshold THEN l.score END)  AS nearAvg
             FROM leads l, json_each(l.breakdown, :path) s
            WHERE l.profile_id = :profileId
              AND l.status <> 'dismissed'
              AND json_extract(l.breakdown, '$.excludedReason') IS NULL
              AND json_extract(l.breakdown, '$.confidence') = 'high'
            GROUP BY k
            ${rank}
            LIMIT :limit`,
          { ...band, path, limit: query.limit },
        )
        .map((row) => ({
          skill: toText(row['label']),
          nearMissCount: Number(row['near'] ?? 0),
          totalCount: Number(row['total'] ?? 0),
          averageScore: toNumberOrNull(row['nearAvg']) ?? 0,
        }));

    return {
      threshold: query.threshold,
      nearMissFloor,
      totalLeads,
      nearMissLeads,
      /**
       * `HAVING near > 0` unless there are no near misses at all, in which case
       * the same list ranked by overall demand is the honest thing to show
       * instead of an empty panel. Both branches are constant SQL chosen here;
       * nothing from the request reaches the statement except as a binding.
       */
      gaps: tally(
        '$.missingSkills',
        nearMissLeads > 0
          ? 'HAVING near > 0 ORDER BY near DESC, total DESC, k'
          : 'ORDER BY total DESC, k',
      ),
      /** Demand across the whole corpus — a strength is not a near-miss story. */
      strengths: tally('$.matchedSkills', 'ORDER BY total DESC, k'),
    };
  }
}
