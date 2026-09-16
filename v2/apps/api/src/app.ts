import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { z } from 'zod';
import {
  Auth,
  sessionCookie,
  Conflict,
  createSearchSchema,
  collectedJobSchema,
  sourceOutcomesSchema,
  ProfileRepository,
  ProfileRevisionConflict,
  LeadRepository,
  LeadRevisionConflict,
  type Database,
} from '@careerscope/core';

export type RateLimit = (key: string, limit: number, seconds: number) => Promise<boolean>;
const loginSchema = z
  .object({ email: z.string().email().max(254), password: z.string().min(12).max(256) })
  .strict();
const identifier = z.object({ id: z.string().uuid() });
const idempotencyKey = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
const eventCursor = z
  .string()
  .refine((value) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n);
class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    ownerId: string | null;
  }
}

export async function createApp(database: Database, origin: string, rateLimit: RateLimit) {
  const auth = new Auth(database);
  const profiles = new ProfileRepository(database);
  const leads = new LeadRepository(database);
  const streams = new Map<AbortController, string>();
  const app = Fastify({
    bodyLimit: 16_384,
    requestTimeout: 15_000,
    connectionTimeout: 10_000,
    trustProxy: false,
    disableRequestLogging: true,
    genReqId: () => randomUUID(),
    logger: {
      level: 'info',
      redact: ['req.headers.cookie', 'req.headers.authorization', 'password', 'token'],
    },
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  app.decorateRequest('ownerId', null);
  app.addHook('preClose', async () => {
    for (const controller of streams.keys()) controller.abort();
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const path = request.routeOptions.url;
    if (path === '/api/health') return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== origin) {
      throw new HttpError(403, 'Origin denied');
    }
    if (path === '/api/login') return;
    const session = await auth.session(request.cookies[sessionCookie]);
    if (path === '/api/session') return;
    if (!session) throw new HttpError(401, 'Authentication required');
    request.ownerId = session.ownerId;
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !auth.validCsrf(session.csrf, request.headers['x-csrf-token'])
    ) {
      throw new HttpError(403, 'CSRF check failed');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const frameworkStatus =
      error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const status =
      error instanceof z.ZodError
        ? 400
        : error instanceof Conflict
          ? 409
          : error instanceof HttpError
            ? error.statusCode
            : frameworkStatus === 413
              ? 413
              : frameworkStatus === 400
                ? 400
                : 500;
    if (status === 500) request.log.error({ requestId: request.id }, 'Request failed');
    const messages: Record<number, string> = {
      400: 'Invalid request',
      409:
        error instanceof ProfileRevisionConflict || error instanceof LeadRevisionConflict
          ? 'Record changed; reload before saving'
          : 'Idempotency conflict',
      413: 'Request too large',
      500: 'Service unavailable',
    };
    const fallbackMessage = messages[status] ?? 'Request failed';
    const message = error instanceof HttpError ? error.message : fallbackMessage;
    reply.code(status).send({ error: message, requestId: request.id });
  });
  app.get('/api/health', async () => {
    await database.pool.query('SELECT 1');
    return { status: 'ok', version: '2.0.0-alpha.1' };
  });
  app.get('/api/session', async (request) => {
    const session = await auth.session(request.cookies[sessionCookie]);
    return session ? { authenticated: true, csrf: session.csrf } : { authenticated: false };
  });
  app.post('/api/login', async (request, reply) => {
    const { email, password } = loginSchema.parse(request.body);
    const key = createHash('sha256').update(request.ip).digest('hex');
    if (!(await rateLimit(`login:${key}`, 10, 60))) throw new HttpError(429, 'Too many attempts');
    const token = await auth.login(email, password, request.cookies[sessionCookie]);
    if (!token) throw new HttpError(401, 'Invalid credentials');
    reply.setCookie(sessionCookie, token, {
      httpOnly: true,
      secure: new URL(origin).protocol === 'https:',
      sameSite: 'strict',
      path: '/api',
      maxAge: 8 * 3600,
    });
    return { authenticated: true };
  });
  app.post('/api/logout', async (request, reply) => {
    await auth.logout(request.cookies[sessionCookie]!);
    reply.clearCookie(sessionCookie, { path: '/api' });
    return { authenticated: false };
  });
  app.get('/api/profile', async (request) => {
    return (
      (await profiles.get(request.ownerId!)) ?? { revision: 0, profile: null, updatedAt: null }
    );
  });
  app.put('/api/profile', async (request) => {
    if (!(await rateLimit(`profile:${request.ownerId!}`, 30, 60)))
      throw new HttpError(429, 'Too many profile updates');
    return profiles.save(request.ownerId!, request.body);
  });
  app.get('/api/leads', async (request) => leads.list(request.ownerId!, request.query));
  app.post('/api/leads', async (request) => {
    if (!(await rateLimit(`leads:${request.ownerId!}`, 60, 60)))
      throw new HttpError(429, 'Too many lead updates');
    const lead = await leads.save(request.ownerId!, request.body);
    if (!lead) throw new HttpError(404, 'Completed job not found');
    return lead;
  });
  app.get('/api/leads/:id', async (request) => {
    const { id } = identifier.parse(request.params);
    const lead = await leads.get(request.ownerId!, id);
    if (!lead) throw new HttpError(404, 'Lead not found');
    return lead;
  });
  app.get('/api/leads/:id/history', async (request) => {
    const { id } = identifier.parse(request.params);
    const history = await leads.history(request.ownerId!, id, request.query);
    if (!history) throw new HttpError(404, 'Lead not found');
    return history;
  });
  app.put('/api/leads/:id', async (request) => {
    const { id } = identifier.parse(request.params);
    if (!(await rateLimit(`leads:${request.ownerId!}`, 60, 60)))
      throw new HttpError(429, 'Too many lead updates');
    const lead = await leads.update(request.ownerId!, id, request.body);
    if (!lead) throw new HttpError(404, 'Lead not found');
    return lead;
  });
  app.post('/api/searches', async (request, reply) => {
    if (!(await rateLimit(`search:${request.ownerId!}`, 10, 60)))
      throw new HttpError(429, 'Too many searches');
    const search = await database.createSearch(
      request.ownerId!,
      idempotencyKey.parse(request.headers['idempotency-key']),
      createSearchSchema.parse(request.body),
    );
    return reply.code(202).send({ runId: search.id, status: search.status });
  });
  app.get('/api/searches', async (request) => {
    const result = await database.pool.query(
      `SELECT id, request, status, created_at AS "createdAt"
      FROM search_runs WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
      [request.ownerId],
    );
    return { items: result.rows };
  });
  app.post('/api/searches/:id/cancel', async (request) => {
    const { id } = identifier.parse(request.params);
    if (!(await rateLimit(`cancel:${request.ownerId!}`, 30, 60)))
      throw new HttpError(429, 'Too many cancellations');
    const search = await database.cancelSearch(request.ownerId!, id);
    if (!search) throw new HttpError(404, 'Search not found');
    return { runId: search.id, status: search.status };
  });
  app.get('/api/searches/:id/export', async (request, reply) => {
    const { id } = identifier.parse(request.params);
    if (!(await rateLimit(`export:${request.ownerId!}`, 30, 60)))
      throw new HttpError(429, 'Too many exports');
    const search = await database.getSearch(request.ownerId!, id);
    if (!search) throw new HttpError(404, 'Search not found');
    if (!['completed', 'partial'].includes(search.status))
      throw new HttpError(409, 'Search is not complete');
    const jobs = await database.pool.query(
      `SELECT data FROM search_jobs WHERE owner_id = $1 AND run_id = $2
       ORDER BY (data->'match'->>'score')::double precision DESC NULLS LAST, id LIMIT 100`,
      [request.ownerId, id],
    );
    return reply
      .header('Content-Disposition', `attachment; filename="careerscope-search-${id}.json"`)
      .type('application/json; charset=utf-8')
      .send({
        schemaVersion: 1,
        runId: id,
        status: search.status,
        sourceOutcomes: search.sourceOutcomes
          ? sourceOutcomesSchema.parse(search.sourceOutcomes)
          : null,
        request: createSearchSchema.parse(search.request),
        jobs: jobs.rows.map((row) => collectedJobSchema.strip().parse(row.data)),
      });
  });
  app.get('/api/searches/:id/events', async (request, reply) => {
    const { id } = identifier.parse(request.params);
    const query = z.object({ after: eventCursor.optional() }).strict().parse(request.query);
    let cursor = eventCursor.parse(request.headers['last-event-id'] ?? query.after ?? '0');
    const ownerId = request.ownerId!;
    if (!(await database.getSearch(ownerId, id))) throw new HttpError(404, 'Search not found');
    if (cursor !== '0') {
      const known = await database.pool.query(
        'SELECT sequence FROM run_events WHERE owner_id = $1 AND run_id = $2 AND sequence = $3::bigint',
        [ownerId, id, cursor],
      );
      if (!known.rowCount) throw new HttpError(400, 'Invalid event cursor');
    }
    if (!(await rateLimit(`events:${ownerId}`, 30, 60)))
      throw new HttpError(429, 'Too many event streams');
    if (
      streams.size >= 32 ||
      [...streams.values()].filter((owner) => owner === ownerId).length >= 2
    )
      throw new HttpError(429, 'Too many event streams');
    const controller = new AbortController();
    streams.set(controller, ownerId);
    const timer = setTimeout(() => controller.abort(), 25_000);
    const close = () => controller.abort();
    const cleanup = () => {
      controller.abort();
      clearTimeout(timer);
      streams.delete(controller);
      reply.raw.off('close', close);
    };
    reply.raw.once('close', close);
    const body = Readable.from(
      (async function* () {
        try {
          yield 'retry: 2000\n\n';
          while (!controller.signal.aborted) {
            const session = await auth.session(request.cookies[sessionCookie]);
            if (!session || session.ownerId !== ownerId) {
              yield 'event: session-expired\ndata: {}\n\n';
              break;
            }
            const events = await database.pool.query<{
              cursor: string;
              type: string;
              createdAt: Date;
            }>(
              `SELECT sequence::text AS cursor, type, created_at AS "createdAt" FROM run_events
             WHERE owner_id = $1 AND run_id = $2 AND sequence > $3::bigint ORDER BY sequence LIMIT 50`,
              [ownerId, id, cursor],
            );
            controller.signal.throwIfAborted();
            for (const event of events.rows) {
              cursor = event.cursor;
              yield `id: ${cursor}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`;
              if (
                ['SearchCompleted', 'SearchPartial', 'SearchFailed', 'SearchCancelled'].includes(
                  event.type,
                )
              ) {
                yield 'event: settled\ndata: {}\n\n';
                return;
              }
            }
            if (events.rows.length === 50) continue;
            const search = await database.getSearch(ownerId, id);
            if (!search) break;
            if (
              ['completed', 'partial', 'failed', 'cancelled'].includes(search.status) &&
              !events.rows.length
            ) {
              const pending = await database.pool.query(
                'SELECT sequence FROM run_events WHERE owner_id = $1 AND run_id = $2 AND sequence > $3::bigint LIMIT 1',
                [ownerId, id, cursor],
              );
              if (pending.rowCount) continue;
              yield 'event: settled\ndata: {}\n\n';
              break;
            }
            yield ': heartbeat\n\n';
            await delay(1000, undefined, { signal: controller.signal });
          }
        } catch {
          if (!controller.signal.aborted) {
            request.log.error({ requestId: request.id }, 'Event stream failed');
            yield 'event: unavailable\ndata: {}\n\n';
          }
        } finally {
          cleanup();
        }
      })(),
    );
    body.once('close', cleanup);
    return reply
      .type('text/event-stream')
      .header('Cache-Control', 'no-store, no-transform')
      .header('X-Accel-Buffering', 'no')
      .send(body);
  });
  app.get('/api/searches/:id', async (request) => {
    const { id } = identifier.parse(request.params);
    const search = await database.getSearch(request.ownerId!, id);
    if (!search) throw new HttpError(404, 'Search not found');
    const jobs = await database.pool.query(
      `SELECT id, data FROM search_jobs WHERE owner_id = $1 AND run_id = $2
       ORDER BY (data->'match'->>'score')::double precision DESC NULLS LAST, id LIMIT 100`,
      [request.ownerId, id],
    );
    const events = await database.pool.query(
      `SELECT sequence::text AS cursor, type, created_at AS "createdAt"
      FROM run_events WHERE owner_id = $1 AND run_id = $2 ORDER BY sequence LIMIT 100`,
      [request.ownerId, id],
    );
    return {
      runId: id,
      status: search.status,
      request: search.request,
      profileRevision: search.profileRevision,
      sourceOutcomes: search.sourceOutcomes
        ? sourceOutcomesSchema.parse(search.sourceOutcomes)
        : null,
      jobs: jobs.rows,
      events: events.rows,
    };
  });
  return app;
}
