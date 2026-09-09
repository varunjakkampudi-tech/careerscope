/**
 * The HTTP server.
 *
 * `buildApp` takes a fully-built {@link Container} and returns a Fastify
 * instance. It does not construct anything itself and it does not listen — that
 * belongs to `index.ts` — so a test can build the real app over an in-memory
 * database and drive it through `app.inject()` with no socket and no ports.
 *
 * Plugin order is not arbitrary; each entry below is registered before the one
 * that depends on it:
 *
 *  1. `helmet` and `cors` — headers must be set before anything can short-circuit
 *     a response, or a 401 goes out without them.
 *  2. `rate-limit` — must see the request before the auth hook rejects it,
 *     otherwise an attacker gets unlimited free key guesses.
 *  3. `multipart` — body parsing.
 *  4. the auth hook — after the above, before any route handler.
 *  5. routes, then the SPA static root last, because it claims paths that would
 *     otherwise reach the API's own 404.
 */

import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import { MAX_RESUME_BYTES } from '@job-radar/shared';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Container } from './container.js';
import { ApiProblem, toApiError } from './errors.js';
import { registerRoutes } from './routes/index.js';
import { newId } from './util/ids.js';
import { authRoutes, requireAuthOrigin, sessionCookieName } from './routes/auth.js';

/** JSON bodies are small; only the resume upload is large, and that is multipart. */
const JSON_BODY_LIMIT = 1024 * 1024;

/** Endpoints that must answer before a key is configured, or during a probe. */
const PUBLIC_PATHS = new Set(['/api/health', '/api/health/ready']);

export async function buildApp(container: Container): Promise<FastifyInstance> {
  // Widened to Fastify's own logger interface on the way in. Handing over pino's
  // concrete `Logger` makes Fastify infer a *narrower* instance type, which is
  // then not assignable to the plain `FastifyInstance` every route module is
  // written against — the two disagree over `msgPrefix`. Widening here keeps one
  // instance type across the whole app and costs nothing at runtime.
  const loggerInstance: FastifyBaseLogger = container.logger;

  const app = Fastify({
    // Fastify 5 takes a *constructed* pino instance under `loggerInstance`;
    // `logger` is reserved for the config-object form. Passing ours through
    // means every request line inherits the redaction rules in `logger.ts`.
    loggerInstance,
    bodyLimit: JSON_BODY_LIMIT,
    // A search request returns in milliseconds — it only enqueues. Nothing this
    // server does synchronously should take longer than this.
    requestTimeout: 30_000,
    // Behind nginx on EC2, so the client IP the rate limiter buckets on has to
    // come from `X-Forwarded-For`. Without this every request looks like it came
    // from the proxy and one visitor exhausts everyone's allowance.
    trustProxy: container.env.TRUST_PROXY,
    // Router options live under `routerOptions` from Fastify 5.12 on; the
    // top-level spelling still works but warns on every boot, and is removed in
    // Fastify 6.
    routerOptions: { ignoreTrailingSlash: true },
    // Lets an in-flight SSE stream finish rather than being cut mid-event when
    // the process is asked to stop.
    return503OnClosing: true,
    genReqId: () => newId(),
  });

  app.setErrorHandler((error, request, reply) => {
    const { statusCode, body } = toApiError(error, (cause) => {
      request.log.error({ err: cause, url: request.url }, 'request failed');
    });
    void reply.status(statusCode).send(body);
  });

  await registerPlugins(app, container);
  installAuth(app, container);
  await app.register(authRoutes, { container });
  await app.register(registerRoutes, { prefix: '/api', container });

  const spaRoot = await serveWeb(app, container);
  installNotFound(app, spaRoot);

  return app;
}

/* -------------------------------------------------------------------------- */
/* Plugins                                                                    */
/* -------------------------------------------------------------------------- */

