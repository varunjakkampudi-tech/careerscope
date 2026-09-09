/**
 * The curated ATS board list.
 *
 * ATS APIs are company-scoped: there is no "search Greenhouse" endpoint, only
 * "fetch Acme's board". So finding jobs on them means knowing which companies to
 * ask about, and that list is this file.
 *
 * **Every slug here was verified against the live API on 2026-09-05** and
 * returned at least one real posting. That discipline is not bookkeeping: an
 * unverified slug costs a 404 on every source, on every run, forever, and
 * silently teaches the run log to be noisy. Slugs are also not guessable — a
 * company's ATS token is frequently not its name (`epifi` for Fi, `jobs` for
 * Tellent), which is exactly why guessing produces a list of 404s.
 *
 * The list is a starting point, not a ceiling. `apps/api` extends it as company
 * enrichment detects ATS signatures on employers' own careers pages, so boards
 * discovered from real leads accumulate over time.
 *
 * `company` is carried explicitly because most of these APIs do not return one:
 * Lever, Ashby and Workable all answer with postings and no employer name
 * anywhere in the payload. Without this field every lead from them would read
 * "Unknown company".
 */

import type { AtsSource } from '@job-radar/shared';

export interface BoardRef {
  source: AtsSource;
  /** The board token in the API path. Often not the company's name. */
  slug: string;
  /** Display name. The only source of one for Lever, Ashby and Workable. */
  company: string;
}

/**
 * Boards whose postings are predominantly in India, listed first so a run that
 * hits its budget mid-list has already covered the user's home market.
 */
const INDIA_BOARDS: readonly BoardRef[] = [
  { source: 'greenhouse', slug: 'postman', company: 'Postman' },
  { source: 'greenhouse', slug: 'groww', company: 'Groww' },
  { source: 'greenhouse', slug: 'slice', company: 'Slice' },
  { source: 'greenhouse', slug: 'druva', company: 'Druva' },
  { source: 'greenhouse', slug: 'netradyne', company: 'Netradyne' },
  { source: 'greenhouse', slug: 'devrev', company: 'DevRev' },
  { source: 'greenhouse', slug: 'sigmoid', company: 'Sigmoid' },

  { source: 'lever', slug: 'cred', company: 'CRED' },
  { source: 'lever', slug: 'meesho', company: 'Meesho' },
  { source: 'lever', slug: 'porter', company: 'Porter' },
  { source: 'lever', slug: 'epifi', company: 'Fi Money' },
  { source: 'lever', slug: 'paytm', company: 'Paytm' },
  { source: 'lever', slug: 'mindtickle', company: 'Mindtickle' },

  { source: 'ashby', slug: 'atlan', company: 'Atlan' },
  { source: 'ashby', slug: 'skyflow', company: 'Skyflow' },
  { source: 'ashby', slug: 'tekion', company: 'Tekion' },
  { source: 'ashby', slug: 'bounce', company: 'Bounce' },

  { source: 'workable', slug: 'apna', company: 'Apna' },

  { source: 'smartrecruiters', slug: 'Freshworks', company: 'Freshworks' },
  { source: 'smartrecruiters', slug: 'swiggy', company: 'Swiggy' },
  { source: 'smartrecruiters', slug: 'mindtickle', company: 'Mindtickle' },
  { source: 'smartrecruiters', slug: 'shipsy', company: 'Shipsy' },
  { source: 'smartrecruiters', slug: 'unacademy', company: 'Unacademy' },
  { source: 'smartrecruiters', slug: 'whatfix', company: 'Whatfix' },
  { source: 'smartrecruiters', slug: 'upstox', company: 'Upstox' },
  { source: 'smartrecruiters', slug: 'turtlemint', company: 'Turtlemint' },
  { source: 'smartrecruiters', slug: 'netradyne', company: 'Netradyne' },
  { source: 'smartrecruiters', slug: 'newtonschool', company: 'Newton School' },
];

/**
 * Global boards. Most of these run large India engineering offices, so they are
 * not off-topic for an India-based search — they simply are not India-only.
 */
