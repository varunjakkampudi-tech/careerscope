/**
 * Company enrichment — turning "Acme Corp" into a website, a careers portal and,
 * where the employer actually published one, a careers email.
 *
 * The rule this module exists to enforce is the one carried over from the
 * retired lead-collection script: **an address is either read off the
 * employer's own page or it does not exist.** No `careers@` + domain
 * construction, no pattern guessing, no "probably". A fabricated address does
 * not merely fail — it sends the user's application into a void while telling
 * them they applied, which is worse than showing nothing.
 *
 * So every field here traces to something observed:
 *
 *  - `atsType` / `atsPortalUrl` — read out of a URL the employer published.
 *    `jobs.lever.co/acme` *is* Acme's Lever board; that is not an inference.
 *  - `careersUrl` — a link found on the company's own homepage, or a path that
 *    answered 200. Never a path assumed to exist.
 *  - `careersEmail` — a real `mailto:` in the careers or contact page markup,
 *    and only when the local part is one a company uses for hiring. Marked
 *    `verified` because it was read, not derived.
 *  - `note` — what happened, in the user's words, so "no email" reads as "no
 *    careers email published on their site" rather than as a bug.
 *
 * Everything is budgeted. A run touches dozens of employers and each of them is
 * someone's small web server, so the resolver caps requests per company, runs a
 * handful of companies at a time, and gives up quietly rather than retrying its
 * way through a site that is not answering.
 */

import {
  HttpClient,
  extractMailtoAddresses,
  htmlToText,
  isAbortError,
  looksLikeHtml,
  normalizeUrl,
  type BoardRef,
} from '@job-radar/providers';
import type { AtsSource, Company, Confidence } from '@job-radar/shared';

/* -------------------------------------------------------------------------- */
/* What counts as a hiring address                                            */
/* -------------------------------------------------------------------------- */

/**
 * Local parts a company uses to receive applications.
 *
 * `info@` and `hello@` are deliberately absent. A general contact inbox is not a
 * careers inbox, and mailing a CV to one is how an application gets deleted by a
 * receptionist. The seed directory made the same call for the two `info@`
 * addresses it carried.
 */
const HIRING_LOCAL_PARTS = [
  'careers',
  'career',
  'jobs',
  'job',
  'hr',
  'recruitment',
  'recruiting',
  'recruit',
  'talent',
  'hiring',
  'apply',
  'work',
  'joinus',
  'join',
];

/** Addresses that are plainly not a person or a queue at the company. */
const EMAIL_BLOCKLIST = /^(?:no-?reply|do-?not-?reply|postmaster|abuse|privacy|dpo|legal)@/i;

/* -------------------------------------------------------------------------- */
/* ATS signatures                                                             */
/* -------------------------------------------------------------------------- */

interface AtsSignature {
  /** Null for platforms we recognise but do not have a provider for. */
  source: AtsSource | null;
  type: string;
  pattern: RegExp;
  /** Rebuilds the canonical board root from the captured slug. */
  portal: (slug: string) => string;
}

/**
 * Recognisers for the board URLs employers publish.
 *
 * The capture group is the board token, which is what makes an ATS hit worth
 * more than a link: a detected Greenhouse slug can be fed straight back into the
 * board list and searched directly on the next run, where it yields full job
 * descriptions and real apply URLs instead of an aggregator's snippet.
 *
 * Workday, iCIMS, Zoho, Keka, Freshteam and Darwinbox have no provider here, so
 * they resolve to a portal link only — still the difference between "apply on
 * their site" and a dead end.
 */
