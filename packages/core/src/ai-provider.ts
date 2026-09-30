import { logger } from './runtime.js';

/**
 * CS-48: the first outbound-to-third-party AI capability CareerScope has
 * ever had. Deliberately a separate module from inference.ts (which stays
 * Ollama-only and hosted-provider-hostile by design) rather than a
 * repurposing of it. Off by default; fails clearly and closed on every
 * error path; never silently substitutes a paid model.
 *
 * Real System Designer and Security reviews (2026-09-23) shaped this file
 * directly - see .ai/backlog.json CS-48 evidence for the full text. Key
 * decisions carried over from those reviews:
 *   - redirect: 'manual' on every fetch (never 'follow') - a legitimate
 *     OpenRouter response is never a 3xx, and forwarding the Authorization
 *     header to an unexpected redirect target would leak the API key.
 *   - No DNS-pinning/redirect-hardening machinery (unlike CS-27's applyUrl
 *     handling) - openrouter.ai is a hardcoded literal never derived from
 *     request input, so that machinery would be over-engineering here, not
 *     under-engineering.
 *   - Every log call in this module builds an explicit minimal object
 *     (kind/status only) - never passes a raw request, response or Error
 *     object through, which could otherwise carry the Authorization header
 *     or response body into logs.
 *   - The model-catalog check has three cache states, not two:
 *     fetch-failure (short TTL - transient, worth re-checking soon),
 *     confirmed-present-and-free (long TTL - a fact), and
 *     confirmed-absent-or-no-longer-free (long TTL - also a fact, and
 *     conflating it with "fetch failed" would make a real policy change on
 *     OpenRouter's side look like our own network flakiness).
 */

// Overridable only for tests, via a real local HTTP server standing in for
// OpenRouter (the acceptance criteria requires a mocked endpoint, never a
// real OpenRouter call in CI) - production code never sets this to anything
// but the real, fixed OpenRouter hostname.
let OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export function _setBaseUrlForTests(url: string | undefined): void {
  OPENROUTER_BASE = url ?? 'https://openrouter.ai/api/v1';
}
const modelCatalogUrl = () => `${OPENROUTER_BASE}/models`;
const chatCompletionsUrl = () => `${OPENROUTER_BASE}/chat/completions`;

