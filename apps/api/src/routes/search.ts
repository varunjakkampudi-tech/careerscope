/**
 * Starting a search.
 *
 * `POST /api/search` returns **202 with a run id**, not results. A run takes
 * minutes — a dozen boards, a company-enrichment pass, then scoring — and no
 * amount of tuning makes that fit inside an HTTP request. The client posts here,
 * then follows `GET /api/runs/:id/events`.
 *
 * Two refusals are worth naming, because both are cheaper here than as a
 * confusing empty result twenty minutes later:
 *
 *  - **No profile, no run.** Without a resume and preferences there is nothing
 *    to score against; the run would complete successfully and match nothing.
 *  - **One run at a time.** A second concurrent run over the same profile
 *    competes for the same rate-limited boards and writes to the same leads. The
 *    409 names the run already in flight so the UI can offer to watch it.
 */

import { searchRequestSchema } from '@job-radar/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ApiProblem, parseOrThrow } from '../errors.js';
import { SETTING } from '../db/repo/index.js';
import { now } from '../util/time.js';
import type { RouteOptions } from './index.js';
import {
  dailySearchTimeSchema,
  type DailySearchTime,
  type ScheduledAttempt,
} from '../services/scheduler.js';

export async function searchRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { repos, queue, providers, env } = options.container;

  app.get('/search/schedule', async () => ({
    intervalMinutes: repos.settings.getJson(
      SETTING.searchIntervalMinutes,
      env.SEARCH_INTERVAL_MINUTES,
    ),
    lastScheduledAt: repos.settings.get(SETTING.lastScheduledAt),
    dailyAt: repos.settings.getJson<DailySearchTime | null>(SETTING.searchDailyAt, null),
    lastAttempt: repos.settings.getJson<ScheduledAttempt | null>(
      SETTING.lastScheduledAttempt,
      null,
    ),
  }));

  app.put('/search/schedule', async (request) => {
    const body = parseOrThrow(
      z
        .object({
          intervalMinutes: z.union([z.literal(0), z.literal(1440)]),
          dailyAt: dailySearchTimeSchema.nullable().optional(),
        })
        .strict(),
      request.body,
      'search schedule',
    );
    repos.db.tx(() => {
      repos.settings.setJson(SETTING.searchIntervalMinutes, body.intervalMinutes, now());
      if (body.dailyAt !== undefined)
        repos.settings.setJson(SETTING.searchDailyAt, body.dailyAt, now());
    });
    return body;
  });

  app.post('/search', async (request, reply) => {
    const body = parseOrThrow(searchRequestSchema, request.body, 'search request');

    const profile = repos.profiles.get();
    if (!profile) {
      throw new ApiProblem(
        409,
        'profile_missing',
        'Add your profile before searching — there is nothing to match against yet',
      );
    }

    const active = repos.runs.active();
    if (active) {
      throw new ApiProblem(409, 'run_in_progress', `Run ${active.id} is already ${active.status}`, {
        runId: active.id,
        status: active.status,
      });
    }

    // Every source the caller asked for that this install cannot actually run.
    // Refusing the whole request is deliberate: silently dropping one would let
    // the user believe LinkedIn was searched when it never was.
    const unusable = providers.filter(
      (provider) => body.sources.includes(provider.id) && provider.unavailableReason !== null,
    );
    if (unusable.length > 0) {
      throw ApiProblem.unprocessable(
        'Some of the selected sources are not available',
        unusable.map((provider) => ({
          source: provider.id,
          // Already written for a person, and never contains a key value — only
          // the *name* of the variable that is missing. See `env.ts`.
          reason: provider.unavailableReason,
        })),
      );
    }

    const unknown = body.sources.filter((id) => !providers.some((provider) => provider.id === id));
    if (unknown.length > 0) {
      throw ApiProblem.unprocessable('Unknown sources', { sources: unknown });
    }

    if (body.useLlmRerank && !env.ENABLE_LLM_RERANK) {
      throw ApiProblem.unprocessable(
        'Semantic rerank is switched off on this server. The run will still score every lead with the deterministic engine.',
      );
    }

    const at = now();
    const run = repos.runs.create(body, at);
    // Stored so the search form reopens on the settings the user last chose,
    // which for a slider defaulting to 85% is most of the value of the screen.
    repos.settings.setJson(SETTING.lastSearchRequest, body, at);

    queue.enqueue(run.id);

    return reply
      .status(202)
      .header('location', `/api/runs/${run.id}`)
      .send({ run, events: `/api/runs/${run.id}/events` });
  });

  /** The last request, for prefilling the form. Null before the first search. */
  app.get('/search/last', async () => ({
    request: repos.settings.getJson(SETTING.lastSearchRequest, null),
  }));
}
