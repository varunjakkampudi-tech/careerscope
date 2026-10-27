/**
 * The provider contract (`JobProvider`) and the context a host passes in. Implemented by every
 * adapter under `ats/`, `remote/`, `keyed/`, `email/` and `scrape/`, and used by `registry.ts`.
 *
 * Boards differ: some paginate, some return everything at once, some need a second request per
 * posting for the description. The interface hides that behind one async iterable so the search
 * orchestrator treats every source alike and a slow source streams its first results.
 */

import type { ProviderQuery, RawJob, SourceId, SourceKind } from '@careerscope/shared';
import type { HttpClient } from './http.js';

/** Everything a provider needs from its host to do work. */
export interface ProviderContext {
  http: HttpClient;
  /** Cancels the whole run. Providers pass it through to every request. */
  signal?: AbortSignal;
  /** Progress and trouble, surfaced to the user's run log. Never throws. */
  log?: (event: ProviderEvent) => void;
}

/** A log event emitted by a provider. `limited` marks a result truncated by a cap or rate limit. */
export type ProviderEvent =
  | { level: 'debug' | 'info'; source: SourceId; message: string; limited?: boolean }
  | { level: 'warn' | 'error'; source: SourceId; message: string };

/** One job source. Instances are built by `registry.ts` and consumed by the search worker. */
export interface JobProvider {
  readonly id: SourceId;
  readonly kind: SourceKind;
  readonly label: string;

  /**
   * Why this provider cannot run — a missing API key, a disabled feature flag —
   * or null when it is ready. The `/api/sources` endpoint renders this verbatim,
   * so it is written for the user rather than for a log file.
   */
  readonly unavailableReason: string | null;

  /**
   * Yield postings for one query. Implementations must:
   *
   *  - stop when `ctx.signal` aborts, without throwing;
   *  - stop after `query.maxResults` items;
   *  - report a failed page through `ctx.log` and keep going, rather than
   *    ending the run — a single dead board must not cost the user the rest.
   */
  search(query: ProviderQuery, ctx: ProviderContext): AsyncIterable<RawJob>;

  /**
   * Fill in a description the list endpoint did not include. Only implemented by
   * sources that genuinely have a detail endpoint; the orchestrator checks for
   * its presence before spending the request.
   */
  fetchDetail?(job: RawJob, ctx: ProviderContext): Promise<RawJob>;
}

/** What `/api/sources` shows in the search screen's source toggles. */
export interface ProviderInfo {
  id: SourceId;
  kind: SourceKind;
  label: string;
  available: boolean;
  unavailableReason: string | null;
}

/** Projects a provider onto the public shape served by the sources endpoint. */
export function describeProvider(provider: JobProvider): ProviderInfo {
  return {
    id: provider.id,
    kind: provider.kind,
    label: provider.label,
    available: provider.unavailableReason === null,
    unavailableReason: provider.unavailableReason,
  };
}
