/**
 * The dependency graph, built once.
 *
 * Everything the app needs is constructed here and passed down explicitly —
 * there is no module-level singleton, no ambient `process.env` read below
 * `env.ts`, and no service that reaches for a database handle it was not given.
 * The payoff is in the tests: a route test builds a container over an in-memory
 * database with a stub HTTP client and gets the real routes, the real
 * repositories and the real serialisation, without a network or a temp file.
 *
 * The wiring order below is the dependency order, and the two interesting edges
 * are worth naming:
 *
 *  - **Providers are built from a board list that grows at runtime.** Company
 *    enrichment sometimes discovers that an employer runs Greenhouse under a
 *    slug nobody would guess. That discovery is persisted and folded back in, so
 *    the *next run* queries the new board — see `absorbBoards`.
 *  - **The rerank client exists only when a key does.** Its absence is the
 *    entire opt-out mechanism: `SearchRunner` skips the pass when there is no
 *    client, so an install with no `ANTHROPIC_API_KEY` is not degraded, it is
 *    just deterministic.
 */

import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_RERANK_MODEL, type RerankClient } from '@job-radar/matching';
import {
  closeSharedBrowser,
  createGmailVerificationReader,
  createProviders,
  DEFAULT_BOARDS,
  HttpClient,
  mergeBoards,
  type BoardRef,
  type JobProvider,
} from '@job-radar/providers';
import { join } from 'node:path';
import { openDatabase, type Db } from './db/index.js';
import { createRepos, SETTING, type Repos } from './db/repo/index.js';
import { parseEnv, providerCredentials, type Env } from './env.js';
import { createLogger, type Logger } from './logger.js';
import { CompanyResolver } from './services/companyResolver.js';
import { ApplicationAgent } from './services/applicationAgent.js';
import { OllamaRerankClient } from './services/ollamaRerank.js';
import { RunEventBus } from './services/events.js';
import { RunQueue } from './services/queue.js';
import { SearchRunner } from './services/searchRunner.js';
import { startSearchScheduler } from './services/scheduler.js';
import { now } from './util/time.js';

/** Identifies the app to every board it talks to. Never impersonates a browser. */
const USER_AGENT = 'job-radar/1.0 (+https://github.com/job-radar)';

export interface Container {
  env: Env;
  logger: Logger;
  db: Db;
  repos: Repos;
  http: HttpClient;
  /** Every source this build knows about, available or not. */
  providers: readonly JobProvider[];
  events: RunEventBus;
  runner: SearchRunner;
  queue: RunQueue;
  applications: ApplicationAgent;
  /** Drains the queue and closes the database. Safe to call twice. */
  close(): Promise<void>;
}

export interface ContainerOptions {
  /** Overrides the path derived from `DATA_DIR`; `':memory:'` in tests. */
  databasePath?: string;
  /** Injected so route tests can build a container without a real logger. */
  logger?: Logger;
  /** Injected so provider tests never reach the network. */
  http?: HttpClient;
  clock?: () => string;
  startScheduler?: boolean;
  recoverOrphans?: boolean;
}

