/**
 * The error shape the API speaks.
 *
 * Every failure — a bad request body, a missing lead, a provider that timed out,
 * an unhandled bug — leaves through `apiErrorSchema`:
 * `{ error: { code, message, details? } }`. One shape means the web client has
 * one error path rather than a guess per endpoint, and `code` is what it
 * branches on, because a message is for a person and may be reworded at any
 * time.
 *
 * The rule that matters for security is at the bottom, in `toApiError`: an
 * unexpected throw is reported as "Internal error" with the real cause logged
 * and *not* returned. A stack trace or a driver message tells an attacker about
 * the filesystem layout and the schema; it tells the user nothing they can act
 * on.
 */

import type { ApiError } from '@job-radar/shared';
import type { z, ZodError, ZodIssue, ZodTypeAny } from 'zod';

export class ApiProblem extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiProblem';
  }

  static badRequest(message: string, details?: unknown): ApiProblem {
    return new ApiProblem(400, 'bad_request', message, details);
  }

  static unauthorized(message = 'Missing or invalid API key'): ApiProblem {
    return new ApiProblem(401, 'unauthorized', message);
  }

  /** `what` is the noun, not a sentence: `notFound('Lead', id)`. */
  static notFound(what: string, id?: string): ApiProblem {
    return new ApiProblem(
      404,
      'not_found',
      id ? `${what} ${id} was not found` : `${what} not found`,
    );
  }

  static conflict(message: string): ApiProblem {
    return new ApiProblem(409, 'conflict', message);
  }

  static payloadTooLarge(message: string): ApiProblem {
    return new ApiProblem(413, 'payload_too_large', message);
  }

  static unsupportedMedia(message: string): ApiProblem {
    return new ApiProblem(415, 'unsupported_media_type', message);
  }

  static unprocessable(message: string, details?: unknown): ApiProblem {
    return new ApiProblem(422, 'unprocessable', message, details);
  }

  static serviceUnavailable(message: string): ApiProblem {
    return new ApiProblem(503, 'service_unavailable', message);
  }

  toJSON(): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/**
 * Parses input, or throws a 400 naming the fields that failed.
 *
 * The field list is returned to the client on purpose: unlike an internal
 * error, "expectedSalary must be a number" is entirely about data the caller
 * sent, and withholding it would just mean guessing.
 *
 * Generic over the *schema*, not over its output. Several of the query schemas
 * coerce and default (`leadQuerySchema` turns `"a,b"` into `string[]`), so their
 * input and output types differ; a `ZodType<T>` parameter pins both to `T` and
 * rejects exactly those schemas.
 */
export function parseOrThrow<S extends ZodTypeAny>(
  schema: S,
  value: unknown,
  what = 'request',
): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw ApiProblem.badRequest(`Invalid ${what}`, fieldErrors(result.error));
}

function fieldErrors(error: ZodError): { field: string; message: string }[] {
  return error.issues.map((issue: ZodIssue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Maps anything thrown into a status and a body.
 *
 * `logCause` receives the original error for everything that is not an
 * `ApiProblem` — those are already the intended, deliberate responses, and
 * logging them at error level would fill the log with 404s.
 */
export function toApiError(
  error: unknown,
  logCause: (error: unknown) => void,
): { statusCode: number; body: ApiError } {
  if (error instanceof ApiProblem) {
    return { statusCode: error.statusCode, body: error.toJSON() };
  }

  // Fastify's own failures — body too large, malformed JSON, rate limit — carry
  // a status and a stable code, and are safe to pass through: they describe the
  // request, not the server.
  const fastifyError = asFastifyError(error);
  if (fastifyError) {
    logCause(error);
    return {
      statusCode: fastifyError.statusCode,
      body: { error: { code: fastifyError.code.toLowerCase(), message: fastifyError.message } },
    };
  }

  logCause(error);
  return {
    statusCode: 500,
    body: { error: { code: 'internal_error', message: 'Internal error' } },
  };
}

interface FastifyLikeError {
  statusCode: number;
  code: string;
  message: string;
}

function asFastifyError(error: unknown): FastifyLikeError | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as Partial<FastifyLikeError>;
  if (typeof candidate.statusCode !== 'number' || typeof candidate.code !== 'string') return null;
  // 5xx from a plugin is still an internal fault; only client-directed statuses
  // are safe to echo.
  if (candidate.statusCode < 400 || candidate.statusCode >= 500) return null;
  return {
    statusCode: candidate.statusCode,
    code: candidate.code,
    message: typeof candidate.message === 'string' ? candidate.message : 'Request failed',
  };
}
