/**
 * The repository set, constructed once and passed around as one object.
 *
 * Routes and services take `Repos` rather than a `Db`, so nothing above this
 * layer writes SQL. That is the boundary that makes the "no compile-time SQL
 * checking" trade in `../index.ts` acceptable: every statement in the app is in
 * one directory, and every row read here goes through a Zod parse on the way
 * out, so a column rename fails in tests rather than in production.
 */

import type { Db } from '../index.js';
import { CompanyRepo } from './companies.js';
import { JobRepo } from './jobs.js';
import { LeadRepo } from './leads.js';
import { ProfileRepo } from './profiles.js';
import { ResumeRepo } from './resumes.js';
import { RunRepo } from './runs.js';
import { SettingsRepo } from './settings.js';
import { AuthRepo } from './auth.js';

export interface Repos {
  db: Db;
  settings: SettingsRepo;
  auth: AuthRepo;
  profiles: ProfileRepo;
  resumes: ResumeRepo;
  companies: CompanyRepo;
  jobs: JobRepo;
  leads: LeadRepo;
  runs: RunRepo;
}

export function createRepos(db: Db, dataDir: string): Repos {
  return {
    db,
    settings: new SettingsRepo(db),
    auth: new AuthRepo(db),
    profiles: new ProfileRepo(db),
    resumes: new ResumeRepo(db, dataDir),
    companies: new CompanyRepo(db),
    jobs: new JobRepo(db),
    leads: new LeadRepo(db),
    runs: new RunRepo(db),
  };
}

export { CompanyRepo, JobRepo, LeadRepo, ProfileRepo, ResumeRepo, RunRepo, SettingsRepo };
export { SETTING } from './settings.js';
export { emptyStats, type StoredEvent } from './runs.js';
export { parseSeedFile, type SeedCompany } from './companies.js';
export type { UpsertLeadInput } from './leads.js';
export type { StoreResumeInput } from './resumes.js';