const GLOBAL_BOARDS: readonly BoardRef[] = [
  { source: 'greenhouse', slug: 'stripe', company: 'Stripe' },
  { source: 'greenhouse', slug: 'databricks', company: 'Databricks' },
  { source: 'greenhouse', slug: 'gitlab', company: 'GitLab' },
  { source: 'greenhouse', slug: 'cloudflare', company: 'Cloudflare' },
  { source: 'greenhouse', slug: 'mongodb', company: 'MongoDB' },
  { source: 'greenhouse', slug: 'zscaler', company: 'Zscaler' },
  { source: 'greenhouse', slug: 'okta', company: 'Okta' },
  { source: 'greenhouse', slug: 'anthropic', company: 'Anthropic' },
  { source: 'greenhouse', slug: 'coinbase', company: 'Coinbase' },
  { source: 'greenhouse', slug: 'twilio', company: 'Twilio' },
  { source: 'greenhouse', slug: 'samsara', company: 'Samsara' },
  { source: 'greenhouse', slug: 'affirm', company: 'Affirm' },
  { source: 'greenhouse', slug: 'instacart', company: 'Instacart' },
  { source: 'greenhouse', slug: 'lyft', company: 'Lyft' },
  { source: 'greenhouse', slug: 'pinterest', company: 'Pinterest' },
  { source: 'greenhouse', slug: 'reddit', company: 'Reddit' },
  { source: 'greenhouse', slug: 'discord', company: 'Discord' },
  { source: 'greenhouse', slug: 'airbnb', company: 'Airbnb' },
  { source: 'greenhouse', slug: 'dropbox', company: 'Dropbox' },
  { source: 'greenhouse', slug: 'figma', company: 'Figma' },
  { source: 'greenhouse', slug: 'asana', company: 'Asana' },
  { source: 'greenhouse', slug: 'airtable', company: 'Airtable' },
  { source: 'greenhouse', slug: 'robinhood', company: 'Robinhood' },
  { source: 'greenhouse', slug: 'gusto', company: 'Gusto' },
  { source: 'greenhouse', slug: 'duolingo', company: 'Duolingo' },
  { source: 'greenhouse', slug: 'faire', company: 'Faire' },
  { source: 'greenhouse', slug: 'sofi', company: 'SoFi' },
  { source: 'greenhouse', slug: 'webflow', company: 'Webflow' },

  { source: 'lever', slug: 'spotify', company: 'Spotify' },
  { source: 'lever', slug: 'palantir', company: 'Palantir' },
  { source: 'lever', slug: 'matchgroup', company: 'Match Group' },
  { source: 'lever', slug: 'ledger', company: 'Ledger' },

  { source: 'ashby', slug: 'openai', company: 'OpenAI' },
  { source: 'ashby', slug: 'notion', company: 'Notion' },
  { source: 'ashby', slug: 'ramp', company: 'Ramp' },
  { source: 'ashby', slug: 'linear', company: 'Linear' },
  { source: 'ashby', slug: 'supabase', company: 'Supabase' },
  { source: 'ashby', slug: 'replit', company: 'Replit' },
  { source: 'ashby', slug: 'cohere', company: 'Cohere' },
  { source: 'ashby', slug: 'elevenlabs', company: 'ElevenLabs' },
  { source: 'ashby', slug: 'harvey', company: 'Harvey' },
  { source: 'ashby', slug: 'posthog', company: 'PostHog' },
  { source: 'ashby', slug: 'airbyte', company: 'Airbyte' },
  { source: 'ashby', slug: 'baseten', company: 'Baseten' },
  { source: 'ashby', slug: 'modal', company: 'Modal' },
  { source: 'ashby', slug: 'sardine', company: 'Sardine' },
  { source: 'ashby', slug: 'warp', company: 'Warp' },
  { source: 'ashby', slug: 'runway', company: 'Runway' },
  { source: 'ashby', slug: 'ashby', company: 'Ashby' },

  { source: 'workable', slug: 'moneyfarm', company: 'Moneyfarm' },

  { source: 'recruitee', slug: 'jobs', company: 'Tellent' },
];

/** India-first, then global. Order is the fetch order. */
export const DEFAULT_BOARDS: readonly BoardRef[] = [...INDIA_BOARDS, ...GLOBAL_BOARDS];

/** The boards one ATS provider is responsible for. */
export function boardsFor(
  source: AtsSource,
  boards: readonly BoardRef[] = DEFAULT_BOARDS,
): BoardRef[] {
  return boards.filter((board) => board.source === source);
}

/**
 * Merge discovered boards into the curated list, keeping the curated entry when
 * both exist — a verified display name beats one scraped off a careers page.
 */
export function mergeBoards(
  base: readonly BoardRef[],
  discovered: readonly BoardRef[],
): BoardRef[] {
  const seen = new Map<string, BoardRef>();
  for (const board of [...base, ...discovered]) {
    const key = `${board.source}:${board.slug.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, board);
  }
  return [...seen.values()];
}
