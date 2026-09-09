/**
 * The run event stream.
 *
 * This is a hand-rolled SSE client, and it is hand-rolled for one specific
 * reason: **`EventSource` cannot set request headers.** The API key has to
 * travel in `x-api-key`, and the usual workaround — `?apiKey=…` — writes the
 * secret into nginx's access log, the browser's history, and the `Referer` of
 * everything the page loads next. `apps/api/src/routes/runs.ts` refuses a
 * query-string key for that reason, so the client pays for it here instead: a
 * `fetch` with a streaming body reader, and the framing parsed by hand.
 *
 * What `EventSource` gives away for free and is reimplemented below:
 *
 *  - **Frame parsing** — fields are `name: value` lines, frames end at a blank
 *    line, a line starting with `:` is a comment (the server's 20-second
 *    heartbeat) and multiple `data:` lines in one frame join with newlines.
 *  - **Reconnection with resume** — the server sends `id:` on every event, and a
 *    reconnect passes the last one back as `?since=`, so a dropped connection
 *    replays only what was missed rather than the whole run.
 *  - **The retry interval** — taken from the server's `retry:` line, with
 *    exponential backoff layered on top so a server that is down does not get
 *    hammered every three seconds.
 */

import type { RunEvent } from '@job-radar/shared';
import { apiUrl, authHeaders } from './api';

const DEFAULT_RETRY_MS = 3_000;
const MAX_RETRY_MS = 30_000;

/**
 * How many consecutive failures before giving up.
 *
 * Bounded rather than infinite because the run itself is bounded: if the stream
 * cannot be re-established after a minute of trying, the run has almost
 * certainly ended and the UI is better off falling back to polling
 * `GET /api/runs/:id` than spinning forever on a connection that will not come
 * back.
 */
const MAX_ATTEMPTS = 8;

export interface RunStreamHandlers {
  onEvent: (event: RunEvent) => void;
  /** Fired on every successful (re)connect, so the UI can drop a "reconnecting" banner. */
  onOpen?: () => void;
  /** Fired when the stream gives up for good. Not fired on ordinary reconnects. */
  onError?: (error: Error) => void;
}

/**
 * Subscribes to a run's events. Returns a function that closes the stream.
 *
 * The returned closer is safe to call at any point, including before the first
 * connection is established — which is what React's effect cleanup does when a
 * component unmounts during the initial fetch.
 */
export function openRunStream(runId: string, handlers: RunStreamHandlers): () => void {
  const controller = new AbortController();
  let lastEventId = 0;
  let retryMs = DEFAULT_RETRY_MS;
  let attempts = 0;
  let finished = false;

  const parser = createFrameParser({
    onId: (id) => {
      lastEventId = id;
    },
    onRetry: (ms) => {
      retryMs = ms;
    },
    onData: (data) => {
      let event: RunEvent;
      try {
        event = JSON.parse(data) as RunEvent;
      } catch {
        // A truncated frame is not worth tearing the stream down for — the next
        // one will be intact, and dropping this one loses at most a progress
        // tick.
        return;
      }

      handlers.onEvent(event);
      // `done` and `error` are terminal. The server closes after them; marking
      // it here stops the loop from treating that close as a drop and
      // reconnecting to replay a run that has already ended.
      if (event.type === 'done' || event.type === 'error') finished = true;
    },
  });

  void (async () => {
    while (!finished && !controller.signal.aborted && attempts < MAX_ATTEMPTS) {
      try {
        await connect();
        // A clean close without a terminal event means the connection dropped
        // mid-run — reconnect from `lastEventId` rather than starting over.
        if (finished || controller.signal.aborted) return;
      } catch (error) {
        if (controller.signal.aborted) return;
        attempts += 1;
        if (attempts >= MAX_ATTEMPTS) {
          handlers.onError?.(asError(error));
          return;
        }
      }

      await delay(backoff(retryMs, attempts), controller.signal);
    }
  })();

  async function connect(): Promise<void> {
    const response = await fetch(
      apiUrl(`/runs/${encodeURIComponent(runId)}/events`, {
        since: lastEventId > 0 ? lastEventId : undefined,
      }),
      {
        headers: authHeaders({ accept: 'text/event-stream' }),
        signal: controller.signal,
        credentials: 'include',
        // Some proxies and Chrome's own cache will happily serve a stale stream
        // body; this makes the request unambiguous.
        cache: 'no-store',
      },
    );

    if (!response.ok || !response.body) {
      throw new Error(`Event stream failed with ${response.status}`);
    }

    attempts = 0;
    handlers.onOpen?.();

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) parser.push(value);
      }
    } finally {
      // Releasing matters on the abort path: an un-released reader keeps the
      // response body alive, and with it the socket.
      reader.releaseLock();
    }
  }

  return () => {
    finished = true;
    controller.abort();
  };
}

/* -------------------------------------------------------------------------- */
/* SSE framing                                                                */
/* -------------------------------------------------------------------------- */

interface FrameCallbacks {
  onData: (data: string) => void;
  onId: (id: number) => void;
  onRetry: (ms: number) => void;
}

/**
 * Splits a byte stream into SSE frames.
 *
 * Stateful because a chunk boundary can fall anywhere — including in the middle
 * of a field name — so whatever is left after the last complete line is carried
 * into the next chunk.
 */
function createFrameParser(callbacks: FrameCallbacks): { push: (chunk: string) => void } {
  let buffer = '';
  let data: string[] = [];

  const flush = (): void => {
    if (data.length > 0) {
      callbacks.onData(data.join('\n'));
      data = [];
    }
  };

  return {
    push(chunk) {
      buffer += chunk;

      // The spec allows CR, LF or CRLF as a line terminator. Normalising once
      // here is cheaper than handling three cases in the split below.
      buffer = buffer.replace(/\r\n?/g, '\n');

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');

        // A blank line ends the frame.
        if (line === '') {
          flush();
          continue;
        }
        // A comment. The server's `: ping` heartbeat lands here and is ignored,
        // which is exactly what it is for — bytes on the wire so an idle proxy
        // does not close the connection.
        if (line.startsWith(':')) continue;

        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        // One optional leading space after the colon is part of the framing, not
        // the value.
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

        switch (field) {
          case 'data':
            data.push(value);
            break;
          case 'id': {
            const id = Number(value);
            if (Number.isFinite(id) && id > 0) callbacks.onId(id);
            break;
          }
          case 'retry': {
            const ms = Number(value);
            if (Number.isFinite(ms) && ms > 0) callbacks.onRetry(ms);
            break;
          }
          default:
            // `event:` is deliberately ignored — the payload carries its own
            // discriminated `type`, and trusting one source rather than two
            // means they can never disagree.
            break;
        }
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function backoff(base: number, attempts: number): number {
  const exponential = base * 2 ** Math.max(0, attempts - 1);
  // Jitter, so a reload of several tabs does not produce a synchronised burst.
  const jitter = Math.random() * base * 0.3;
  return Math.min(exponential + jitter, MAX_RETRY_MS);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
