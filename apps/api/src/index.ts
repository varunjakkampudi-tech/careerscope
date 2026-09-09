/**
 * Entrypoint.
 *
 * Boot order is: parse the environment, build the container, build the app,
 * listen. `parseEnv` throws on a bad or missing variable, so a misconfigured
 * deployment dies at startup with a readable message instead of at the first
 * request with a stack trace — which matters when systemd is restarting the
 * process in a loop and the only evidence is the journal.
 *
 * ## Shutdown
 *
 * A search run takes minutes. Killing the process mid-run leaves a `running` row
 * that nothing will ever finish, so shutdown is ordered:
 *
 *  1. `app.close()` — stops accepting connections and lets in-flight requests
 *     drain. Fastify's `return503OnClosing` answers anything new during this
 *     window, which is what lets a load balancer move on cleanly.
 *  2. `container.close()` — cancels the active run, marks it, then closes the
 *     database. `RunQueue.close()` owns that; see the abort-ownership rule there.
 *
 * A second signal during shutdown exits immediately. Someone pressing Ctrl-C
 * twice means it, and the worst case is the orphan reaper tidying up on the next
 * boot — which it does anyway.
 */

import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { createContainer, type Container } from './container.js';
import { parseEnv, redactedEnv } from './env.js';

/** Long enough for a request to finish, short enough that systemd won't SIGKILL. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const env = parseEnv();
  const container = createContainer(env);
  const { logger } = container;

  logger.info(redactedEnv(env), 'starting job-radar api');

  const app = await buildApp(container);

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (error) {
    logger.fatal({ err: error }, 'failed to bind — is the port already in use?');
    await container.close();
    process.exitCode = 1;
    return;
  }

  installShutdown(app, container);
}

function installShutdown(app: FastifyInstance, container: Container): void {
  const { logger } = container;
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      logger.warn({ signal }, 'second signal — exiting now');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // A hard deadline, because `app.close()` waits on in-flight requests and an
    // open SSE stream is an in-flight request that by design never ends. The
    // timer is unref'd so it cannot itself hold the process open once the
    // graceful path wins the race.
    const deadline = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    deadline.unref();

    void (async () => {
      try {
        await app.close();
        await container.close();
        logger.info('shutdown complete');
      } catch (error) {
        logger.error({ err: error }, 'error during shutdown');
        process.exitCode = 1;
      } finally {
        clearTimeout(deadline);
      }
    })();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Nothing in this app can be trusted to keep working after an unhandled
  // rejection — a half-written run row is worse than a restart. Logged through
  // pino rather than Node's default handler so the fault lands in the same
  // structured stream as everything else.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    shutdown('uncaughtException');
  });
}

try {
  await main();
} catch (error) {
  // Reached when `parseEnv` rejects the configuration, which happens before a
  // logger exists. `console.error` is the only channel available, and a bare
  // message is more useful here than a stack trace pointing at Zod internals.
  console.error(`job-radar failed to start: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
