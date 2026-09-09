/**
 * What this install can actually search.
 *
 * The search screen renders one toggle per source, and a toggle that lies is
 * worse than no toggle: the user picks Adzuna, waits four minutes and gets
 * nothing, with no way to learn that the key was never configured. So this
 * endpoint reports availability honestly and carries the reason in the payload.
 * It answers the same question for the server's feature switches, so a control
 * for something the operator turned off arrives disabled rather than failing on
 * submit.
 *
 * It is also the only place `ProviderInfo` is translated into `SourceInfo`.
 * The two disagree on names — `available`/`unavailableReason` against
 * `enabled`/`disabledReason` — and that is deliberate rather than an oversight
 * `enabled`/`disabledReason` — and that is deliberate rather than an oversight
 * waiting to be tidied away: the provider package answers "can this run", the
 * client schema answers "what should the toggle look like". Keeping them
 * separate means the UI's vocabulary can change without a provider edit. The
 * cost is this one adapter, which is the right place to pay it.
 */

import {
  API_SOURCES,
  SNIPPET_ONLY_SOURCES,
  type Capabilities,
  type SourceId,
  type SourceInfo,
} from '@job-radar/shared';
import { describeProviders } from '@job-radar/providers';
import type { FastifyInstance } from 'fastify';
import type { Env } from '../env.js';
import type { RouteOptions } from './index.js';

export async function sourcesRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { providers, env } = options.container;

  app.get('/sources', async () => ({
    sources: describeProviders(providers).map(toSourceInfo),
    capabilities: toCapabilities(env),
  }));
}

/**
 * Feature switches, as booleans and nothing else.
 *
 * Deliberately not `redactedEnv()` — that is a boot log for an operator and
 * names every secret slot. This crosses the network to a browser, so it carries
 * only what a control on the search screen needs to render itself honestly.
 */
export function toCapabilities(env: Env): Capabilities {
  return {
    llmRerank: env.ENABLE_LLM_RERANK,
    scrapers: env.ENABLE_SCRAPERS,
  };
}

interface ProviderInfoLike {
  id: SourceId;
  kind: SourceInfo['kind'];
  label: string;
  available: boolean;
  unavailableReason: string | null;
}

/** Exported so the MCP bridge reports availability in the same words the UI does. */
export function toSourceInfo(info: ProviderInfoLike): SourceInfo {
  return {
    id: info.id,
    label: info.label,
    kind: info.kind,
    enabled: info.available,
    // Membership of `API_SOURCES`, not "is currently missing a key" — the badge
    // has to read the same whether or not the key happens to be set, or it turns
    // into a second, redundant rendering of `enabled`.
    requiresKey: info.kind === 'email' || (API_SOURCES as readonly string[]).includes(info.id),
    disabledReason: info.unavailableReason,
    providesFullDescription: !SNIPPET_ONLY_SOURCES.includes(info.id),
  };
}
