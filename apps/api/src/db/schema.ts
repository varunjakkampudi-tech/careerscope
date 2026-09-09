/**
 * The schema, as one idempotent DDL script.
 *
 * SQLite is the right database for this app: one user, one box, a few hundred
 * thousand rows at the very most, and a backup that is `cp data/job-radar.db`.
 * Every table is written so the same statements can run on every boot — there is
 * no migration runner because there is nothing yet to migrate *from*. When the
 * first schema change lands, `user_version` below is what tells us which shape
 * we are looking at.
 *
 * Two conventions worth knowing before reading further:
 *
 *  - **JSON columns hold the exact shape `packages/shared` defines.** `salary`,
 *    `breakdown`, `stats` and friends are stored as the serialised Zod type and
 *    re-parsed on the way out. Splitting them into columns would duplicate the
 *    schema in a second place and guarantee the two drift.
 *  - **Anything sorted or filtered gets a real column**, even when it is also
 *    inside a JSON blob. `leads.score` and `jobs.salary_annual_max` are the two
 *    cases: an index on a `json_extract` expression works, but a plain column is
 *    obvious to the next reader and free to maintain.
 *
 * `user_id` is present on every user-scoped table even though the app is
 * single-user. It costs one column now and turns multi-user from a rewrite into
 * a migration later.
 */

/** Bumped whenever the DDL below changes shape. */
export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS profiles (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL DEFAULT 'local',
  candidate    TEXT NOT NULL,
  preferences  TEXT NOT NULL,
  application  TEXT NOT NULL,
  resume_id    TEXT REFERENCES resumes(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resumes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL DEFAULT 'local',
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  -- Stored under a generated UUID, never the uploaded filename: an attacker
  -- controls that string and "../../etc/passwd" is a valid one.
  storage_path  TEXT NOT NULL,
  -- Extracted text, kept so a re-parse never needs the original file and the
  -- LLM rerank has something to send.
  text          TEXT NOT NULL,
  text_length   INTEGER NOT NULL,
  derived       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  -- The normalised slug, so "Acme Corp." and "acme corp" are one company. It is
  -- the primary key rather than a separate column because \`normalizeJob\` already
  -- derives exactly this value for \`job.company.id\` — a second id would mean a
  -- lookup on every insert to discover something we were handed.
  id                  TEXT PRIMARY KEY,
  -- Display name, kept as the source wrote it.
  name                TEXT NOT NULL,
  website             TEXT,
  careers_url         TEXT,
  ats_type            TEXT,
  ats_portal_url      TEXT,
  -- Only ever an address published by the employer. Never constructed; see
  -- services/companyResolver.ts.
  careers_email       TEXT,
  email_confidence    TEXT NOT NULL DEFAULT 'unverified',
  website_confidence  TEXT NOT NULL DEFAULT 'unverified',
  linkedin_url        TEXT,
  note                TEXT,
  -- Null until enrichment has looked at this company at all, which is what
  -- stops it re-resolving the same employer on every run.
  resolved_at         TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id                    TEXT PRIMARY KEY,
  -- Hash of normalised title+company+location. UNIQUE is the dedupe: the same
  -- posting found on Greenhouse and on Adzuna collapses to one row.
  fingerprint           TEXT NOT NULL UNIQUE,
  source                TEXT NOT NULL,
  source_job_id         TEXT NOT NULL,
  title                 TEXT NOT NULL,
  company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location              TEXT NOT NULL DEFAULT '',
  is_remote             INTEGER NOT NULL DEFAULT 0,
  employment_type       TEXT,
  salary                TEXT NOT NULL,
  salary_annual_min     INTEGER,
  salary_annual_max     INTEGER,
  posted_at             TEXT,
  description_text      TEXT NOT NULL DEFAULT '',
  has_full_description  INTEGER NOT NULL DEFAULT 1,
  tech_stack            TEXT NOT NULL DEFAULT '[]',
  required_years        TEXT NOT NULL DEFAULT '{"min":null,"max":null}',
  apply_url             TEXT NOT NULL,
  source_url            TEXT NOT NULL,
  -- "via LinkedIn" when an aggregator names the origin board. Null elsewhere,
  -- because every other source is itself the origin.
  source_publisher      TEXT,
  first_seen_at         TEXT NOT NULL,
  last_seen_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_runs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL DEFAULT 'local',
  profile_id   TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  request      TEXT NOT NULL,
  stage        TEXT NOT NULL DEFAULT 'queued',
  progress     REAL NOT NULL DEFAULT 0,
  stats        TEXT NOT NULL,
  error        TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  created_at   TEXT NOT NULL
);

-- The run's audit trail, and what a client that connects late replays to catch
-- up. \`seq\` is per-run and monotonic so SSE's Last-Event-ID resume works.
CREATE TABLE IF NOT EXISTS run_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES search_runs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE TABLE IF NOT EXISTS leads (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL DEFAULT 'local',
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Null once the run is deleted; the lead itself outlives the search that
  -- found it.
  run_id      TEXT REFERENCES search_runs(id) ON DELETE SET NULL,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  score       REAL NOT NULL,
  breakdown   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new',
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  -- One lead per job per profile. A later run re-scoring the same job updates
  -- this row rather than stacking duplicates in the UI.
  UNIQUE (profile_id, job_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_company     ON jobs (company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_posted      ON jobs (posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_source      ON jobs (source);
CREATE INDEX IF NOT EXISTS idx_jobs_last_seen   ON jobs (last_seen_at DESC);

-- Company name search from the leads filter rail. NOCASE so "acme" finds "Acme".
CREATE INDEX IF NOT EXISTS idx_companies_name   ON companies (name COLLATE NOCASE);

-- The leads screen's default view: one profile, highest score first.
CREATE INDEX IF NOT EXISTS idx_leads_profile    ON leads (profile_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status     ON leads (profile_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_run        ON leads (run_id);
CREATE INDEX IF NOT EXISTS idx_leads_job        ON leads (job_id);

CREATE INDEX IF NOT EXISTS idx_runs_created     ON search_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_events_run   ON run_events (run_id, seq);

CREATE TABLE IF NOT EXISTS application_runs (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_application_active
  ON application_runs ((1)) WHERE status IN ('running', 'needs_input', 'ready', 'submitting');
CREATE INDEX IF NOT EXISTS idx_application_lead ON application_runs (lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_signing_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`;
