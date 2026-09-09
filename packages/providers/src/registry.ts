/**
 * The provider registry.
 *
 * One place that knows every source, what it needs, and how to build it. The API
 * layer asks for a set of providers and gets back objects that are all the same
 * shape — the differences between an ATS walk, a feed walk and a keyed
 * fan-out stay behind `search()`.
 *
 * Two rules make the rest of the app simpler:
 *
 * **A source that cannot run is still listed.** Adzuna without a key is not
 * absent; it is present with an `unavailableReason` the settings screen renders.
 * Silently omitting it would leave the user wondering whether the app supports
 * the board at all, and it is the difference between "we found nothing" and "we
 * did not look".
 *
 * **Enabling a source cannot conjure a key.** `resolve()` filters by what the
 * caller asked for *and* by what is actually runnable, so a stale enabled-list
 * in the database can never produce a provider that throws on first request.
 */

import { ALL_SOURCES, type SourceId } from '@job-radar/shared';
import { createAshbyProvider } from './ats/ashby.js';
import { createGreenhouseProvider } from './ats/greenhouse.js';
import { createLeverProvider } from './ats/lever.js';
import { createRecruiteeProvider } from './ats/recruitee.js';
import { createSmartRecruitersProvider } from './ats/smartrecruiters.js';
import { createWorkableProvider } from './ats/workable.js';
import type { BoardRef } from './boards.js';
import { createGmailProvider } from './email/gmail.js';
import { createAdzunaProvider } from './keyed/adzuna.js';
import { createJoobleProvider } from './keyed/jooble.js';
import { createJSearchProvider } from './keyed/jsearch.js';
import { createHimalayasProvider } from './remote/himalayas.js';
import { createRemoteOkProvider } from './remote/remoteok.js';
import { createRemotiveProvider } from './remote/remotive.js';
import { createScrapeProvider } from './scrape/base.js';
import { indeedAdapter } from './scrape/indeed.js';
import { linkedinAdapter } from './scrape/linkedin.js';
import { naukriAdapter } from './scrape/naukri.js';
import { describeProvider, type JobProvider, type ProviderInfo } from './types.js';

export interface RegistryOptions {
  /**
   * Credential values by variable name — `process.env` at the call site. The
   * registry reads no ambient configuration of its own, so a test can build a
   * fully-keyed registry without touching the environment.
   */
  credentials?: Readonly<Record<string, string | undefined>>;
  /** Override the curated ATS board list. */
  boards?: readonly BoardRef[];
  /**
   * Country for the two aggregators that partition their index by market.
   * Defaults to India inside each adapter.
   */
  country?: string;
  /** Injected so recency filtering is deterministic under test. */
  now?: () => number;
  /**
   * Whether the Playwright scrapers may run. False by default and in every
   * hosted deployment: they are the ToS-riskiest surface in the app, so
   * enabling them is a deliberate act by whoever runs it.
   *
   * When false the three scrape sources are still listed, with
   * `SCRAPERS_DISABLED_REASON` — the registry's standing rule that "we did not
   * look" is never presented as "we found nothing".
   */
  enableScrapers?: boolean;
}

/**
 * Build every provider the app knows about, runnable or not.
 *
 * Order matters and is not alphabetical. The ATS boards come first because they
 * are the highest-quality leads — a full description and a direct apply link —
 * and a run that hits its result ceiling should hit it on those rather than on
 * an aggregator snippet. The scrapers come last for the same reason inverted:
 * they are the slowest and the most likely to be turned away, so nothing else
 * waits on them.
 */
export function createProviders(options: RegistryOptions = {}): JobProvider[] {
  const board = boardOptions(options);
  const keyed = keyedOptions(options);
  const scrape = scrapeOptions(options);

  return [
    createGreenhouseProvider(board),
    createLeverProvider(board),
    createAshbyProvider(board),
    createWorkableProvider(board),
    createSmartRecruitersProvider(board),
    createRecruiteeProvider(board),

    createRemotiveProvider(feedOptions(options)),
    createRemoteOkProvider(feedOptions(options)),
    createHimalayasProvider(feedOptions(options)),

    createJSearchProvider(keyed),
    createAdzunaProvider(keyed),
    createJoobleProvider(keyed),
    createGmailProvider(keyed),

    createScrapeProvider(linkedinAdapter, scrape),
    createScrapeProvider(naukriAdapter, scrape),
    createScrapeProvider(indeedAdapter, scrape),
  ];
}

/**
 * The providers to actually run, given what the user enabled.
 *
 * An empty or absent selection means "everything available", which is the right
 * default for a first run — the user has not yet had a reason to form an
 * opinion about which boards they want.
 */
export function resolveProviders(
  providers: readonly JobProvider[],
  enabled?: readonly SourceId[],
): JobProvider[] {
  const wanted = enabled && enabled.length > 0 ? new Set(enabled) : null;
  return providers.filter(
    (provider) =>
      provider.unavailableReason === null && (wanted === null || wanted.has(provider.id)),
  );
}

/** What `/api/sources` returns: every source, with its reason if it cannot run. */
export function describeProviders(providers: readonly JobProvider[]): ProviderInfo[] {
  return providers.map(describeProvider);
}

/**
 * A completeness check, run as a test rather than at startup.
 *
 * `ALL_SOURCES` is the vocabulary the database, the UI filters and the export
 * all share. A source declared there but never built would show up as a filter
 * that matches nothing, which is a confusing bug to chase from the UI end.
 *
 * Two are expected to have no provider: `foundit` and `cutshort` exist only as
 * provenance on the imported seed leads, so the vocabulary has to know their
 * names in order to store and display those records. Their absence here is
 * asserted exactly in the test, so it stays a decision rather than drift.
 */
export function missingProviders(providers: readonly JobProvider[]): SourceId[] {
  const built = new Set(providers.map((provider) => provider.id));
  return ALL_SOURCES.filter((id) => !built.has(id));
}

/* -------------------------------------------------------------------------- */
/* Option plumbing                                                            */
/* -------------------------------------------------------------------------- */

// Each family takes a different options shape, and `exactOptionalPropertyTypes`
// aside, an explicit `undefined` is not the same as an absent key to every
// consumer. These three builders add a property only when there is one.

function boardOptions(options: RegistryOptions): {
  boards?: readonly BoardRef[];
  now?: () => number;
} {
  const result: { boards?: readonly BoardRef[]; now?: () => number } = {};
  if (options.boards) result.boards = options.boards;
  if (options.now) result.now = options.now;
  return result;
}

function feedOptions(options: RegistryOptions): { now?: () => number } {
  return options.now ? { now: options.now } : {};
}

function scrapeOptions(options: RegistryOptions): {
  enableScrapers?: boolean;
  now?: () => number;
} {
  const result: { enableScrapers?: boolean; now?: () => number } = {};
  if (options.enableScrapers !== undefined) result.enableScrapers = options.enableScrapers;
  if (options.now) result.now = options.now;
  return result;
}

function keyedOptions(options: RegistryOptions): {
  credentials?: Readonly<Record<string, string | undefined>>;
  country?: string;
  now?: () => number;
} {
  const result: {
    credentials?: Readonly<Record<string, string | undefined>>;
    country?: string;
    now?: () => number;
  } = {};
  if (options.credentials) result.credentials = options.credentials;
  if (options.country) result.country = options.country;
  if (options.now) result.now = options.now;
  return result;
}
