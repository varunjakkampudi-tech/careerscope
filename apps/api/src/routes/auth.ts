import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Env } from '../env.js';
import { ApiProblem, parseOrThrow } from '../errors.js';
import { SESSION_SECONDS } from '../db/repo/auth.js';
import type { RouteOptions } from './index.js';

export function sessionCookieName(env: Env): string {
  return env.NODE_ENV === 'production' ? '__Host-job-radar-session' : 'job-radar-session';
}

export function requireAuthOrigin(request: FastifyRequest, env: Env): void {
  const origin = request.headers.origin;
  const allowed = [
    new URL(env.AUTH_ORIGIN).origin,
    ...env.CORS_ORIGINS.filter((value) => value !== '*'),
  ];
  if (!origin || !allowed.includes(origin) || request.headers['sec-fetch-site'] === 'cross-site') {
    throw new ApiProblem(
      403,
      'invalid_origin',
      'This request must come from the Job Radar application.',
    );
  }
}

function canSetup(request: FastifyRequest, env: Env): boolean {
  let host = '';
  try {
    host = new URL(`http://${request.headers.host}`).hostname;
  } catch {
    return false;
  }
  return (
    env.NODE_ENV !== 'production' &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') &&
    ['localhost', '127.0.0.1', '[::1]'].includes(host) &&
    !request.headers['x-forwarded-for']
  );
}

const credentials = z
  .object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(256) })
  .strict();
const setupCredentials = credentials.extend({
  password: z.string().min(12, 'Use at least 12 characters.').max(256),
});

export async function authRoutes(app: FastifyInstance, { container }: RouteOptions): Promise<void> {
  const { env, repos } = container;
  const options = {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: SESSION_SECONDS,
  };
  const enabled = () => {
    if (!env.LOGIN_ENABLED) throw ApiProblem.notFound('Login');
  };
  const limited = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, bodyLimit: 4096 };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  app.get('/api/auth/session', async (request) => {
    if (!env.LOGIN_ENABLED)
      return {
        enabled: false,
        configured: false,
        authenticated: false,
        canSetup: false,
        email: null,
      };
    const configured = repos.auth.configured();
    const token = request.cookies[sessionCookieName(env)];
    const session = token ? await repos.auth.verify(token).catch(() => null) : null;
    return {
      enabled: true,
      configured,
      authenticated: !!session,
      canSetup: !configured && canSetup(request, env),
      email: session?.email ?? null,
    };
  });

  app.post('/api/auth/setup', limited, async (request, reply) => {
    enabled();
    requireAuthOrigin(request, env);
    if (!canSetup(request, env))
      throw new ApiProblem(
        403,
        'setup_local_only',
        'Create the owner account on the local machine before deploying.',
      );
    const input = parseOrThrow(setupCredentials, request.body);
    await repos.auth.setup(input.email, input.password);
    const token = await repos.auth.login(input.email, input.password);
    reply.setCookie(sessionCookieName(env), token, options);
    return reply.status(201).send({ authenticated: true });
  });

  app.post('/api/auth/login', limited, async (request, reply) => {
    enabled();
    requireAuthOrigin(request, env);
    const input = parseOrThrow(credentials, request.body);
    const token = await repos.auth.login(input.email, input.password);
    const old = request.cookies[sessionCookieName(env)];
    if (old) {
      const session = await repos.auth.verify(old).catch(() => null);
      if (session) repos.auth.revoke(session.id);
    }
    reply.setCookie(sessionCookieName(env), token, options);
    return { authenticated: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    enabled();
    requireAuthOrigin(request, env);
    const token = request.cookies[sessionCookieName(env)];
    if (token) {
      const session = await repos.auth.verify(token).catch(() => null);
      if (session) repos.auth.revoke(session.id);
    }
    reply.clearCookie(sessionCookieName(env), { ...options, maxAge: 0 });
    return { authenticated: false };
  });
}