// Independent Security review, CS-48 (finding M1): the design review already
// required response-size bounding, but the original code only bounded the
// *extracted text field* after buffering and JSON-parsing the entire HTTP
// body. A compromised or misbehaving upstream returning a multi-MB body
// would still be fully buffered into memory first. This caps the raw byte
// count read from either OpenRouter endpoint before any JSON parsing is
// attempted, checking Content-Length up front when present and enforcing
// the same cap while streaming otherwise.
const MAX_RESPONSE_BYTES = 262_144; // 256 KiB: generous for a catalog page or one completion
class ResponseTooLargeError extends Error {}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new ResponseTooLargeError('OpenRouter response exceeded the size limit');
  }
  if (!response.body) return response.json();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ResponseTooLargeError('OpenRouter response exceeded the size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export type AiFailureKind =
  | 'disabled'
  | 'missing_key'
  | 'missing_model'
  | 'unauthorized'
  | 'payment_required'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'malformed_response'
  | 'model_unavailable'
  | 'model_no_longer_free';

export class AiProviderError extends Error {
  readonly kind: AiFailureKind;
  constructor(kind: AiFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export type AiConfig = {
  apiKey: string;
  model: string;
};

/**
 * CS-48 config contract: AI_ENABLED defaults to false and requires nothing
 * else. When true, OPENROUTER_API_KEY and OPENROUTER_MODEL are both
 * required, and OPENROUTER_MODEL must be a specific model id ending in
 * ':free' - the literal wildcard 'openrouter/free' is rejected outright,
 * since it can silently select a different model on different requests and
 * CareerScope needs reproducible behavior for testing and review.
 */
export function configuredAiProvider(
  source: NodeJS.ProcessEnv = process.env,
): AiConfig | undefined {
  const enabled = source.AI_ENABLED === 'true';
  if (!enabled) return undefined;
  const apiKey = source.OPENROUTER_API_KEY;
  const model = source.OPENROUTER_MODEL;
  if (!apiKey) throw new Error('AI_ENABLED=true requires OPENROUTER_API_KEY');
  if (!model) throw new Error('AI_ENABLED=true requires OPENROUTER_MODEL');
  if (model === 'openrouter/free') {
    throw new Error(
      'OPENROUTER_MODEL must be a specific model id, not the "openrouter/free" wildcard',
    );
  }
  if (!model.endsWith(':free')) {
    throw new Error('OPENROUTER_MODEL must end with ":free" for this initial implementation');
  }
  return { apiKey, model };
}

type CatalogState =
  | { kind: 'free'; checkedAt: number }
  | { kind: 'absent'; checkedAt: number }
  | { kind: 'not_free'; checkedAt: number }
  | { kind: 'fetch_failed'; checkedAt: number };

const FACT_TTL_MS = 5 * 60_000; // confirmed-present or confirmed-absent: a fact, cache longer
const FAILURE_TTL_MS = 15_000; // fetch failed: transient, re-check soon

// Single-flight: concurrent callers awaiting the same in-flight catalog
// fetch share one request rather than each starting their own (System
// Designer finding 1).
let catalogState: CatalogState | undefined;
let catalogInFlight: Promise<CatalogState> | undefined;

async function fetchCatalogState(model: string, timeoutMs: number): Promise<CatalogState> {
  try {
    const response = await fetch(modelCatalogUrl(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'OpenRouter model catalog fetch failed');
      return { kind: 'fetch_failed', checkedAt: Date.now() };
    }
    const body = (await readBoundedJson(response).catch((error) => {
      if (error instanceof ResponseTooLargeError) {
        logger.warn({ kind: 'response_too_large' }, 'OpenRouter model catalog response too large');
        return undefined;
      }
      throw error;
    })) as unknown;
    if (
      typeof body !== 'object' ||
      body === null ||
      !('data' in body) ||
      !Array.isArray((body as { data: unknown }).data)
    ) {
      logger.warn({ kind: 'malformed_response' }, 'OpenRouter model catalog response malformed');
      return { kind: 'fetch_failed', checkedAt: Date.now() };
    }
    const entries = (body as { data: unknown[] }).data;
    const entry = entries.find(
      (
        candidate,
      ): candidate is { id: string; pricing?: { prompt?: string; completion?: string } } =>
        typeof candidate === 'object' &&
        candidate !== null &&
        'id' in candidate &&
        (candidate as { id: unknown }).id === model,
    );
    if (!entry) return { kind: 'absent', checkedAt: Date.now() };
    const prompt = Number(entry.pricing?.prompt ?? '0');
    const completion = Number(entry.pricing?.completion ?? '0');
    const stillFree = prompt === 0 && completion === 0;
    return { kind: stillFree ? 'free' : 'not_free', checkedAt: Date.now() };
  } catch (error) {
    logger.warn(
      {
        kind:
          error instanceof DOMException && error.name === 'TimeoutError'
            ? 'timeout'
            : 'network_error',
      },
      'OpenRouter model catalog fetch failed',
    );
    return { kind: 'fetch_failed', checkedAt: Date.now() };
  }
}

function throwForCatalogState(state: CatalogState): never {
  if (state.kind === 'fetch_failed') {
    throw new AiProviderError(
      'server_error',
      'Could not verify the configured model with OpenRouter',
    );
  }
  if (state.kind === 'absent') {
    throw new AiProviderError(
      'model_unavailable',
      'Configured OpenRouter model is not in the current model catalog',
    );
  }
  throw new AiProviderError(
    'model_no_longer_free',
    'Configured OpenRouter model is no longer free',
  );
}

async function verifyModelIsFree(model: string, timeoutMs: number): Promise<void> {
  const now = Date.now();
  const ttl = catalogState?.kind === 'fetch_failed' ? FAILURE_TTL_MS : FACT_TTL_MS;
  if (catalogState && now - catalogState.checkedAt < ttl) {
    if (catalogState.kind === 'free') return;
    throwForCatalogState(catalogState);
  }
  catalogInFlight ??= fetchCatalogState(model, timeoutMs).finally(() => {
    catalogInFlight = undefined;
  });
  const result = await catalogInFlight;
  catalogState = result;
  if (result.kind === 'free') return;
  throwForCatalogState(result);
}

// Test-only hook: real code never needs to reset this cache, but a fresh
// process should not be required per test case.
export function _resetCatalogCacheForTests(): void {
  catalogState = undefined;
  catalogInFlight = undefined;
}

export type ChatCompletionRequest = {
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
};

const responseSchemaMaxLength = 4000;

/**
 * The one function every real AI use case in this codebase calls. Verifies
 * the configured model is still free before every real call (never trusts a
 * previous success indefinitely), then makes one bounded chat-completion
 * request. Sub-timeout budget: catalog check + completion call both stay
 * comfortably under Fastify's global 15s requestTimeout (System Designer
 * finding 3) - 4s for the catalog check, 8s for the completion call, always
 * leaving headroom for the rest of the request/response cycle.
 */
export async function requestCompletion(
  config: AiConfig,
  request: ChatCompletionRequest,
): Promise<string> {
  await verifyModelIsFree(config.model, 4_000);
  let response: Response;
  try {
    response = await fetch(chatCompletionsUrl(), {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: request.maxOutputTokens,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
      }),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    logger.warn({ kind: timedOut ? 'timeout' : 'network_error' }, 'OpenRouter request failed');
    throw new AiProviderError(
      timedOut ? 'timeout' : 'server_error',
      timedOut ? 'OpenRouter request timed out' : 'Could not reach OpenRouter',
    );
  }
  if (response.status === 401) {
    logger.warn({ status: 401 }, 'OpenRouter request unauthorized');
    throw new AiProviderError('unauthorized', 'OpenRouter rejected the configured API key');
  }
  if (response.status === 402) {
    logger.warn({ status: 402 }, 'OpenRouter request requires payment');
    throw new AiProviderError('payment_required', 'OpenRouter requires payment for this model');
  }
  if (response.status === 429) {
    logger.warn({ status: 429 }, 'OpenRouter request rate limited');
    throw new AiProviderError('rate_limited', 'OpenRouter rate limit reached');
  }
  if (response.status >= 500) {
    logger.warn({ status: response.status }, 'OpenRouter request failed');
    throw new AiProviderError('server_error', 'OpenRouter is currently unavailable');
  }
  if (!response.ok) {
    logger.warn({ status: response.status }, 'OpenRouter request failed');
    throw new AiProviderError('server_error', 'OpenRouter request failed');
  }
  let body: unknown;
  try {
    body = await readBoundedJson(response);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      logger.warn({ kind: 'response_too_large' }, 'OpenRouter response exceeded the size limit');
    } else {
      logger.warn({ kind: 'malformed_response' }, 'OpenRouter response was not valid JSON');
    }
    throw new AiProviderError('malformed_response', 'OpenRouter returned a malformed response');
  }
  const text = extractMessageText(body);
  if (text === undefined) {
    logger.warn({ kind: 'malformed_response' }, 'OpenRouter response missing expected shape');
    throw new AiProviderError('malformed_response', 'OpenRouter returned a malformed response');
  }
  return text.slice(0, responseSchemaMaxLength);
}

function extractMessageText(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('choices' in body)) return undefined;
  const choices = (body as { choices: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (typeof first !== 'object' || first === null || !('message' in first)) return undefined;
  const message = (first as { message: unknown }).message;
  if (typeof message !== 'object' || message === null || !('content' in message)) return undefined;
  const content = (message as { content: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}
