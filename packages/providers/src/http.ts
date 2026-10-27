/**
 * The one HTTP client every provider uses.
 *
 * Job boards are not hostile, but they are fragile, rate-limited and prone to
 * the occasional 502. Four behaviours live here so that providers do not each
 * reinvent them (used by every adapter, and typed through `types.ts`):
 *
 *   - **Retry with backoff**, on the statuses that are genuinely transient and
 *     no others. A 404 is an answer; retrying it just wastes the user's time.
 *   - **Per-host pacing.** Requests to the same host are spaced by a minimum
 *     interval, so fanning out over 200 Greenhouse boards does not look like an
 *     attack and does not earn a ban.
 *   - **Response caching and in-flight de-duplication.** Two providers asking
 *     the same URL in the same run pay for one request.
 *   - **Hard limits.** A timeout on every request and a ceiling on body size,
 *     so one misbehaving board cannot hang or exhaust a run.
 *
 * Every side-effecting dependency — `fetch`, `sleep`, the clock, the jitter
 * source — is injectable, which is what makes the retry and pacing logic
 * testable in milliseconds instead of minutes.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** `http` is a non-2xx status or bad body, `aborted` is caller cancellation, `too-large` is the body cap. */
export type HttpErrorKind = 'http' | 'network' | 'timeout' | 'aborted' | 'too-large';

/**
 * Every failure out of this module is an `HttpError`, so provider code has one
 * shape to catch and `kind` to branch on — rather than guessing whether a
 * `TypeError` from `fetch` meant DNS failure or a programming mistake.
 */
export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly status: number | null;
  readonly url: string;
  /** First part of the response body, when there was one. Useful in logs. */
  readonly body: string;
  readonly retryable: boolean;
  /** What the server asked us to wait, from `Retry-After`, when it said. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    init: {
      kind: HttpErrorKind;
      url: string;
      status?: number | null;
      body?: string;
      retryable?: boolean;
      retryAfterMs?: number | null;
      cause?: unknown;
    },
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'HttpError';
    this.kind = init.kind;
    this.url = init.url;
    this.status = init.status ?? null;
    this.body = init.body ?? '';
    this.retryable = init.retryable ?? false;
    this.retryAfterMs = init.retryAfterMs ?? null;
  }
}

/** True when a run was cancelled, as opposed to a source failing. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof HttpError) return error.kind === 'aborted';
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'CancelledError');
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** Every field is optional; defaults are in `DEFAULTS`. Time and randomness are injectable for tests. */
export interface HttpClientOptions {
  fetch?: FetchLike;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Jitter source. Injected so retry timing is deterministic under test. */
  random?: () => number;
  /**
   * Identifies the app rather than impersonating a browser. Several boards
   * (RemoteOK notably) reject the default Node agent outright.
   */
  userAgent?: string;
  timeoutMs?: number;
  /** Retries *after* the first attempt, so 2 means up to 3 requests. */
  retries?: number;
  /** Minimum gap between requests to the same host. */
  minIntervalMs?: number;
  /** First backoff step; doubles per attempt up to `maxBackoffMs`. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  maxBytes?: number;
}

/** Per-request overrides of the client defaults. */
export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Bypass the response cache — for endpoints where staleness would mislead. */
  noCache?: boolean;
  timeoutMs?: number;
  retries?: number;
  /**
   * Statuses to hand back instead of throwing. A board answering 404 for an
   * unknown company slug is information, not an error.
   */
  acceptStatuses?: readonly number[];
  /**
   * Raise the body ceiling for one endpoint that legitimately needs it. Ashby
   * returns its whole board — descriptions included — in a single response, and
   * a large employer's board really is 12 MB. The default stays low so that a
   * board which is large *by malfunction* still gets cut off.
   */
  maxBytes?: number;
}

/** A completed response with the body already read as text and header names lower-cased. */
export interface HttpResponse {
  status: number;
  url: string;
  body: string;
  headers: Record<string, string>;
  /** True when served from the response cache rather than the network. */
  fromCache: boolean;
}

const DEFAULT_USER_AGENT =
  'CareerScope/1.0 (+https://github.com/varunjakkampudi-tech/careerscope; personal job search tool)';