async function registerPlugins(app: FastifyInstance, container: Container): Promise<void> {
  const { env } = container;
  await app.register(cookie);

  await app.register(helmet, {
    // A restrictive CSP only makes sense when this server also serves the HTML.
    // On the split deploy the API returns JSON exclusively, where a CSP protects
    // nothing and only risks breaking the page it does not serve.
    contentSecurityPolicy: env.SERVE_WEB
      ? {
          directives: {
            defaultSrc: ["'self'"],
            // Vite emits a hashed inline style block into index.html.
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'"],
            frameAncestors: ["'none'"],
            upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null,
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin: corsOrigin(
      env.LOGIN_ENABLED
        ? [new URL(env.AUTH_ORIGIN).origin, ...env.CORS_ORIGINS.filter((origin) => origin !== '*')]
        : env.CORS_ORIGINS,
    ),
    credentials: env.LOGIN_ENABLED,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-api-key', 'authorization', 'last-event-id'],
    // The export endpoints set a filename the browser needs to read.
    exposedHeaders: ['content-disposition'],
    maxAge: 86_400,
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // A long-lived SSE connection and a spreadsheet download are not the abuse
    // this guards against, and counting them would throttle a working session.
    allowList: (request) =>
      /^\/api\/runs\/[^/]+\/events$/.test(pathOf(request.url)) ||
      pathOf(request.url).startsWith('/api/export/'),
    errorResponseBuilder: (_request, context) =>
      new ApiProblem(429, 'rate_limited', `Too many requests. Try again in ${context.after}.`),
  });

  await app.register(multipart, {
    limits: {
      fileSize: MAX_RESUME_BYTES,
      files: 1,
      // The resume upload sends the file plus a handful of text fields.
      fields: 20,
    },
  });
}

/**
 * Turns the configured allowlist into a CORS predicate.
 *
 * An empty list means same-origin only — the correct default for the EC2 deploy
 * where this server also serves the SPA. `*` is honoured but deliberately
 * awkward to reach: it only happens when someone writes it into `CORS_ORIGINS`.
 */
function corsOrigin(origins: readonly string[]): boolean | string[] {
  if (origins.length === 0) return false;
  if (origins.includes('*')) return true;
  return [...origins];
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

function installAuth(app: FastifyInstance, container: Container): void {
  const { env, logger } = container;

  if (env.AUTH_DISABLED && !env.LOGIN_ENABLED) {
    logger.warn('authentication is disabled — never do this outside local development');
    return;
  }

  const expected = env.APP_API_KEY;
  if (!expected && !env.LOGIN_ENABLED) {
    // Unreachable in production (env.ts hard-fails), so this can only be a dev
    // box that set neither the key nor the bypass. Rejecting everything is the
    // safe reading of that: an unauthenticated open API is the worse mistake.
    logger.error('no APP_API_KEY and AUTH_DISABLED is false — every request will be rejected');
  }

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return;

    const path = pathOf(request.url);

    // The key guards the API, not the page that asks for it.
    //
    // On the single-origin deploy this server also serves the SPA, and the key
    // lives in the browser — the user types it into a screen this server has to
    // hand them first. Guarding `/` and `/assets/*` too would 401 the shell,
    // and there would be no way in at all. Nothing is given away by leaving
    // them open: the bundle is public on the Pages deploy regardless, and it
    // contains no secret. Every route that touches data is under `/api`.
    if (path !== '/api' && !path.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');

    if (PUBLIC_PATHS.has(path)) return;
    if (
      ['/api/auth/session', '/api/auth/setup', '/api/auth/login', '/api/auth/logout'].includes(path)
    )
      return;

    const presented =
      headerValue(request.headers['x-api-key']) ?? bearer(request.headers.authorization);

    if (expected && presented && timingSafeEqual(presented, expected)) return;
    if (env.LOGIN_ENABLED) {
      const token = request.cookies[sessionCookieName(env)];
      if (token) {
        await container.repos.auth.verify(token);
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) requireAuthOrigin(request, env);
        return;
      }
    }
    throw ApiProblem.unauthorized(
      env.LOGIN_ENABLED ? 'Please sign in to continue.' : 'Missing or invalid API key',
    );
  });
}

function pathOf(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

function headerValue(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

/**
 * `Authorization: Bearer …` is accepted alongside `x-api-key`.
 *
 * Keeps curl, the MCP bridge and any HTTP client with an opinion on auth headers
 * on a conventional path, rather than forcing a bespoke header everywhere.
 */
function bearer(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

/**
 * Constant-time string comparison.
 *
 * `crypto.timingSafeEqual` throws when the two buffers differ in length, and
 * catching that would itself be a length oracle. Hashing both sides to a fixed
 * 32 bytes first sidesteps it: the digests are always the same size, and equal
 * digests mean equal inputs.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return nodeTimingSafeEqual(left, right);
}

/* -------------------------------------------------------------------------- */
/* SPA                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Serves the built SPA, for the single-origin EC2 deploy. Returns whether it did.
 *
 * A missing build is a warning, not a crash. The API is useful on its own — the
 * GitHub Pages deploy runs exactly this way — and refusing to boot because a
 * frontend bundle is absent would take the working half down with the missing
 * one.
 */
async function serveWeb(app: FastifyInstance, container: Container): Promise<string | null> {
  const { env, logger } = container;
  if (!env.SERVE_WEB) return null;

  const root = isAbsolute(env.WEB_DIST) ? env.WEB_DIST : resolve(process.cwd(), env.WEB_DIST);
  if (!existsSync(join(root, 'index.html'))) {
    logger.warn({ root }, 'SERVE_WEB is set but no index.html was found — serving the API only');
    return null;
  }

  // `wildcard: false` stops the plugin from registering a `/*` route. Without it
  // static would claim every unmatched path, including mistyped API routes, and
  // answer them with HTML instead of a JSON 404.
  await app.register(staticPlugin, { root, wildcard: false, index: false });
  logger.info({ root }, 'serving the web client');
  return root;
}

/**
 * The single 404 handler.
 *
 * One handler, not two: Fastify allows exactly one per prefix, and the SPA
 * fallback and the API's JSON 404 are the same decision made on different paths.
 * A GET that is not under `/api` and did not match a real file is a client-side
 * route — `/leads`, `/settings` — and gets the shell. Everything else, including
 * a mistyped POST, gets JSON, because an HTML page in reply to an API call is a
 * confusing way to report a typo.
 */
function installNotFound(app: FastifyInstance, spaRoot: string | null): void {
  app.setNotFoundHandler((request, reply) => {
    const wantsShell =
      spaRoot !== null && request.method === 'GET' && !pathOf(request.url).startsWith('/api');

    if (wantsShell) return reply.sendFile('index.html');

    return reply
      .status(404)
      .send(
        new ApiProblem(404, 'not_found', `No route for ${request.method} ${request.url}`).toJSON(),
      );
  });
}
