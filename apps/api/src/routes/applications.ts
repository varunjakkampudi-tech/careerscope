import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiProblem, parseOrThrow } from '../errors.js';
import type { RouteOptions } from './index.js';

export async function applicationsRoutes(
  app: FastifyInstance,
  { container }: RouteOptions,
): Promise<void> {
  const { applications, env } = container;
  const idOf = (request: FastifyRequest) =>
    parseOrThrow(z.object({ id: z.string().uuid() }), request.params).id;
  const local = (request: FastifyRequest) => {
    if (
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip) ||
      env.NODE_ENV === 'production'
    ) {
      throw ApiProblem.serviceUnavailable('Application automation requires the local desktop API.');
    }
    const origin = request.headers.origin;
    if (origin) {
      let hostname: string;
      try {
        hostname = new URL(origin).hostname;
      } catch {
        throw ApiProblem.unauthorized('Invalid origin.');
      }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname))
        throw ApiProblem.unauthorized('Application control requires a local origin.');
    }
  };
  const enabled = () => {
    if (!env.ENABLE_APPLICATION_AGENT)
      throw ApiProblem.serviceUnavailable(
        'Set ENABLE_APPLICATION_AGENT=true on the local API to enable Copilot applications.',
      );
  };

  app.get('/applications/capability', async (request) => {
    local(request);
    if (!env.ENABLE_APPLICATION_AGENT)
      return {
        available: false,
        reason:
          'Set ENABLE_APPLICATION_AGENT=true on the local API to enable Copilot applications.',
      };
    return applications.capability();
  });
  app.get('/applications', async (request) => {
    const { leadId } = parseOrThrow(z.object({ leadId: z.string().optional() }), request.query);
    return {
      active: applications.runs.active(),
      runs: leadId ? applications.runs.list(leadId) : applications.runs.recent(),
    };
  });
  app.get('/applications/:id', async (request) => {
    const id = idOf(request);
    const run = applications.runs.get(id);
    if (!run) throw ApiProblem.notFound('Application', id);
    return { run };
  });
  app.post('/applications', async (request, reply) => {
    local(request);
    enabled();
    const input = parseOrThrow(
      z
        .object({
          leadId: z.string().uuid(),
          consent: z.literal(true),
          autoSubmit: z.boolean().default(false),
          retryOf: z.string().uuid().optional(),
        })
        .strict(),
      request.body,
    );
    const run = await applications.start(
      input.leadId,
      input.consent,
      input.autoSubmit,
      input.retryOf,
    );
    return reply.status(202).send({ run });
  });
  app.post('/applications/:id/respond', async (request) => {
    local(request);
    enabled();
    const input = parseOrThrow(
      z
        .object({
          requestId: z.string().uuid(),
          answer: z.string().trim().min(1).max(10000),
          approved: z.literal(true),
        })
        .strict(),
      request.body,
    );
    return { run: applications.respond(idOf(request), input.requestId, input.answer) };
  });
  app.post('/applications/:id/cancel', async (request) => {
    local(request);
    return { run: await applications.cancel(idOf(request)) };
  });
}
