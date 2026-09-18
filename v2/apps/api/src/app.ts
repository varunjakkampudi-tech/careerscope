import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify, { LogController } from 'fastify';
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
  prepareProfile,
  LeadRepository,
  LeadRevisionConflict,
  ResumeUploadRepository,
  ResumeUploadCoordinator,
  InvalidResumeUpload,
  ResumeStorageLimit,
  maximumResumeBytes,
  AuditLog,
  Diagnostics,
  AdminRepository,
  TraceRepository,
  DebugSessions,
  type ErrorCode,
  type UploadStorage,
  type Database,
} from '@careerscope/core';

export type RateLimit = (key: string, limit: number, seconds: number) => Promise<boolean>;

// Read rather than hardcode: the literal that used to live here was still
// reporting 2.0.0-alpha.1 after the package had moved on.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
const loginSchema = z
  .object({ email: z.string().trim().email().max(254), password: z.string().min(12).max(256) })
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
    readonly code: ErrorCode = 'internal_error',
  ) {
    super(message);
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    ownerId: string | null;
    isAdmin: boolean;
  }
}

export async function createApp(
  database: Database,
  origin: string,
  rateLimit: RateLimit,
  options: {
    registrationEnabled?: boolean;
    resumeStorage?: UploadStorage & {
      cancelUpload?: (
        object: import('@careerscope/core').ResumeObject,
        signal?: AbortSignal,
      ) => Promise<void>;
      delete: (
        object: import('@careerscope/core').ResumeObject,
        version: string,
        signal?: AbortSignal,
      ) => Promise<void>;
    };
  } = {},
) {
  const auth = new Auth(database);
  const audit = new AuditLog(database.pool);
  const diagnostics = new Diagnostics(database.pool);
  const admin = new AdminRepository(database.pool);
  const traces = new TraceRepository(database.pool);
  const debugSessions = new DebugSessions(database.pool);

  // Security events are written best-effort and must never fail the request
  // that produced them; a rejected login that cannot be recorded is still a
  // rejected login.
  const security = (
    action: string,
    actorId: string | null,
    requestId: string,
    detail?: Record<string, string | number | boolean | null>,
  ) => {
    if (!actorId) return;
    void audit
      .record({ actorId, action, outcome: 'denied', requestId, detail })
      .catch(() => undefined);
  };
  const profiles = new ProfileRepository(database);
  const leads = new LeadRepository(database);
  const uploads = new ResumeUploadRepository(database);
  const coordinator = options.resumeStorage
    ? new ResumeUploadCoordinator(uploads, options.resumeStorage)
    : undefined;
  const streams = new Map<AbortController, string>();
  const app = Fastify({
    bodyLimit: 16_384,
    requestTimeout: 15_000,
    connectionTimeout: 10_000,
    trustProxy: false,
    logController: new LogController({ disableRequestLogging: true }),
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
  app.decorateRequest('isAdmin', false);
  app.addHook('preClose', async () => {
    for (const controller of streams.keys()) controller.abort();
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const path = request.routeOptions.url;
    if (path === '/api/health') return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== origin) {
      throw new HttpError(403, 'Origin denied', 'origin_denied');
    }
    if (path === '/api/login' || path === '/api/register') return;
    const session = await auth.session(request.cookies[sessionCookie]);
    if (path === '/api/session') return;
    if (!session) throw new HttpError(401, 'Authentication required', 'authentication_required');
    request.ownerId = session.ownerId;
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !auth.validCsrf(session.csrf, request.headers['x-csrf-token'])
    ) {
      security('security.csrf.rejected', session.ownerId, request.id, {
        route: path ?? 'unmatched',
      });
      throw new HttpError(403, 'CSRF check failed', 'csrf_failed');
    }
    // Admin status is read from the database against the session's own owner id.
    // Nothing in the request can influence it, and it is resolved before any
    // admin route body runs rather than inside each handler.
    if (path?.startsWith('/api/admin')) {
      const { rows } = await database.pool.query<{ isAdmin: boolean }>(
        'SELECT is_admin AS "isAdmin" FROM users WHERE id = $1',
        [session.ownerId],
      );
      request.isAdmin = rows[0]?.isAdmin === true;
      if (!request.isAdmin) {
        await audit.record({
          actorId: session.ownerId,
          action: 'security.admin.denied',
          outcome: 'denied',
          requestId: request.id,
          detail: { route: path ?? 'unmatched' },
        });
        throw new HttpError(403, 'Administrator access required', 'forbidden');
      }
      if (!(await rateLimit(`admin:${session.ownerId}`, 120, 60))) {
        security('security.rate_limited', session.ownerId, request.id, {
          route: path ?? 'unmatched',
        });
        throw new HttpError(429, 'Too many requests', 'rate_limited');
      }
    }
  });
  // Correlation without private data: route templates only, never URLs or bodies.
  app.addHook('onResponse', async (request, reply) => {
    if (request.routeOptions.url === '/api/health') return;
    const record = {
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
      authenticated: request.ownerId !== null,
    };
    if (reply.statusCode >= 500) app.log.error(record, 'Request failed');
    else if (reply.statusCode >= 400) app.log.warn(record, 'Request rejected');
    else app.log.info(record, 'Request completed');
  });
  app.setErrorHandler((error, request, reply) => {
    const frameworkStatus =
      error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const status =
      error instanceof z.ZodError || error instanceof InvalidResumeUpload
        ? 400
        : error instanceof ResumeStorageLimit
          ? 507
          : error instanceof Conflict
            ? 409
            : error instanceof HttpError
              ? error.statusCode
              : frameworkStatus === 413
                ? 413
                : frameworkStatus === 400
                  ? 400
                  : 500;
    // A stable code an admin can filter on. Human messages get reworded;
    // this does not.
    const code: ErrorCode =
      error instanceof HttpError
        ? error.code
        : error instanceof z.ZodError
          ? 'validation_failed'
          : error instanceof InvalidResumeUpload
            ? 'invalid_resume_upload'
            : error instanceof ResumeStorageLimit
              ? 'resume_storage_limit'
              : error instanceof ProfileRevisionConflict || error instanceof LeadRevisionConflict
                ? 'revision_conflict'
                : error instanceof Conflict
                  ? 'idempotency_conflict'
                  : status === 413
                    ? 'payload_too_large'
                    : status === 400
                      ? 'validation_failed'
                      : 'internal_error';
    if (status === 500) request.log.error({ requestId: request.id }, 'Request failed');
    const messages: Record<number, string> = {
      400: 'Invalid request',
      409:
        error instanceof ProfileRevisionConflict || error instanceof LeadRevisionConflict
          ? 'Record changed; reload before saving'
          : 'Idempotency conflict',
      413: 'Request too large',
      500: 'Service unavailable',
      507: 'Resume storage capacity reached',
    };
    const fallbackMessage = messages[status] ?? 'Request failed';
    const message = error instanceof HttpError ? error.message : fallbackMessage;
    // Only unexpected and capacity failures are worth a durable record. Writing
    // one per validation error would turn a bad client into a disk-fill.
    if (status >= 500) {
      void diagnostics.record({
        requestId: request.id,
        ownerId: request.ownerId,
        service: 'api',
        revision: process.env.CAREERSCOPE_REVISION ?? null,
        route: request.routeOptions.url ?? null,
        method: request.method,
        status,
        errorCode: code,
        errorClass: error instanceof Error ? error.constructor.name : null,
        message,
        durationMs: Math.round(reply.elapsedTime),
      });
    }
    reply.code(status).send({ error: message, code, requestId: request.id });
  });
  app.get('/api/health', async () => {
    await database.pool.query('SELECT 1');
    return { status: 'ok', version };
  });

  // Owner-only debugging surface. Authorization, rate limiting and the denial
  // audit all happen in the onRequest hook above, so every route here can
  // assume an authenticated administrator and nothing more.
  //
  // These are read-only by design. There is no admin mutation endpoint, because
  // "an admin can change any row" is not a feature — it is the thing an audit
  // log exists to catch.
  //
  // Every route resolves the target account server-side from an identifier the
  // admin supplies, then scopes every query by the resolved owner id. A caller
  // cannot widen the scope by sending a different value.
  const resolveTarget = async (request: { query: unknown; id: string; ownerId: string | null }) => {
    const { user: term } = z.object({ user: z.string().min(1).max(254) }).parse(request.query);
    const target = await admin.findUser(term);
    if (!target) throw new HttpError(404, 'Account not found', 'not_found');
    return target as { id: string; email: string };
  };

  app.get('/api/admin/overview', async (request) => {
    const overview = await admin.overview();
    await audit.record({
      actorId: request.ownerId!,
      action: 'admin.overview',
      outcome: 'allowed',
      requestId: request.id,
    });
    return { revision: process.env.CAREERSCOPE_REVISION ?? null, version, ...overview };
  });

  app.get('/api/admin/users', async (request) => {
    const target = await resolveTarget(request as never);
    await audit.record({
      actorId: request.ownerId!,
      action: 'admin.user.view',
      outcome: 'allowed',
      targetOwnerId: target.id,
      targetType: 'user',
      targetId: target.id,
      requestId: request.id,
    });
    return target;
  });

  app.get('/api/admin/timeline', async (request) => {
    const target = await resolveTarget(request as never);
    const query = request.query as Record<string, unknown>;
    const entries = await admin.timeline(target.id, {
      from: query.from,
      to: query.to,
      limit: query.limit,
    });
    // Read access to another account's operational history is itself sensitive,
    // so it is audited even though it changes nothing.
    await audit.record({
      actorId: request.ownerId!,
      action: 'admin.timeline.view',
      outcome: 'allowed',
      targetOwnerId: target.id,
      targetType: 'user',
      targetId: target.id,
      requestId: request.id,
      detail: { entries: entries.length },
    });
    return { user: { id: target.id, email: target.email }, entries };
  });

  app.get('/api/admin/runs/:id', async (request) => {
    const target = await resolveTarget(request as never);
    const { id } = identifier.parse(request.params);
    const run = await admin.run(target.id, id);
    if (!run) throw new HttpError(404, 'Run not found', 'not_found');
    await audit.record({
      actorId: request.ownerId!,
      action: 'admin.run.view',
      outcome: 'allowed',
      targetOwnerId: target.id,
      targetType: 'run',
      targetId: id,
      requestId: request.id,
    });
    return run;
  });

  app.get('/api/admin/requests/:id', async (request) => {
    const target = await resolveTarget(request as never);
    const { id } = identifier.parse(request.params);
    const trail = await admin.byRequestId(target.id, id);
    await audit.record({
      actorId: request.ownerId!,
      action: 'admin.request.view',
      outcome: 'allowed',
      targetOwnerId: target.id,
      targetType: 'request',
      targetId: id,
      requestId: request.id,
    });
    return trail;
  });

  app.get('/api/admin/diagnostics', async (request) => {
    const query = request.query as Record<string, unknown>;
    // Scoping to an account is optional here, but when one is named it is
    // resolved server-side exactly as everywhere else.
    const target = query.user ? await resolveTarget(request as never) : null;
    const rows = await diagnostics.search({
      ownerId: target?.id,
      requestId: typeof query.requestId === 'string' ? query.requestId : undefined,
      errorCode: typeof query.errorCode === 'string' ? query.errorCode : undefined,
      from: query.from,
      to: query.to,
      limit: query.limit,
    });
    await audit.record({
      actorId: request.ownerId!,
      action: 'admin.diagnostics.search',
      outcome: 'allowed',
      targetOwnerId: target?.id ?? null,
      requestId: request.id,
      detail: { results: rows.length },
    });
    return { entries: rows };
  });

  app.get('/api/admin/audit', async (request) => {
    const query = request.query as Record<string, unknown>;
    const entries = await audit.list({ from: query.from, to: query.to, limit: query.limit });
    await audit.record({
      actorId: request.ownerId!,
      action: 'admin.audit.view',
      outcome: 'allowed',
      requestId: request.id,
      detail: { entries: entries.length },
    });
    return { entries };
  });

  // Groups recurrences so an investigation starts from "this failure happened
  // 40 times to 3 accounts since revision X", not from one row.
  app.get('/api/admin/fingerprints', async (request) => {
    const query = request.query as Record<string, unknown>;
    const entries = await diagnostics.fingerprints({
      from: query.from,
      to: query.to,
      limit: query.limit,
    });
    await audit.record({
      actorId: request.ownerId!,
      action: 'admin.fingerprints.view',
      outcome: 'allowed',
      requestId: request.id,
      detail: { groups: entries.length },
    });
    return { entries };
  });

  app.get('/api/admin/revisions', async (request) => {
    const query = request.query as Record<string, unknown>;
    const entries = await diagnostics.byRevision({ from: query.from, to: query.to });
    await audit.record({
      actorId: request.ownerId!,
      action: 'admin.revisions.view',
      outcome: 'allowed',
      requestId: request.id,
    });
    // Correlation, not causation. The caller is told which it is.
    return { entries, note: 'Error counts per revision are evidence, not proven causality.' };
  });

  app.get('/api/admin/traces/:id', async (request) => {
    const target = await resolveTarget(request as never);
    const { id } = identifier.parse(request.params);
    const trace = await traces.trace(target.id, id);
    if (!trace) throw new HttpError(404, 'Run not found', 'not_found');
    await audit.record({
      actorId: request.ownerId!,
      action: 'admin.trace.view',
      outcome: 'allowed',
      targetOwnerId: target.id,
      targetType: 'run',
      targetId: id,
      requestId: request.id,
    });
    return trace;
  });

  // Security activity is deliberately a separate view from operational
  // activity. "Who tried to reach this account" must not have to be filtered
  // out of ordinary request noise.
  app.get('/api/admin/security', async (request) => {
    const query = request.query as Record<string, unknown>;
    const target = query.user ? await resolveTarget(request as never) : null;
    const entries = await audit.list({
      from: query.from,
      to: query.to,
      limit: query.limit,
      actorId: target?.id,
      prefix: 'security.',
    });
    await audit.record({
      actorId: request.ownerId!,
      action: 'admin.security.view',
      outcome: 'allowed',
      targetOwnerId: target?.id ?? null,
      requestId: request.id,
      detail: { entries: entries.length },
    });
    return { entries };
  });

  app.get('/api/admin/debug-sessions', async () => {
    return { entries: await debugSessions.active() };
  });

  app.post('/api/admin/debug-sessions', async (request) => {
    const body = z
      .object({
        reason: z.string().trim().min(3).max(500),
        minutes: z.number().int().min(1).max(120).optional(),
        user: z.string().max(254).optional(),
      })
      .strict()
      .parse(request.body);
    const target = body.user ? await admin.findUser(body.user) : null;
    if (body.user && !target) throw new HttpError(404, 'Account not found', 'not_found');
    const session = await debugSessions.start({
      actorId: request.ownerId!,
      targetOwnerId: (target as { id: string } | null)?.id ?? null,
      reason: body.reason,
      minutes: body.minutes ?? 15,
    });
    await audit.record({
      actorId: request.ownerId!,
      action: 'admin.debug-session.start',
      outcome: 'allowed',
      targetOwnerId: (target as { id: string } | null)?.id ?? null,
      targetType: 'debug-session',
      targetId: session.id,
      requestId: request.id,
      // The reason is operator-supplied text and is recorded so the activation
      // is accountable.
      detail: { minutes: body.minutes ?? 15, reason: body.reason.slice(0, 200) },
    });
    return session;
  });

  app.delete('/api/admin/debug-sessions/:id', async (request, reply) => {
    const { id } = identifier.parse(request.params);
    const ended = await debugSessions.end(request.ownerId!, id);
    if (!ended) throw new HttpError(404, 'Debug session not found', 'not_found');
    await audit.record({
      actorId: request.ownerId!,
      action: 'admin.debug-session.end',
      outcome: 'allowed',
      targetType: 'debug-session',
      targetId: id,
      requestId: request.id,
    });
    return reply.code(204).send();
  });
  app.get('/api/session', async (request) => {
    const session = await auth.session(request.cookies[sessionCookie]);
    return session
      ? { authenticated: true, csrf: session.csrf }
      : { authenticated: false, registrationEnabled: options.registrationEnabled === true };
  });
  app.post('/api/register', async (request, reply) => {
    if (options.registrationEnabled !== true) throw new HttpError(404, 'Registration unavailable');
    const key = createHash('sha256').update(request.ip).digest('hex');
    if (!(await rateLimit(`register:${key}`, 5, 3600)))
      throw new HttpError(429, 'Too many attempts');
    const { email, password } = loginSchema.parse(request.body);
    await auth.register(email, password);
    return reply.code(202).send({ message: 'You can now try signing in with your credentials.' });
  });
  app.post('/api/login', async (request, reply) => {
    const { email, password } = loginSchema.parse(request.body);
    const key = createHash('sha256').update(request.ip).digest('hex');
    if (!(await rateLimit(`login:${key}`, 10, 60))) throw new HttpError(429, 'Too many attempts');
    const accountKey = createHash('sha256').update(email.toLowerCase()).digest('hex');
    if (!(await rateLimit(`login-account:${accountKey}`, 20, 60)))
      throw new HttpError(429, 'Too many attempts');
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
  app.post('/api/account/sessions/revoke-others', async (request, reply) => {
    if (!(await rateLimit(`sessions:${request.ownerId!}`, 5, 3600)))
      throw new HttpError(429, 'Too many attempts');
    z.object({}).strict().parse(request.body);
    if (!(await auth.revokeOtherSessions(request.ownerId!, request.cookies[sessionCookie]!)))
      throw new HttpError(401, 'Authentication required');
    return reply.code(204).send();
  });
  app.post('/api/account/password', async (request, reply) => {
    if (!(await rateLimit(`password:${request.ownerId!}`, 5, 3600)))
      throw new HttpError(429, 'Too many attempts');
    const input = z
      .object({
        currentPassword: z.string().min(12).max(256),
        newPassword: z.string().min(12).max(256),
      })
      .strict()
      .parse(request.body);
    const changed = await auth.changePassword(
      request.ownerId!,
      input.currentPassword,
      input.newPassword,
    );
    if (!changed) throw new HttpError(400, 'Password could not be changed');
    reply.clearCookie(sessionCookie, { path: '/api' });
    return reply.code(204).send();
  });
  await app.register(async (resumes) => {
    resumes.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: maximumResumeBytes },
      (_request, body, done) => done(null, body),
    );
    resumes.get('/api/resumes', async (request) => {
      if (!coordinator) return { enabled: false, items: [] };
      const result = await database.pool.query(
        `SELECT upload.id, upload.bytes, upload.content_type AS "contentType",
         upload.created_at AS "createdAt", COALESCE(result.status, upload.status) AS status
         FROM resume_uploads upload LEFT JOIN resume_results result
         ON result.upload_id = upload.id AND result.owner_id = upload.owner_id
         WHERE upload.owner_id = $1 ORDER BY upload.created_at DESC, upload.id DESC LIMIT 50`,
        [request.ownerId],
      );
      return {
        enabled: true,
        cancellationEnabled: !!options.resumeStorage?.cancelUpload,
        items: result.rows,
      };
    });
    resumes.post(
      '/api/resumes',
      {
        bodyLimit: maximumResumeBytes,
        onRequest: async (request) => {
          if (!coordinator) throw new HttpError(503, 'Resume uploads unavailable');
          if (!(await rateLimit(`upload:${request.ownerId!}`, 5, 3600)))
            throw new HttpError(429, 'Too many uploads');
        },
      },
      async (request, reply) => {
        if (!Buffer.isBuffer(request.body))
          throw new HttpError(400, 'A PDF or DOCX file is required');
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.raw.once('aborted', abort);
        try {
          const upload = await coordinator!.upload(
            request.ownerId!,
            idempotencyKey.parse(request.headers['idempotency-key']),
            request.body,
            controller.signal,
            request.id,
          );
          if (!upload) throw new HttpError(409, 'Upload changed; retry');
          return reply.code(202).send({ id: upload.id, status: upload.status });
        } finally {
          request.raw.removeListener('aborted', abort);
        }
      },
    );
    resumes.get('/api/resumes/:id', async (request) => {
      if (!coordinator) throw new HttpError(503, 'Resume uploads unavailable');
      const { id } = identifier.parse(request.params);
      const upload = await uploads.get(request.ownerId!, id);
      if (!upload) throw new HttpError(404, 'Resume not found');
      const result = await uploads.result(request.ownerId!, id);
      return { id, status: result?.status ?? upload.status, result };
    });
    resumes.post('/api/resumes/:id/recover', async (request, reply) => {
      if (!coordinator) throw new HttpError(503, 'Resume uploads unavailable');
      if (!(await rateLimit(`resume-recover:${request.ownerId!}`, 10, 3600)))
        throw new HttpError(429, 'Too many attempts');
      const { id } = identifier.parse(request.params);
      const controller = new AbortController();
      const abort = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once('close', abort);
      try {
        const record = await coordinator.reconcile(
          request.ownerId!,
          id,
          controller.signal,
          request.id,
        );
        if (!record) throw new HttpError(404, 'Resume not found');
        return { id: record.id, status: record.status };
      } finally {
        reply.raw.removeListener('close', abort);
      }
    });
    resumes.post('/api/resumes/:id/cancel', async (request, reply) => {
      const storage = options.resumeStorage;
      if (!storage?.cancelUpload) throw new HttpError(503, 'Upload cancellation unavailable');
      if (!(await rateLimit(`resume-cancel:${request.ownerId!}`, 20, 60)))
        throw new HttpError(429, 'Too many requests');
      const { id } = identifier.parse(request.params);
      if (request.body !== undefined) z.object({}).strict().parse(request.body);
      const controller = new AbortController();
      const abort = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once('close', abort);
      try {
        const record = await uploads.cancelUpload(
          request.ownerId!,
          id,
          storage.bucket,
          async (upload) => {
            await storage.cancelUpload!(
              {
                ownerId: upload.ownerId,
                resumeId: upload.id,
                sha256: upload.sha256,
                bytes: upload.bytes,
                contentType: upload.contentType,
              },
              AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
            );
          },
        );
        if (!record) throw new HttpError(404, 'Resume not found');
        return { id: record.id, status: record.status };
      } finally {
        reply.raw.removeListener('close', abort);
      }
    });
    resumes.delete('/api/resumes/:id', async (request, reply) => {
      if (!options.resumeStorage) throw new HttpError(503, 'Resume uploads unavailable');
      if (!(await rateLimit(`resume-delete:${request.ownerId!}`, 20, 60)))
        throw new HttpError(429, 'Too many requests');
      const { id } = identifier.parse(request.params);
      await uploads.deleteSettled(request.ownerId!, id, async (record) => {
        if (record.bucket !== options.resumeStorage!.bucket || !record.objectVersion)
          throw new HttpError(409, 'Resume storage changed');
        await options.resumeStorage!.delete(
          {
            ownerId: record.ownerId,
            resumeId: record.id,
            sha256: record.sha256,
            bytes: record.bytes,
            contentType: record.contentType,
          },
          record.objectVersion,
          AbortSignal.timeout(15000),
        );
      });
      return reply.code(204).send();
    });
  });
  app.get('/api/profile', async (request) => {
    return (
      (await profiles.get(request.ownerId!)) ?? { revision: 0, profile: null, updatedAt: null }
    );
  });
  app.get('/api/preparation', async (request) => {
    z.object({}).strict().parse(request.query);
    if (!(await rateLimit(`preparation:${request.ownerId!}`, 30, 60)))
      throw new HttpError(429, 'Too many preparation requests');
    return prepareProfile(await profiles.get(request.ownerId!));
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
      request.id,
    );
    // Links the run to the request that created it for end-to-end tracing.
    request.log.info(
      { requestId: request.id, runId: search.id, status: search.status },
      'Search run created',
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
    // A cursor that predates the retained window means the client missed events,
    // which is recoverable by resynchronising rather than a client error.
    let resynchronise = false;
    if (cursor !== '0') {
      const known = await database.pool.query<{ retained: string | null }>(
        `SELECT
           (SELECT min(sequence)::text FROM run_events WHERE owner_id = $1 AND run_id = $2)
             AS retained,
           EXISTS (
             SELECT 1 FROM run_events
             WHERE owner_id = $1 AND run_id = $2 AND sequence = $3::bigint
           ) AS present`,
        [ownerId, id, cursor],
      );
      const row = known.rows[0] as unknown as { retained: string | null; present: boolean };
      if (!row?.present) {
        // No retained events at all also means the cursor expired: refusing it
        // would strand a client whose history was pruned entirely.
        if (!row?.retained || BigInt(cursor) < BigInt(row.retained)) {
          resynchronise = true;
          cursor = '0';
        } else {
          throw new HttpError(400, 'Invalid event cursor');
        }
      }
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
          if (resynchronise) yield 'event: reset\ndata: {"reason":"cursor-expired"}\n\n';
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
