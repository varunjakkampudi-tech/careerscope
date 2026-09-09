/**
 * Liveness and readiness.
 *
 * Two endpoints, because they answer different questions and a load balancer
 * needs both:
 *
 *  - `/api/health` — is the process up? Cheap, does no I/O, never fails while
 *    the event loop is turning. This is what a container healthcheck and an ELB
 *    target-group probe should call.
 *  - `/api/health/ready` — is it able to do work? Touches the database and
 *    reports the queue. A deploy script waits on this one before shifting
 *    traffic, because a process that is listening but cannot open its database
 *    would otherwise be declared healthy.
 *
 * Both are exempt from the API key — see `PUBLIC_PATHS` in `app.ts`. A probe
 * cannot carry a secret, and the response deliberately contains nothing worth
 * protecting: no dependency versions, no paths, no configuration values.
 */

import type { FastifyInstance } from 'fastify';
import type { RouteOptions } from './index.js';

const startedAt = Date.now();

export async function healthRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { queue, repos } = options.container;

  app.get('/health', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  }));

  app.get('/health/ready', async (request, reply) => {
    let database = true;
    try {
      // A real read against a real table, not `SELECT 1`. This proves the schema
      // is present and readable, which is the failure a fresh volume or a
      // half-applied migration actually produces — `SELECT 1` would pass through
      // both.
      repos.settings.get('seed.version');
    } catch (error) {
      request.log.error({ err: error }, 'readiness probe could not read the database');
      database = false;
    }

    return reply.status(database ? 200 : 503).send({
      status: database ? 'ready' : 'degraded',
      checks: { database },
      queue: queue.status(),
    });
  });
}