/** Client defaults: 20 s timeout, 2 retries, 250 ms per-host spacing, 10 minute cache, 8 MiB body cap. */
const DEFAULTS = {
  timeoutMs: 20_000,
  retries: 2,
  minIntervalMs: 250,
  baseBackoffMs: 500,
  maxBackoffMs: 15_000,
  cacheTtlMs: 10 * 60 * 1000,
  maxCacheEntries: 500,
  maxBytes: 8 * 1024 * 1024,
} as const;

/** Transient by nature: worth another attempt. Everything else is an answer. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

/** A cached response and the time it stops being served. */
interface CacheEntry {
  expiresAt: number;
  response: HttpResponse;
}

/**
 * Rate-limited, retrying, caching HTTP client. One instance should be shared across a run so that
 * pacing, caching and in-flight de-duplication apply across providers.
 */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly userAgent: string;
  private readonly config: Required<
    Pick<
      HttpClientOptions,
      | 'timeoutMs'
      | 'retries'
      | 'minIntervalMs'
      | 'baseBackoffMs'
      | 'maxBackoffMs'
      | 'cacheTtlMs'
      | 'maxCacheEntries'
      | 'maxBytes'
    >
  >;

  /** Insertion-ordered, so the oldest key is always the first one out. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Identical GETs in flight at once share a single request. */
  private readonly inFlight = new Map<string, Promise<HttpResponse>>();
  /** Tail of the pacing chain per host. */
  private readonly hostGate = new Map<string, Promise<void>>();

  constructor(options: HttpClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.config = {
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      retries: options.retries ?? DEFAULTS.retries,
      minIntervalMs: options.minIntervalMs ?? DEFAULTS.minIntervalMs,
      baseBackoffMs: options.baseBackoffMs ?? DEFAULTS.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
      cacheTtlMs: options.cacheTtlMs ?? DEFAULTS.cacheTtlMs,
      maxCacheEntries: options.maxCacheEntries ?? DEFAULTS.maxCacheEntries,
      maxBytes: options.maxBytes ?? DEFAULTS.maxBytes,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Public surface                                                         */
  /* ---------------------------------------------------------------------- */

  /** GET with caching and in-flight de-duplication. Throws `HttpError` unless the status is accepted. */
  async get(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    return this.cached('GET', url, undefined, options);
  }

  /** GET and return only the body text. */
  async getText(url: string, options: RequestOptions = {}): Promise<string> {
    return (await this.get(url, options)).body;
  }

  /**
   * Parses the body as JSON. Throws an `HttpError` rather than a bare
   * `SyntaxError` when a board answers HTML — usually a captcha or a login wall
   * — so the caller sees which URL misbehaved.
   */
  async getJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.get(url, {
      ...options,
      headers: { accept: 'application/json', ...options.headers },
    });
    return parseJson<T>(response);
  }

  /** POST a JSON body and parse the JSON reply. Never cached, since a POST may not be idempotent. */
  async postJson<T>(url: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    const response = await this.request('POST', url, JSON.stringify(body ?? {}), {
      ...options,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...options.headers,
      },
    });
    return parseJson<T>(response);
  }

  /**
   * Does this URL exist? Lets a caller confirm a link before recording it,
   * which is the difference between a verified link and a guess. Never throws
   * for an HTTP status or a network failure: a dead host is simply `ok: false`,
   * because "we could not confirm it" is the answer either way. Cancellation
   * still throws.
   */
  async probe(
    url: string,
    options: RequestOptions = {},
  ): Promise<{
    ok: boolean;
    status: number | null;
    finalUrl: string;
  }> {
    try {
      const response = await this.get(url, { ...options, acceptStatuses: ALL_STATUSES });
      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        finalUrl: response.url,
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { ok: false, status: error instanceof HttpError ? error.status : null, finalUrl: url };
    }
  }

  /** Drops cached responses. Exposed for long-lived processes and for tests. */
  clearCache(): void {
    this.cache.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Cache + de-duplication                                                 */
  /* ---------------------------------------------------------------------- */

  private async cached(
    method: 'GET',
    url: string,
    body: string | undefined,
    options: RequestOptions,
  ): Promise<HttpResponse> {
    if (options.noCache || this.config.cacheTtlMs <= 0) {
      return this.request(method, url, body, options);
    }

    // The key ignores headers, so the same URL requested with different headers shares one entry.
    // Pass `noCache` where that would be wrong.
    const key = `${method} ${url}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) {
      // Re-insert so the freshest use is the newest key: plain LRU.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return { ...hit.response, fromCache: true };
    }
    if (hit) this.cache.delete(key);

    const pending = this.inFlight.get(key);
    if (pending) return { ...(await pending), fromCache: true };

    const promise = this.request(method, url, body, options);
    this.inFlight.set(key, promise);
    try {
      const response = await promise;
      this.store(key, response);
      return response;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private store(key: string, response: HttpResponse): void {
    this.cache.set(key, {
      expiresAt: this.now() + this.config.cacheTtlMs,
      response: { ...response, fromCache: false },
    });
    while (this.cache.size > this.config.maxCacheEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Retry loop                                                             */
  /* ---------------------------------------------------------------------- */

  private async request(
    method: string,
    url: string,
    body: string | undefined,
    options: RequestOptions,
  ): Promise<HttpResponse> {
    const retries = options.retries ?? this.config.retries;
    let lastError: HttpError | undefined;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (options.signal?.aborted) throw abortError(url);

      try {
        return await this.attempt(method, url, body, options);
      } catch (error) {
        if (isAbortError(error) && options.signal?.aborted) throw error;

        const failure =
          error instanceof HttpError
            ? error
            : new HttpError(describe(error), {
                kind: 'network',
                url,
                retryable: true,
                cause: error,
              });

        if (!failure.retryable || attempt === retries) throw failure;
        lastError = failure;

        await this.sleep(this.backoffFor(attempt, failure), options.signal);
      }
    }

    // Unreachable: the loop either returns or throws. Kept so the signature is
    // honest to the compiler rather than relying on a non-null assertion.
    throw lastError ?? new HttpError('request failed', { kind: 'network', url });
  }

  /**
   * How long to wait before the next attempt. A `Retry-After` from the server is
   * authoritative — it is the one number that reflects what the board actually
   * wants. Otherwise: exponential backoff with full jitter, which spreads a
   * fan-out's retries instead of synchronising them into a second stampede.
   */
  private backoffFor(attempt: number, failure: HttpError): number {
    const advertised =
      failure.status === 429 || failure.status === 503 ? failure.retryAfterMs : null;
    if (advertised !== null && advertised !== undefined) {
      return Math.min(advertised, this.config.maxBackoffMs);
    }
    const ceiling = Math.min(this.config.baseBackoffMs * 2 ** attempt, this.config.maxBackoffMs);
    return Math.round(ceiling * (0.5 + this.random() * 0.5));
  }

  /* ---------------------------------------------------------------------- */
  /* One attempt                                                            */
  /* ---------------------------------------------------------------------- */

  private async attempt(
    method: string,
    url: string,
    body: string | undefined,
    options: RequestOptions,
  ): Promise<HttpResponse> {
    await this.pace(url, options.signal);

    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    // Combine the caller's cancellation with the timeout so either one aborts the fetch.
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          'user-agent': this.userAgent,
          'accept-language': 'en-US,en;q=0.9',
          ...options.headers,
        },
        ...(body === undefined ? {} : { body }),
        signal,
        redirect: 'follow',
      });
    } catch (error) {
      if (timeout.aborted) {
        throw new HttpError(`timed out after ${timeoutMs}ms`, {
          kind: 'timeout',
          url,
          retryable: true,
          cause: error,
        });
      }
      if (options.signal?.aborted) throw abortError(url);
      throw new HttpError(describe(error), { kind: 'network', url, retryable: true, cause: error });
    }

    const headers = headersToObject(response.headers);
    const maxBytes = options.maxBytes ?? this.config.maxBytes;
    const declared = Number(headers['content-length'] ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HttpError(`response is ${declared} bytes, over the ${maxBytes} limit`, {
        kind: 'too-large',
        url,
        status: response.status,
      });
    }

    const text = await this.readBody(response, url, signal, options.signal, maxBytes);

    const accepted = options.acceptStatuses;
    const isAccepted = accepted === ALL_STATUSES || accepted?.includes(response.status);
    if (!response.ok && !isAccepted) {
      throw new HttpError(`HTTP ${response.status} for ${url}`, {
        kind: 'http',
        url,
        status: response.status,
        body: text.slice(0, 500),
        retryable: RETRYABLE_STATUSES.has(response.status),
        retryAfterMs: parseRetryAfter(headers['retry-after'], this.now()),
      });
    }

    return {
      status: response.status,
      url: response.url || url,
      body: text,
      headers,
      fromCache: false,
    };
  }

  private async readBody(
    response: Response,
    url: string,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<string> {
    const tooLarge = () =>
      new HttpError(`response body exceeded the ${maxBytes} byte limit`, {
        kind: 'too-large',
        url,
        status: response.status,
      });

    let text: string;
    try {
      if (response.body === null) {
        text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > maxBytes) throw tooLarge();
      } else {
        // Stream with a running byte count, so a board that omits or lies about
        // content-length is cut off at the cap instead of being buffered whole.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let received = 0;
        let collected = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw tooLarge();
          }
          collected += decoder.decode(value, { stream: true });
        }
        text = collected + decoder.decode();
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (callerSignal?.aborted) throw abortError(url);
      if (signal.aborted) {
        throw new HttpError('timed out while reading the response', {
          kind: 'timeout',
          url,
          retryable: true,
          cause: error,
        });
      }
      throw new HttpError(describe(error), { kind: 'network', url, retryable: true, cause: error });
    }

    return text;
  }

  /* ---------------------------------------------------------------------- */
  /* Per-host pacing                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Wait for this host's turn. Each host keeps a promise chain; a new request
   * links onto the tail and resolves `minIntervalMs` after the previous one
   * started. Hosts do not block each other, so a slow board never stalls a fast
   * one — the fan-out stays wide, it just stays polite per domain.
   */
  private async pace(url: string, signal: AbortSignal | undefined): Promise<void> {
    if (this.config.minIntervalMs <= 0) return;

    const host = hostOf(url);
    const previous = this.hostGate.get(host) ?? Promise.resolve();
    // The next caller waits on our slot, whether or not we ultimately succeed.
    const slot = previous.then(() => this.sleep(this.config.minIntervalMs).catch(() => undefined));
    this.hostGate.set(host, slot);

    await previous.catch(() => undefined);
    if (signal?.aborted) throw abortError(url);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Sentinel for `acceptStatuses`: hand back whatever came, never throw. */
export const ALL_STATUSES: readonly number[] = Object.freeze([]);

/** Parse the body as JSON, wrapping empty and malformed bodies in an `HttpError` that names the URL. */
function parseJson<T>(response: HttpResponse): T {
  const text = response.body.trim();
  if (!text) {
    throw new HttpError('the response was empty where JSON was expected', {
      kind: 'http',
      url: response.url,
      status: response.status,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new HttpError(`the response was not valid JSON: ${describe(error)}`, {
      kind: 'http',
      url: response.url,
      status: response.status,
      body: text.slice(0, 500),
      cause: error,
    });
  }
  // Every board payload is an object or an array. A bare string, number or null
  // is refused here, at the edge, so adapters can read fields without first
  // wondering whether they were handed a primitive.
  if (!isJsonContainer(parsed)) {
    throw new HttpError('the response was JSON, but not an object or array', {
      kind: 'http',
      url: response.url,
      status: response.status,
      body: text.slice(0, 500),
    });
  }
  return parsed as T;
}

/** An object or array: the only JSON values a board payload can legitimately be. */
export function isJsonContainer(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** Flatten `Headers` to a plain object with lower-cased names. */
function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** `Retry-After` is either a delay in seconds or an HTTP date. Both appear. */
export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** Pacing key for a URL; an unparseable URL is used as its own key. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Error for a caller-initiated cancel; `isAbortError` recognises it so retries stop. */
function abortError(url: string): HttpError {
  return new HttpError('the run was cancelled', { kind: 'aborted', url });
}

/** Message text for any thrown value. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Abortable sleep; rejects as soon as the signal aborts so cancelled runs do not wait out a backoff. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HttpError('the run was cancelled', { kind: 'aborted', url: '' }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new HttpError('the run was cancelled', { kind: 'aborted', url: '' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
