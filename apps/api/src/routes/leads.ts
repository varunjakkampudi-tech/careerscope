/**
 * Leads — the main screen's data.
 *
 * Filtering, sorting and pagination all happen in SQL (`leadQuerySchema` →
 * `LeadRepo.page`), not in the handler. With a few thousand leads the difference
 * between `LIMIT 50` and loading everything to slice it in JavaScript is the
 * difference between a table that opens instantly and one that stalls the tab.
 *
 * The one judgement call here is `minScore`. `leadQuerySchema` defaults it to
 * **0**, not to the 85% threshold, and that is on purpose: a run stores every
 * lead it scored, and the filter rail owns the threshold. Defaulting the API to
 * 85% would mean a user who drags the slider down to 60% is asking for rows the
 * endpoint has already decided not to mention.
 */

import {
  leadBulkUpdateSchema,
  leadQuerySchema,
  leadUpdateSchema,
  skillGapQuerySchema,
} from '@job-radar/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { buildCandidateContext, scoreJob } from '@job-radar/matching';
import { normalizeJob } from '@job-radar/providers';
import { ApiProblem, parseOrThrow } from '../errors.js';
import { now } from '../util/time.js';
import type { RouteOptions } from './index.js';

const webUrl = z
  .string()
  .url()
  .max(4000)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  }, 'Use an HTTPS URL without credentials');

const browserImportSchema = z
  .object({
    jobs: z
      .array(
        z
          .object({
            source: z.enum(['indeed', 'naukri', 'linkedin', 'gmail']),
            sourceJobId: z.string().trim().min(1).max(200),
            title: z.string().trim().min(1).max(300),
            companyName: z.string().trim().min(1).max(200),
            location: z.string().max(300).optional(),
            description: z.string().max(60_000),
            hasFullDescription: z.boolean().default(false),
            employmentType: z
              .enum(['fulltime', 'parttime', 'contract', 'internship', 'temporary'])
              .optional(),
            salaryRaw: z.string().max(300).optional(),
            postedAt: z.string().datetime().optional(),
            sourceUrl: webUrl,
            applyUrl: webUrl.optional(),
            companyWebsite: webUrl.optional(),
            companyCareersUrl: webUrl.optional(),
            sourcePublisher: z.string().max(100).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export async function leadsRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { repos } = options.container;

  app.post('/leads/import', async (request, reply) => {
    const body = parseOrThrow(browserImportSchema, request.body, 'browser job import');
    const profile = repos.profiles.get();
    if (!profile)
      throw new ApiProblem(409, 'profile_missing', 'Save your profile before importing jobs');
    const resume = profile.resumeId ? repos.resumes.get(profile.resumeId) : null;
    const candidate = buildCandidateContext(
      { ...profile, derived: resume?.derived ?? null },
      profile.resumeId ? (repos.resumes.text(profile.resumeId) ?? '') : '',
    );
    const at = now();
    const imported = repos.db.tx(() =>
      body.jobs.map((raw) => {
        const job = normalizeJob({ ...raw, descriptionIsHtml: false });
        repos.companies.upsertFromJob(job, at);
        const stored = repos.jobs.upsert(job, at);
        const breakdown = scoreJob(stored, candidate, { windowDays: 30 });
        if (breakdown.excludedReason)
          return {
            title: stored.title,
            score: breakdown.score,
            excludedReason: breakdown.excludedReason,
          };
        const lead = repos.leads.upsert({ jobId: stored.id, runId: null, breakdown }, at);
        return {
          id: lead.id,
          title: stored.title,
          company: stored.company.name,
          score: breakdown.score,
        };
      }),
    );
    return reply
      .status(201)
      .send({ imported, above85: imported.filter((lead) => lead.score > 0.85).length });
  });

  app.get('/leads', async (request) => {
    const query = parseOrThrow(leadQuerySchema, request.query, 'lead filter');
    return repos.leads.page(query);
  });

  /** Status counts for the summary strip, unfiltered. */
  app.get('/leads/counts', async () => repos.leads.counts());

  /**
   * What the near-miss leads keep asking for.
   *
   * Registered above `/leads/:id`, like `/leads/counts` — Fastify prefers a
   * static segment over a parameter regardless of order, but keeping the two
   * together makes the collection-level routes obvious to the next reader.
   */
  app.get('/leads/skill-gap', async (request) => {
    const query = parseOrThrow(skillGapQuerySchema, request.query, 'skill gap query');
    return repos.leads.skillGap(query);
  });

  app.get('/leads/:id', async (request) => {
    const id = idOf(request);
    const lead = repos.leads.get(id);
    if (!lead) throw ApiProblem.notFound('Lead', id);

    // The drawer shows the company's enriched fields — website, portal, careers
    // email — which live on the company row rather than being copied onto every
    // lead. Fetched here so the drawer opens in one request.
    const company = repos.companies.get(lead.job.company.id);
    return { lead, company };
  });

  app.patch('/leads/:id', async (request) => {
    const id = idOf(request);
    const patch = parseOrThrow(leadUpdateSchema, request.body, 'lead update');

    const updated = repos.leads.update(id, patch, now());
    if (!updated) throw ApiProblem.notFound('Lead', id);
    return { lead: updated };
  });

  /**
   * Bulk status change.
   *
   * Capped at 500 ids by the schema. Marking a filtered page of leads
   * "dismissed" is the common case and it has to be one request — 500 PATCHes
   * would trip the rate limiter and leave the table half-updated if any failed.
   */
  app.post('/leads/bulk', async (request) => {
    const body = parseOrThrow(leadBulkUpdateSchema, request.body, 'bulk update');
    const updated = repos.leads.bulkUpdateStatus(body.ids, body.status, now());
    return { updated, requested: body.ids.length };
  });

  app.delete('/leads/:id', async (request, reply) => {
    const id = idOf(request);
    if (!repos.leads.delete(id)) throw ApiProblem.notFound('Lead', id);
    return reply.status(204).send();
  });
}

function idOf(request: FastifyRequest): string {
  return (request.params as { id: string }).id;
}
