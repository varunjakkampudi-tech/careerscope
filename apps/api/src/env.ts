/**
 * Configuration, parsed once at boot.
 *
 * Every setting the app reads goes through this schema, so a typo in a variable
 * name fails immediately with a message naming the variable — rather than three
 * minutes into a search run, as `undefined` reaching an HTTP client.
 *
 * Two rules hold throughout:
 *
 *  - **Nothing here is ever logged or returned.** `/api/sources` reports whether
 *    a key is *present*, never its value. `redactedEnv()` exists for the boot
 *    banner and reports the same way.
 *  - **A missing optional key disables a feature, it does not crash the app.**
 *    The keyless ATS and remote boards are the product's floor: a first run with
 *    an empty `.env` still finds real jobs.
 */

import { z } from 'zod';
import { localModelOrigin } from './services/ollamaRerank.js';

/** `"true"`/`"1"`/`"yes"` are all how people actually write booleans in a .env. */
const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      return /^(1|true|yes|on)$/i.test(value.trim());
    });

const port = z.coerce.number().int().min(1).max(65_535);

/** Trimmed, and empty-string becomes undefined — `KEY=` in a .env means "unset". */
const secret = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === '' ? undefined : value));

const csv = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim() === ''
        ? fallback
        : value
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
    );

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: port.default(8080),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    /** Where the database, uploaded resumes and exports live. */
    DATA_DIR: z.string().default('./data'),

    /* ---- Auth ------------------------------------------------------------ */

    /**
     * The single app key, compared against the `x-api-key` header. Required in
     * production; see the refinement below.
     */
    APP_API_KEY: secret,
    /** Local convenience only. Refused in production. */
    AUTH_DISABLED: boolish(false),
    LOGIN_ENABLED: boolish(true),
    AUTH_ORIGIN: z.string().url().default('http://localhost:5173'),
    TRUST_PROXY: boolish(false),

    /**
     * Browser origins allowed to call the API. The GitHub Pages origin belongs
     * here for the split deploy; a same-origin deploy needs none.
     */
    CORS_ORIGINS: csv([]),

    /* ---- Feature flags --------------------------------------------------- */

    /**
     * Playwright scrapers. Off by default: they need a logged-in session, a
     * headful browser, and they carry the most terms-of-service risk of
     * anything in the app.
     */
    ENABLE_SCRAPERS: boolish(false),
    /** Optional semantic rerank; paid credentials are required only for Anthropic. */
    ENABLE_LLM_RERANK: boolish(false),
    LLM_PROVIDER: z.enum(['anthropic', 'ollama']).default('anthropic'),
    LLM_MODEL: secret,
    OLLAMA_ORIGIN: z
      .string()
      .default('http://127.0.0.1:11434')
      .refine((value) => {
        try {
          localModelOrigin(value);
          return true;
        } catch {
          return false;
        }
      }, 'Use a local HTTP model origin without credentials or paths'),
    ENABLE_APPLICATION_AGENT: boolish(false),
    APPLICATION_COPILOT_PATH: secret,

    /* ---- Provider credentials ------------------------------------------- */

    ADZUNA_APP_ID: secret,
    ADZUNA_APP_KEY: secret,
    JOOBLE_API_KEY: secret,
    RAPIDAPI_KEY: secret,
    GMAIL_CLIENT_ID: secret,
    GMAIL_CLIENT_SECRET: secret,
    GMAIL_REFRESH_TOKEN: secret,
    ANTHROPIC_API_KEY: secret,

    /* ---- Tuning ---------------------------------------------------------- */

    /** How many provider searches run at once inside a single run. */
    SEARCH_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
    SEARCH_INTERVAL_MINUTES: z.coerce
      .number()
      .int()
      .min(0)
      .max(10_080)
      .default(0)
      .refine((value) => value === 0 || value >= 360, 'Use 0 to disable, or at least 360 minutes'),
    /** A run is abandoned after this long, so a wedged board cannot hang a queue. */
    RUN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(3_600_000)
      .default(15 * 60_000),
    HTTP_CACHE_TTL_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(10 * 60_000),

    /** Serve the built SPA from the API, for a single-origin deploy. */
    SERVE_WEB: boolish(false),
    WEB_DIST: z.string().default('../web/dist'),
  })
  .superRefine((env, ctx) => {
    // Deliberately a hard failure rather than a warning. An unauthenticated
    // instance on a public EC2 box exposes the resume, the profile and every
    // configured key's blast radius; that must not be reachable by forgetting
    // to set one variable.
    if (env.NODE_ENV === 'production' && env.AUTH_DISABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_DISABLED'],
        message: 'AUTH_DISABLED cannot be true in production',
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      !env.AUTH_DISABLED &&
      !env.LOGIN_ENABLED &&
      !env.APP_API_KEY
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_API_KEY'],
        message: 'APP_API_KEY is required in production (or set AUTH_DISABLED=true locally)',
      });
    }
    if (env.APP_API_KEY && env.APP_API_KEY.length < 24) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_API_KEY'],
        message: 'APP_API_KEY must be at least 24 characters',
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      env.LOGIN_ENABLED &&
      new URL(env.AUTH_ORIGIN).protocol !== 'https:'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_ORIGIN'],
        message: 'Production login requires an HTTPS AUTH_ORIGIN.',
      });
    }
    if (env.ENABLE_LLM_RERANK && env.LLM_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ANTHROPIC_API_KEY'],
        message: 'ENABLE_LLM_RERANK requires ANTHROPIC_API_KEY',
      });
    }
    // Half a key is worse than none: the provider would build a URL that 401s on
    // every request, and the user would see "Adzuna: 0 results" rather than
    // "Adzuna is not configured".
    if (Boolean(env.ADZUNA_APP_ID) !== Boolean(env.ADZUNA_APP_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADZUNA_APP_KEY'],
        message: 'ADZUNA_APP_ID and ADZUNA_APP_KEY must be set together',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** The credential subset the provider registry takes. */
export function providerCredentials(env: Env): Record<string, string> {
  const pairs: [string, string | undefined][] = [
    ['ADZUNA_APP_ID', env.ADZUNA_APP_ID],
    ['ADZUNA_APP_KEY', env.ADZUNA_APP_KEY],
    ['JOOBLE_API_KEY', env.JOOBLE_API_KEY],
    ['RAPIDAPI_KEY', env.RAPIDAPI_KEY],
    ['GMAIL_CLIENT_ID', env.GMAIL_CLIENT_ID],
    ['GMAIL_CLIENT_SECRET', env.GMAIL_CLIENT_SECRET],
    ['GMAIL_REFRESH_TOKEN', env.GMAIL_REFRESH_TOKEN],
  ];
  return Object.fromEntries(
    pairs.filter((pair): pair is [string, string] => pair[1] !== undefined),
  );
}

export class EnvError extends Error {
  constructor(readonly issues: z.ZodIssue[]) {
    const lines = issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    super(`Invalid configuration:\n${lines.join('\n')}`);
    this.name = 'EnvError';
  }
}

/**
 * Takes the source explicitly so tests never have to mutate `process.env` — a
 * mutation that leaks into every other test in the file.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) throw new EnvError(result.error.issues);
  return result.data;
}

/** Which secrets are present, for the boot log. Values never appear. */
export function redactedEnv(env: Env): Record<string, string | number | boolean> {
  const present = (value: string | undefined) => (value ? 'set' : 'unset');
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    dataDir: env.DATA_DIR,
    auth: env.LOGIN_ENABLED
      ? 'JWT login'
      : env.AUTH_DISABLED
        ? 'DISABLED'
        : present(env.APP_API_KEY),
    corsOrigins: env.CORS_ORIGINS.length,
    scrapers: env.ENABLE_SCRAPERS,
    llmRerank: env.ENABLE_LLM_RERANK,
    adzuna: present(env.ADZUNA_APP_ID),
    jooble: present(env.JOOBLE_API_KEY),
    rapidapi: present(env.RAPIDAPI_KEY),
    anthropic: present(env.ANTHROPIC_API_KEY),
    serveWeb: env.SERVE_WEB,
  };
}