const ATS_SIGNATURES: readonly AtsSignature[] = [
  {
    source: 'greenhouse',
    type: 'greenhouse',
    pattern: /(?:job-)?boards(?:-api)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i,
    portal: (slug) => `https://job-boards.greenhouse.io/${slug}`,
  },
  {
    source: 'lever',
    type: 'lever',
    pattern: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i,
    portal: (slug) => `https://jobs.lever.co/${slug}`,
  },
  {
    source: 'ashby',
    type: 'ashby',
    pattern: /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i,
    portal: (slug) => `https://jobs.ashbyhq.com/${slug}`,
  },
  {
    source: 'workable',
    type: 'workable',
    pattern: /(?:apply|jobs)\.workable\.com\/(?:api\/v1\/widget\/accounts\/)?([a-z0-9_-]+)/i,
    portal: (slug) => `https://apply.workable.com/${slug}/`,
  },
  {
    source: 'smartrecruiters',
    type: 'smartrecruiters',
    pattern: /(?:jobs|careers|api)\.smartrecruiters\.com\/(?:v1\/companies\/)?([a-z0-9_-]+)/i,
    portal: (slug) => `https://jobs.smartrecruiters.com/${slug}`,
  },
  {
    source: 'recruitee',
    type: 'recruitee',
    pattern: /(?:^|\/\/)([a-z0-9-]+)\.recruitee\.com/i,
    portal: (slug) => `https://${slug}.recruitee.com`,
  },
  {
    source: null,
    type: 'workday',
    pattern: /([a-z0-9-]+)\.(?:wd\d+\.)?myworkdayjobs\.com/i,
    portal: (slug) => `https://${slug}.myworkdayjobs.com`,
  },
  {
    source: null,
    type: 'icims',
    pattern: /(?:careers-)?([a-z0-9-]+)\.icims\.com/i,
    portal: (slug) => `https://careers-${slug}.icims.com`,
  },
  {
    source: null,
    type: 'zoho-recruit',
    pattern: /([a-z0-9-]+)\.zohorecruit\.(?:com|in|eu)/i,
    portal: (slug) => `https://${slug}.zohorecruit.com`,
  },
  {
    source: null,
    type: 'keka',
    pattern: /([a-z0-9-]+)\.keka\.com\/careers/i,
    portal: (slug) => `https://${slug}.keka.com/careers`,
  },
  {
    source: null,
    type: 'freshteam',
    pattern: /([a-z0-9-]+)\.freshteam\.com/i,
    portal: (slug) => `https://${slug}.freshteam.com/jobs`,
  },
  {
    source: null,
    type: 'darwinbox',
    pattern: /([a-z0-9-]+)\.darwinbox\.(?:com|in)/i,
    portal: (slug) => `https://${slug}.darwinbox.in/ms/candidate/careers`,
  },
];

/** Hosts that are never the employer's own site, so never a website candidate. */
const NOT_A_COMPANY_SITE =
  /(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|myworkdayjobs\.com|icims\.com|zohorecruit\.|keka\.com|freshteam\.com|darwinbox\.|linkedin\.com|indeed\.|naukri\.com|glassdoor\.|monster\.|foundit\.|cutshort\.io|remoteok\.com|remotive\.com|himalayas\.app|adzuna\.|jooble\.org|rapidapi\.com|bit\.ly|google\.com)/i;

/** Paths to try when the homepage does not link to its own careers page. */
const CAREERS_PATHS = ['/careers', '/jobs', '/careers/', '/company/careers', '/about/careers'];

/** Paths that carry a contact address when the careers page does not. */
const CONTACT_PATHS = ['/contact', '/contact-us'];

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** A patch for `CompanyRepo.applyResolution`, plus the boards worth remembering. */
export interface CompanyResolution {
  website: string | null;
  websiteConfidence: Confidence;
  careersUrl: string | null;
  atsType: string | null;
  atsPortalUrl: string | null;
  careersEmail: string | null;
  emailConfidence: Confidence;
  linkedinUrl: string | null;
  note: string | null;
  /** Boards discovered here, for `mergeBoards` to fold into the next run. */
  discovered: BoardRef[];
}

/** The URLs a job carries, which are the resolver's starting point. */
export interface CompanyHints {
  applyUrl?: string | null;
  sourceUrl?: string | null;
  website?: string | null;
  careersUrl?: string | null;
}

export interface ResolverOptions {
  http: HttpClient;
  /** Hard ceiling on requests for one company, however little was found. */
  requestBudget?: number;
  timeoutMs?: number;
  onWarning?: (message: string) => void;
}

const DEFAULT_REQUEST_BUDGET = 8;
const DEFAULT_TIMEOUT_MS = 8000;

/* -------------------------------------------------------------------------- */
/* Resolver                                                                   */
/* -------------------------------------------------------------------------- */

export class CompanyResolver {
  private readonly http: HttpClient;
  private readonly requestBudget: number;
  private readonly timeoutMs: number;
  private readonly onWarning: (message: string) => void;

