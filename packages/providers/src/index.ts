/**
 * @job-radar/providers — every job source behind one interface.
 *
 * The API layer should need nothing from this package but `createProviders`,
 * `resolveProviders` and `normalizeJob`. Everything else is exported because
 * enrichment, the exporter and the tests genuinely reach for it — not as a
 * general invitation to depend on the internals of a particular board.
 */

/* The registry: what the API actually calls. */
export {
  createProviders,
  describeProviders,
  missingProviders,
  resolveProviders,
  type RegistryOptions,
} from './registry.js';

/* The contract every source implements. */
export {
  describeProvider,
  type JobProvider,
  type ProviderContext,
  type ProviderEvent,
  type ProviderInfo,
} from './types.js';

/* Raw board payload -> the record the rest of the app reads. */
export {
  canonicalCompany,
  canonicalLocation,
  canonicalTitle,
  companySlug,
  dedupeJobs,
  describeJob,
  employmentTypeFrom,
  jobFingerprint,
  mergeDuplicates,
  normalizeDate,
  normalizeJob,
  normalizeLocation,
  normalizeSalary,
  normalizeUrl,
  periodFrom,
  type NormalizeOptions,
} from './normalize.js';

/* HTTP, shared by every provider and by company enrichment. */
export {
  HttpClient,
  HttpError,
  isAbortError,
  type HttpClientOptions,
  type HttpErrorKind,
  type HttpResponse,
  type RequestOptions,
} from './http.js';

/* Markup and text, used by enrichment to read a careers page. */
export {
  decodeEntities,
  descriptionToText,
  extractCanonicalUrl,
  extractMailtoAddresses,
  htmlToText,
  isPlausibleEmail,
  looksLikeHtml,
  repairMojibake,
  snippet,
  tidyText,
} from './html.js';

/* The curated ATS board list, extended at runtime by board discovery. */
export { boardsFor, DEFAULT_BOARDS, mergeBoards, type BoardRef } from './boards.js';

/* Query filtering, exported so the orchestrator can pre-check a query. */
export {
  employmentTypeAllowed,
  hasExcludedKeyword,
  locationAllowed,
  matchesQuery,
  titleAllowed,
  titleRelevance,
  withinWindow,
  type FilterOptions,
} from './filter.js';

export { describeFailure, postedTime, rankByRelevance } from './rank.js';

/* Individual factories, for a caller that wants one board and not the set. */
export { createAshbyProvider } from './ats/ashby.js';
export { createGreenhouseProvider } from './ats/greenhouse.js';
export { createLeverProvider } from './ats/lever.js';
export { createRecruiteeProvider } from './ats/recruitee.js';
export { createSmartRecruitersProvider } from './ats/smartrecruiters.js';
export { createWorkableProvider } from './ats/workable.js';
export { createBoardProvider, type BoardAdapter, type BoardProviderOptions } from './ats/base.js';

export { createHimalayasProvider } from './remote/himalayas.js';
export { createRemoteOkProvider } from './remote/remoteok.js';
export { createRemotiveProvider } from './remote/remotive.js';
export { createFeedProvider, type FeedAdapter, type FeedProviderOptions } from './remote/base.js';

export { createAdzunaProvider, type AdzunaOptions } from './keyed/adzuna.js';
export { createJoobleProvider, type JoobleOptions } from './keyed/jooble.js';
export { createJSearchProvider, type JSearchOptions } from './keyed/jsearch.js';
export { createGmailVerificationReader, type VerificationRequest } from './email/verification.js';
export {
  createKeyedProvider,
  type KeyedAdapter,
  type KeyedPage,
  type KeyedPageRequest,
  type KeyedProviderOptions,
} from './keyed/base.js';

/*
 * The browser-backed sources. `closeSharedBrowser` is the one the API genuinely
 * needs: Chromium is process-wide and reference-counted, and a shutdown that
 * skips this leaves a browser behind that nothing in Node will come along and
 * reap.
 */
export {
  closeSharedBrowser,
  createScrapeProvider,
  SCRAPERS_DISABLED_REASON,
  type ScrapeAdapter,
  type ScrapeContext,
  type ScrapePage,
  type ScrapeProviderOptions,
} from './scrape/base.js';
export {
  describeEmptyOutcome,
  detectBlock,
  type BlockDetection,
  type BlockKind,
} from './scrape/block.js';
export {
  BrowserPool,
  isPlaywrightInstalled,
  PLAYWRIGHT_MISSING_REASON,
  resetPlaywrightDetection,
  type BrowserPoolOptions,
  type ScrapeSession,
} from './scrape/browser.js';
export { indeedAdapter, INDEED_CEILING_NOTE, type IndeedCard } from './scrape/indeed.js';
export { linkedinAdapter, type LinkedInCard } from './scrape/linkedin.js';
export { naukriAdapter, type NaukriJob } from './scrape/naukri.js';
