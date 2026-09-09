/**
 * Runs: status, history, cancellation, and the live event stream.
 *
 * ## The SSE endpoint
 *
 * `GET /api/runs/:id/events` is the only streaming endpoint in the app, and the
 * four details below are what make it survive a real deployment rather than just
 * a localhost demo.
 *
 * **A finished run is replayed, not subscribed to.** A run that has already
 * ended has a fixed, complete event list; reading it out of the database and
 * closing is both correct and terminating. Subscribing instead would work right
 * up until the client reconnects with a `since` past the final event, at which
 * point there is nothing left to replay and nothing will ever be published —
 * a connection that hangs until a proxy kills it.
 *
 * **Heartbeats.** An idle nginx or ALB closes a connection with no bytes on it
 * after 60 seconds. Enrichment can easily be quiet for longer than that, so a
 * `: ping` comment goes out every 20 seconds. Comments are part of the SSE
 * grammar and every client ignores them.
 *
 * **`X-Accel-Buffering: no`.** nginx buffers proxied responses by default, which
 * for a stream means the user sees nothing for a minute and then everything at
 * once. `infra/nginx.conf` disables buffering on this path; this header is the
 * same instruction carried in the response, so a deployment behind a proxy
 * nobody configured still works.
 *
 * **The key stays in a header.** `EventSource` cannot set headers, which usually
 * pushes people into `?apiKey=…`. That puts the secret in nginx's access log, in
 * browser history, and in the `Referer` of anything the page later loads. The
 * web client uses `fetch` with a streaming body reader instead — a few more
 * lines there in exchange for not writing the key to three logs here.
 */

import { isAbortError } from '@job-radar/providers';
import type { RunEvent } from '@job-radar/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { StoredEvent } from '../db/repo/index.js';
import { ApiProblem } from '../errors.js';
import type { RouteOptions } from './index.js';
import { sessionCookieName } from './auth.js';

/** Comfortably inside the 60s idle timeout of nginx and every managed LB. */
const HEARTBEAT_MS = 20_000;

/** Tells the browser how long to wait before reconnecting after a drop. */
const RETRY_MS = 3_000;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export async function runsRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { repos, events, queue } = options.container;

  app.get('/runs', async (request) => {
    const { limit } = request.query as { limit?: string };
    const parsed = Number(limit);
    const count = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 20;
    return { runs: repos.runs.list(count) };
  });

  /** The run currently queued or executing, if any. Drives the "resume" banner. */
  app.get('/runs/active', async () => ({ run: repos.runs.active() }));

  app.get('/runs/:id', async (request) => {
    const run = repos.runs.get(idOf(request));
    if (!run) throw ApiProblem.notFound('Run', idOf(request));
    return { run, leadCount: repos.leads.byRun(run.id).length };
  });

  /**
   * The run log.
   *
   * Separate from the stream so a finished run's log is readable without opening
   * an SSE connection — which is what the run-history screen does.
   */
  app.get('/runs/:id/logs', async (request) => {
    const id = idOf(request);
    if (!repos.runs.get(id)) throw ApiProblem.notFound('Run', id);
    return { logs: repos.runs.logs(id) };
  });

  app.post('/runs/:id/cancel', async (request) => {
    const id = idOf(request);
    const run = repos.runs.get(id);
    if (!run) throw ApiProblem.notFound('Run', id);

    const cancelled = queue.cancel(id);
    if (!cancelled) {
      throw ApiProblem.conflict(
        `Run ${id} has already ${past(run.status)} and cannot be cancelled`,
      );
    }
    return { run: repos.runs.get(id) };
  });

  app.get('/runs/:id/events', async (request, reply) => {
    const id = idOf(request);
    const run = repos.runs.get(id);
    if (!run) throw ApiProblem.notFound('Run', id);

    const since = sinceOf(request);

    // Past this point the response is written by hand, so Fastify must be told
    // to stop managing it — otherwise it tries to serialise a return value onto
    // a socket that is already streaming.
    reply.hijack();
    const stream = openStream(reply);

    if (TERMINAL_STATUSES.has(run.status)) {
      const backlog = repos.runs.eventsSince(id, since);
      for (const event of backlog) stream.send(event);
      // A run that has ended may have ended before it published anything this
      // client had not already seen. Sending the run itself guarantees a
      // terminal event always arrives, so the client can close cleanly instead
      // of waiting on a stream that will never speak again.
      if (!backlog.some(isTerminalEvent)) stream.sendSynthetic({ type: 'done', run });
      stream.close();
      return;
    }

    const abort = new AbortController();
    request.raw.on('close', () => abort.abort());
    const token = request.cookies[sessionCookieName(options.container.env)];
    const verifySession = async () => {
      if (options.container.env.LOGIN_ENABLED && token) await repos.auth.verify(token);
    };
    const heartbeat = setInterval(() => {
      void verifySession()
        .then(() => stream.ping())
        .catch(() => {
          abort.abort();
          stream.close();
        });
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      for await (const event of events.stream(id, since, abort.signal)) {
        await verifySession();
        stream.send(event);
      }
    } catch (error) {
      if (!isAbortError(error)) {
        request.log.error({ err: error, runId: id }, 'event stream failed');
        stream.sendSynthetic({ type: 'error', message: 'The event stream was interrupted' });
      }
    } finally {
      clearInterval(heartbeat);
      stream.close();
    }
  });
}

/* -------------------------------------------------------------------------- */
/* SSE framing                                                                */
/* -------------------------------------------------------------------------- */

interface Stream {
  send(event: StoredEvent): void;
  /** For events with no database row — a terminal marker or a stream fault. */
  sendSynthetic(event: RunEvent): void;
  ping(): void;
  close(): void;
}

function openStream(reply: FastifyReply): Stream {
  const raw = reply.raw;

  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) raw.setHeader(name, value);
  }
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    // `no-transform` matters as much as `no-cache`: a compressing proxy will
    // otherwise buffer the stream to find something to compress.
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  // An immediate comment flushes the headers, so the client's `open` fires now
  // rather than whenever the first real event happens to arrive.
  raw.write(`retry: ${RETRY_MS}\n: connected\n\n`);

  const write = (text: string): void => {
    // The socket is gone the instant the user closes the tab; writing to it
    // throws EPIPE, which is expected rather than exceptional.
    if (!raw.writableEnded) raw.write(text);
  };

  return {
    send(event) {
      // `id:` is what the client echoes back as `since` on reconnect, which is
      // how a dropped connection resumes rather than replaying from zero.
      write(
        `id: ${event.seq}\nevent: ${event.event.type}\ndata: ${JSON.stringify(event.event)}\n\n`,
      );
    },
    sendSynthetic(event) {
      write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    ping() {
      write(': ping\n\n');
    },
    close() {
      if (!raw.writableEnded) raw.end();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function idOf(request: FastifyRequest): string {
  return (request.params as { id: string }).id;
}

/**
 * Where to resume from.
 *
 * `Last-Event-ID` is the standard header and takes precedence; `?since=` is the
 * explicit form, used by the `fetch`-based client that sets its own headers.
 */
function sinceOf(request: FastifyRequest): number {
  const header = request.headers['last-event-id'];
  const query = (request.query as { since?: string }).since;
  const raw = (typeof header === 'string' ? header : undefined) ?? query;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function isTerminalEvent(stored: StoredEvent): boolean {
  return stored.event.type === 'done' || stored.event.type === 'error';
}

function past(status: string): string {
  return status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'finished';
}
