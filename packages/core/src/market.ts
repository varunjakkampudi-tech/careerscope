import type { Pool } from 'pg';

// The product argument for this file.
//
// A job board is paid by the employer, so it will never tell you that a role has
// been open for four months, that you have seen it in six consecutive searches,
// or that the company quietly refreshed the date to make it look new. None of
// that requires inference or a model -- it falls out of recording what was
// actually seen, run after run.
//
// Every value returned here is an observation. The word "ghost" does not appear
// in a response: signals are stated as facts and the reader draws the
// conclusion. Calling a real job fake is a worse failure than staying quiet.

export type MarketSignal =
  'reposted' | 'long_open' | 'persistent' | 'recently_posted' | 'first_sighting';

export interface PostingEvidence {
  fingerprint: string;
  title: string;
  company: string;
  sightings: number;
  repostCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  firstPostedAt: string | null;
  daysOpen: number | null;
  daysTracked: number;
  signals: MarketSignal[];
}

// Thresholds are named rather than inlined so the meaning is reviewable. They
// are judgement calls, not measurements, and they are the first thing that
// should be challenged with real data.
const longOpenDays = 45;
const persistentSightings = 4;
const persistentSpanDays = 21;
const recentlyPostedDays = 7;

function classify(row: {
  sightings: number;
  repostCount: number;
  daysOpen: number | null;
  daysTracked: number;
}): MarketSignal[] {
  const signals: MarketSignal[] = [];
  if (row.repostCount > 0) signals.push('reposted');
  if (row.daysOpen !== null && row.daysOpen >= longOpenDays) signals.push('long_open');
  if (row.sightings >= persistentSightings && row.daysTracked >= persistentSpanDays) {
    signals.push('persistent');
  }
  if (row.daysOpen !== null && row.daysOpen <= recentlyPostedDays) signals.push('recently_posted');
  if (row.sightings === 1) signals.push('first_sighting');
  return signals;
}

const maximumPageSize = 200;

function bounded(requested: unknown, fallback = 50) {
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), maximumPageSize);
}

export class MarketRepository {
  constructor(private readonly pool: Pool) {}

  private static readonly projection = `
    fingerprint, title, company, sightings, repost_count AS "repostCount",
    first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt",
    first_posted_at AS "firstPostedAt",
    CASE WHEN first_posted_at IS NULL THEN NULL
         ELSE floor(extract(epoch FROM now() - first_posted_at) / 86400)::int END AS "daysOpen",
    floor(extract(epoch FROM last_seen_at - first_seen_at) / 86400)::int AS "daysTracked"`;

  async posting(ownerId: string, fingerprint: string): Promise<PostingEvidence | null> {
    const { rows } = await this.pool.query(
      `SELECT ${MarketRepository.projection} FROM job_sightings
       WHERE owner_id = $1 AND fingerprint = $2`,
      [ownerId, fingerprint],
    );
    const row = rows[0];
    return row ? { ...row, signals: classify(row) } : null;
  }

  // Ordered by how long the role has been open, because that is the question a
  // candidate is actually asking: am I wasting my time on this one?
  async stalePostings(ownerId: string, options: { limit?: unknown } = {}) {
    const { rows } = await this.pool.query(
      `SELECT ${MarketRepository.projection} FROM job_sightings
       WHERE owner_id = $1
         AND (repost_count > 0
              OR (first_posted_at IS NOT NULL AND first_posted_at < now() - ($2 || ' days')::interval)
              OR (sightings >= $3 AND last_seen_at - first_seen_at >= ($4 || ' days')::interval))
       ORDER BY first_posted_at ASC NULLS LAST, sightings DESC
       LIMIT $5`,
      [ownerId, longOpenDays, persistentSightings, persistentSpanDays, bounded(options.limit)],
    );
    return rows.map((row) => ({ ...row, signals: classify(row) }));
  }

  // Which companies keep the same roles open longest. Useful before spending an
  // evening on a cover letter.
  async companies(ownerId: string, options: { limit?: unknown } = {}) {
    const { rows } = await this.pool.query(
      `SELECT company,
              count(*)::int AS postings,
              sum(repost_count)::int AS reposts,
              max(sightings)::int AS "mostSightings",
              floor(avg(CASE WHEN first_posted_at IS NULL THEN NULL
                        ELSE extract(epoch FROM now() - first_posted_at) / 86400 END))::int
                AS "averageDaysOpen",
              max(last_seen_at) AS "lastSeenAt"
       FROM job_sightings WHERE owner_id = $1
       GROUP BY company
       HAVING count(*) > 1
       ORDER BY sum(repost_count) DESC, count(*) DESC
       LIMIT $2`,
      [ownerId, bounded(options.limit, 25)],
    );
    return rows;
  }

  // A pipeline view that answers "what have I stopped touching", which is the
  // failure mode of every job search: applications quietly going cold.
  async pipeline(ownerId: string) {
    const { rows } = await this.pool.query(
      `SELECT status,
              count(*)::int AS count,
              floor(extract(epoch FROM now() - min(status_changed_at)) / 86400)::int AS "oldestDays",
              count(*) FILTER (
                WHERE status_changed_at < now() - interval '21 days'
              )::int AS "stalled"
       FROM saved_leads WHERE owner_id = $1
       GROUP BY status ORDER BY status`,
      [ownerId],
    );
    const active = rows.filter((row) => !['archived', 'rejected'].includes(row.status));
    return {
      stages: rows,
      // Deliberately excludes archived and rejected: those are finished, not
      // neglected, and counting them as stalled would train the owner to ignore
      // the number.
      stalledActive: active.reduce((total, row) => total + row.stalled, 0),
    };
  }

  async stalled(ownerId: string, options: { days?: unknown; limit?: unknown } = {}) {
    const days = Math.min(Math.max(Number(options.days) || 21, 1), 365);
    const { rows } = await this.pool.query(
      `SELECT id, fingerprint, status, notes <> '' AS "hasNotes",
              status_changed_at AS "statusChangedAt",
              floor(extract(epoch FROM now() - status_changed_at) / 86400)::int AS "daysSinceChange",
              data ->> 'title' AS title, data ->> 'company' AS company
       FROM saved_leads
       WHERE owner_id = $1
         AND status NOT IN ('archived', 'rejected')
         AND status_changed_at < now() - ($2 || ' days')::interval
       ORDER BY status_changed_at ASC
       LIMIT $3`,
      [ownerId, days, bounded(options.limit)],
    );
    return rows;
  }
}