export function createContainer(env: Env = parseEnv(), options: ContainerOptions = {}): Container {
  const logger =
    options.logger ??
    createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });
  const clock = options.clock ?? now;

  const db = openDatabase(options.databasePath ?? join(env.DATA_DIR, 'job-radar.db'));
  const repos = createRepos(db, env.DATA_DIR);
  const applications = new ApplicationAgent(
    repos,
    env.DATA_DIR,
    clock,
    env.APPLICATION_COPILOT_PATH,
    createGmailVerificationReader(providerCredentials(env)),
  );

  // A restart leaves any run that was executing stuck at `running` with nobody
  // to finish it. Closing those here — before the first request is served — is
  // what stops the UI showing a progress bar that will never move again.
  const reaped = options.recoverOrphans === false ? 0 : repos.runs.reapOrphans(clock());
  if (reaped > 0) logger.warn({ reaped }, 'closed runs left mid-flight by a restart');

  const http =
    options.http ??
    new HttpClient({
      userAgent: USER_AGENT,
      cacheTtlMs: env.HTTP_CACHE_TTL_MS,
    });

  /**
   * The live provider list.
   *
   * Mutated in place by `absorbBoards` rather than replaced, because
   * `SearchRunner` holds this exact array. Rebuilding into a new array would
   * leave the runner pointing at the old one, and the newly discovered board
   * would never be queried — the bug this comment exists to prevent.
   */
  const providers: JobProvider[] = [];
  let boards = mergeBoards(
    DEFAULT_BOARDS,
    repos.settings.getJson<BoardRef[]>(SETTING.discoveredBoards, []),
  );

  const rebuild = (): void => {
    const built = createProviders({
      credentials: providerCredentials(env),
      boards,
      enableScrapers: env.ENABLE_SCRAPERS,
    });
    providers.splice(0, providers.length, ...built);
  };
  rebuild();

  const absorbBoards = (discovered: readonly BoardRef[]): void => {
    const merged = mergeBoards(boards, discovered);
    if (merged.length === boards.length) return;

    const added = merged.length - boards.length;
    boards = merged;
    // Only the non-curated remainder is persisted. Writing the whole list would
    // freeze today's curated set into the database, so a later release that
    // corrects a slug would be overridden by a stale copy of the old one.
    repos.settings.setJson(SETTING.discoveredBoards, extras(merged), clock());
    rebuild();
    logger.info({ added, boards: merged.length }, 'absorbed newly discovered ATS boards');
  };

  const events = new RunEventBus(repos.runs, clock);

  const resolver = new CompanyResolver({
    http,
    onWarning: (message) => logger.debug({ message }, 'company enrichment'),
  });

  const runner = new SearchRunner({
    repos,
    events,
    logger,
    http,
    providers,
    resolver,
    rerankClient: createRerankClient(env, logger),
    rerankModel:
      env.LLM_MODEL ??
      (env.LLM_PROVIDER === 'ollama' ? 'qwen2.5:1.5b-instruct-q4_K_M' : DEFAULT_RERANK_MODEL),
    ...(env.LLM_PROVIDER === 'ollama'
      ? { rerankLimits: { topN: 5, batchSize: 1, concurrency: 1 } }
      : {}),
    clock,
    onBoardsDiscovered: absorbBoards,
  });

  const queue = new RunQueue({
    repos,
    events,
    logger,
    runner,
    timeoutMs: env.RUN_TIMEOUT_MS,
    clock,
  });

  let closed = false;
  const stopScheduler =
    options.startScheduler === false
      ? undefined
      : startSearchScheduler({
          repos,
          queue,
          providers,
          logger,
          intervalMinutes: env.SEARCH_INTERVAL_MINUTES,
          enableLlmRerank: env.ENABLE_LLM_RERANK,
          clock,
        });
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stopScheduler?.();
    await applications.close();
    await queue.close();
    // After the queue, because that is what cancels the in-flight run — closing
    // the browser first would tear a live scrape's pages out from under it and
    // turn an orderly shutdown into a burst of navigation errors. A no-op when
    // no scrape source ever ran, which is the default.
    await closeSharedBrowser();
    db.close();
  };

  return { env, logger, db, repos, http, providers, events, runner, queue, applications, close };
}

/**
 * The selected semantic client, or nothing.
 *
 * `env.ts` requires a key for Anthropic and a local origin for Ollama. The
 * `undefined` branch means the feature is switched off.
 * That is the intended path, not a fallback: the deterministic engine is the
 * product, and the rerank is a second opinion on top of it.
 */
function createRerankClient(env: Env, logger: Logger): RerankClient | undefined {
  if (!env.ENABLE_LLM_RERANK) return undefined;
  logger.info({ provider: env.LLM_PROVIDER }, 'semantic rerank enabled');
  if (env.LLM_PROVIDER === 'ollama') return new OllamaRerankClient(env.OLLAMA_ORIGIN);
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

/** The boards that are not in the shipped list — the only part worth storing. */
function extras(merged: readonly BoardRef[]): BoardRef[] {
  const curated = new Set(
    DEFAULT_BOARDS.map((board) => `${board.source}:${board.slug.toLowerCase()}`),
  );
  return merged.filter((board) => !curated.has(`${board.source}:${board.slug.toLowerCase()}`));
}
