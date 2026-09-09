/**
 * The MCP entry point — `npm run mcp`.
 *
 * A stdio server for VS Code Copilot and any other MCP client. It builds the
 * same {@link Container} the HTTP API builds, over the same database file, so
 * the two faces share one set of leads rather than diverging into two.
 *
 * ## stdout is the protocol
 *
 * MCP frames JSON-RPC over stdout. Anything else written there corrupts the
 * stream and the client disconnects with a parse error that names nothing
 * useful. So the logger is pinned to stderr for this process — see the
 * `destination` below — and nothing in this file may `console.log`.
 *
 * That is also why a startup failure is reported on stderr and the process
 * exits: there is no channel to report it on, and a half-built server that
 * answers every tool with an internal error is worse than one that is visibly
 * not running.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pino from 'pino';
import { createContainer } from '../container.js';
import { parseEnv } from '../env.js';
import { buildMcpServer } from './server.js';

async function main(): Promise<void> {
  const env = parseEnv();

  // Stderr, not stdout. `pino.destination(2)` is the fd, and this is the single
  // most important line in the file: pino's default is fd 1, which is the
  // protocol channel.
  const logger = pino(
    { level: env.LOG_LEVEL, base: { name: 'job-radar-mcp' } },
    pino.destination(2),
  );

  const container = createContainer(env, { logger });
  const server = buildMcpServer(container);

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down mcp server');
    void (async () => {
      try {
        await server.close();
        await container.close();
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(new StdioServerTransport());
  logger.info({ dataDir: env.DATA_DIR }, 'job-radar mcp server ready on stdio');
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `job-radar mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