  constructor(options: ResolverOptions) {
    this.http = options.http;
    this.requestBudget = options.requestBudget ?? DEFAULT_REQUEST_BUDGET;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onWarning = options.onWarning ?? (() => {});
  }

  /**
   * Looks up one company. Never throws for anything but an abort — a company
   * whose site is down is a company with fewer fields, not a failed run.
   */
  async resolve(
    company: Company,
    hints: CompanyHints = {},
    signal?: AbortSignal,
  ): Promise<CompanyResolution> {
    const state = new ResolutionState(company, this.requestBudget);

    try {
      this.readAtsFromUrls(company, hints, state);
      await this.findWebsite(company, hints, state, signal);
      await this.readCareersPage(state, signal);
      await this.readContactPage(state, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.onWarning(`${company.name}: enrichment stopped (${describe(error)})`);
      state.note(`Enrichment did not complete: ${describe(error)}`);
    }

    return state.finish();
  }

  /* ---------------------------------------------------------------------- */

  /**
   * The cheapest and most reliable step: the job's own apply link frequently
   * *is* the ATS board, and reading it costs nothing.
   */
  private readAtsFromUrls(company: Company, hints: CompanyHints, state: ResolutionState): void {
    for (const url of [hints.applyUrl, hints.sourceUrl, company.careersUrl, hints.careersUrl]) {
      if (!url) continue;
      const hit = detectAts(url);
      if (hit) {
        state.recordAts(hit, company.name);
        return;
      }
    }
  }

  /**
   * Confirms the website we were given, or takes one from the apply URL when the
   * employer hosts its own hiring pages.
   *
   * A slug on `jobs.lever.co` says nothing about the company's domain, so no
   * website is inferred from it. A posting on `careers.acme.com`, on the other
   * hand, was published by Acme on Acme's own infrastructure.
   */
  private async findWebsite(
    company: Company,
    hints: CompanyHints,
    state: ResolutionState,
    signal?: AbortSignal,
  ): Promise<void> {
    const candidate =
      normalizeUrl(company.website) ??
      normalizeUrl(hints.website) ??
      ownDomainOrigin(hints.applyUrl) ??
      ownDomainOrigin(hints.sourceUrl);

    if (!candidate) {
      state.note('No company website was published by the job source');
      return;
    }

    const origin = originOf(candidate);
    if (!origin) return;

    if (!state.spend()) return;
    const probe = await this.http.probe(origin, {
      ...(signal ? { signal } : {}),
      timeoutMs: this.timeoutMs,
    });

    if (probe.ok) {
      // Reachable, so this is a real site rather than a domain someone typed —
      // but "the site exists" is not "this is definitely their site", which is
      // why it is `probable` and not `verified`.
      state.setWebsite(originOf(probe.finalUrl) ?? origin, 'probable');
    } else {
      state.setWebsite(
        origin,
        company.websiteConfidence === 'verified' ? 'verified' : 'unverified',
      );
      state.note(
        probe.status === null
          ? 'Company website did not respond'
          : `Company website answered HTTP ${probe.status}`,
      );
    }
  }

  /**
   * Finds and reads the careers page, which is where every remaining field
   * comes from: the ATS the company embeds, the address it publishes, and its
   * LinkedIn link.
   */
  private async readCareersPage(state: ResolutionState, signal?: AbortSignal): Promise<void> {
    const website = state.website;
    if (!website) return;

    const careersUrl = state.careersUrl ?? (await this.discoverCareersUrl(website, state, signal));
    if (!careersUrl) {
      state.note('No careers page found on the company website');
      return;
    }
    state.setCareersUrl(careersUrl);

    const html = await this.fetchHtml(careersUrl, state, signal);
    if (!html) return;

    this.harvest(html, state, 'careers page');
  }

  /** One last look for an address, on the pages that traditionally carry one. */
  private async readContactPage(state: ResolutionState, signal?: AbortSignal): Promise<void> {
    if (state.careersEmail || !state.website) return;

    for (const path of CONTACT_PATHS) {
      const url = join(state.website, path);
      const html = await this.fetchHtml(url, state, signal);
      if (!html) continue;
      this.harvest(html, state, 'contact page');
      if (state.careersEmail) return;
    }

    state.note('No careers email published on their site — apply via portal');
  }

  /** Pulls every field a page can supply in one pass over its markup. */
  private harvest(html: string, state: ResolutionState, where: string): void {
    if (!state.atsPortalUrl) {
      const hit = detectAts(html);
      if (hit) state.recordAts(hit, state.companyName);
    }

    if (!state.careersEmail) {
      const email = pickHiringEmail(extractMailtoAddresses(html));
      if (email) {
        // Read from the employer's own markup, which is the only provenance
        // this project accepts for an address.
        state.setEmail(email, 'verified');
        state.note(`Careers email read from the company's ${where}`);
      }
    }

    if (!state.linkedinUrl) {
      const linkedin = html.match(
        /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[A-Za-z0-9_%-]+/i,
      )?.[0];
      if (linkedin) state.setLinkedin(linkedin.replace(/\/$/, ''));
    }
  }

  /**
   * The company's own link to its careers page, falling back to the handful of
   * conventional paths.
   *
   * Reading the homepage first is both more accurate and cheaper: one request
   * usually answers the question, where probing paths costs up to five and still
   * misses `/company/jobs` and every other variant a marketing site invents.
   */
  private async discoverCareersUrl(
    website: string,
    state: ResolutionState,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const home = await this.fetchHtml(website, state, signal);
    if (home) {
      this.harvest(home, state, 'homepage');
      const linked = findCareersLink(home, website);
      if (linked) return linked;
    }

    for (const path of CAREERS_PATHS) {
      if (!state.spend()) return null;
      const url = join(website, path);
      const probe = await this.http.probe(url, {
        ...(signal ? { signal } : {}),
        timeoutMs: this.timeoutMs,
      });
      if (probe.ok) return probe.finalUrl;
    }
    return null;
  }

  /** A GET that costs budget, tolerates failure, and refuses non-HTML. */
  private async fetchHtml(
    url: string,
    state: ResolutionState,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!state.spend()) return null;
    try {
      const response = await this.http.get(url, {
        ...(signal ? { signal } : {}),
        timeoutMs: this.timeoutMs,
        headers: { accept: 'text/html,application/xhtml+xml' },
        // Marketing sites are heavy but not this heavy; a 2 MB ceiling keeps one
        // pathological page from eating a run's memory.
        maxBytes: 2 * 1024 * 1024,
      });
      return looksLikeHtml(response.body) ? response.body : null;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return null;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Accumulator                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Collects what the resolver learns, so each step can read what the previous one
 * found without threading a widening tuple through five methods.
 */
class ResolutionState {
  readonly companyName: string;
  website: string | null;
  websiteConfidence: Confidence;
  careersUrl: string | null;
  atsType: string | null;
  atsPortalUrl: string | null;
  careersEmail: string | null;
  emailConfidence: Confidence;
  linkedinUrl: string | null;

  private readonly notes: string[] = [];
  private readonly boards: BoardRef[] = [];
  private budget: number;

  constructor(company: Company, budget = DEFAULT_REQUEST_BUDGET) {
    this.companyName = company.name;
    this.website = company.website;
    this.websiteConfidence = company.websiteConfidence;
    this.careersUrl = company.careersUrl;
    this.atsType = company.atsType;
    this.atsPortalUrl = company.atsPortalUrl;
    this.careersEmail = company.careersEmail;
    this.emailConfidence = company.emailConfidence;
    this.linkedinUrl = company.linkedinUrl;
    this.budget = budget;
  }

  /** Consumes one request from the budget; false means stop. */
  spend(): boolean {
    if (this.budget <= 0) return false;
    this.budget -= 1;
    return true;
  }

  setWebsite(url: string, confidence: Confidence): void {
    this.website = url;
    // Never downgrade: a website already verified stays verified even if today's
    // probe timed out.
    if (rank(confidence) >= rank(this.websiteConfidence)) this.websiteConfidence = confidence;
  }

  setCareersUrl(url: string): void {
    this.careersUrl = url;
  }

  setEmail(email: string, confidence: Confidence): void {
    this.careersEmail = email;
    this.emailConfidence = confidence;
  }

  setLinkedin(url: string): void {
    this.linkedinUrl = url;
  }

  recordAts(hit: AtsHit, companyName: string): void {
    this.atsType = hit.type;
    this.atsPortalUrl = hit.portalUrl;
    this.note(`Hiring on ${hit.type}`);
    // Only a board we have a provider for is worth remembering: recording a
    // Workday slug we cannot query would grow the list without adding a lead.
    if (hit.source) {
      this.boards.push({ source: hit.source, slug: hit.slug, company: companyName });
    }
  }

  note(message: string): void {
    if (!this.notes.includes(message)) this.notes.push(message);
  }

  finish(): CompanyResolution {
    return {
      website: this.website,
      websiteConfidence: this.website ? this.websiteConfidence : 'unverified',
      careersUrl: this.careersUrl,
      atsType: this.atsType,
      atsPortalUrl: this.atsPortalUrl,
      careersEmail: this.careersEmail,
      emailConfidence: this.careersEmail ? this.emailConfidence : 'unverified',
      linkedinUrl: this.linkedinUrl,
      note: this.notes.length > 0 ? this.notes.join(' · ') : null,
      discovered: this.boards,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

interface AtsHit {
  source: AtsSource | null;
  type: string;
  slug: string;
  portalUrl: string;
}

/**
 * Finds an ATS board in a URL or in a page's markup.
 *
 * The same function serves both because an embedded board appears in the HTML as
 * the very URL this already recognises — one matcher, so a link and an iframe
 * cannot be treated differently by accident.
 */
export function detectAts(input: string): AtsHit | null {
  for (const signature of ATS_SIGNATURES) {
    const slug = signature.pattern.exec(input)?.[1];
    if (!slug) continue;
    // Board roots and generic path segments are not company tokens.
    if (/^(?:embed|api|www|jobs|careers|search|v1)$/i.test(slug)) continue;
    return {
      source: signature.source,
      type: signature.type,
      slug: slug.toLowerCase(),
      portalUrl: signature.portal(slug.toLowerCase()),
    };
  }
  return null;
}

/** The one hiring address among a page's `mailto:` links, if there is one. */
export function pickHiringEmail(addresses: readonly string[]): string | null {
  for (const address of addresses) {
    if (EMAIL_BLOCKLIST.test(address)) continue;
    const local = address.split('@')[0]?.toLowerCase() ?? '';
    // `careers.india@` and `hr-team@` are the same inbox with a suffix, so the
    // comparison is on the leading token rather than the whole local part.
    const head = local.split(/[.+_-]/)[0] ?? '';
    if (HIRING_LOCAL_PARTS.includes(head)) return address;
  }
  return null;
}

/**
 * A link on the page that leads to the company's own careers section.
 *
 * Both the href and the link text are considered, because plenty of sites label
 * the link "Join us" and point it at `/life`, and plenty of others say
 * "Careers" and point at a path with no such word in it.
 */
export function findCareersLink(html: string, base: string): string | null {
  const anchors = html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi);
  let fallback: string | null = null;

  for (const anchor of anchors) {
    const href = anchor[1];
    if (!href) continue;
    const text = htmlToText(anchor[2] ?? '').toLowerCase();
    const hrefLower = href.toLowerCase();

    const looksLikeCareers =
      /\b(careers?|jobs?|join[- ]?us|work[- ]with[- ]us|we'?re hiring|openings?|vacanc)/i.test(
        text,
      ) || /\/(careers?|jobs?|join-us|openings?|vacancies)(?:[/?#]|$)/i.test(hrefLower);
    if (!looksLikeCareers) continue;

    const absolute = absolutize(href, base);
    if (!absolute) continue;

    // An ATS link is the strongest possible answer — it is the board itself.
    if (detectAts(absolute)) return absolute;
    fallback ??= absolute;
  }
  return fallback;
}

/** `https://careers.acme.com/job/1` → `https://careers.acme.com`, or null. */
function ownDomainOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  const normalized = normalizeUrl(url);
  if (!normalized || NOT_A_COMPANY_SITE.test(normalized)) return null;
  return originOf(normalized);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function absolutize(href: string, base: string): string | null {
  if (/^(?:mailto|tel|javascript):/i.test(href)) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function join(origin: string, path: string): string {
  return `${origin.replace(/\/$/, '')}${path}`;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { unverified: 0, probable: 1, verified: 2 };
const rank = (value: Confidence): number => CONFIDENCE_RANK[value];

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
