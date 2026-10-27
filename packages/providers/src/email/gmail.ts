/**
 * Gmail job-alert provider: reads recent alert emails from LinkedIn, Naukri and Indeed through the
 * Gmail API (read-only) and extracts job cards. Plugs into `JobProvider` in `types.ts`.
 */

import type { RawJob } from '@careerscope/shared';
import { load } from 'cheerio';
import { OAuth2Client } from 'google-auth-library';
import { htmlToText } from '../html.js';
import { isAbortError } from '../http.js';
import type { JobProvider } from '../types.js';

/** A Gmail MIME part; parts nest, and attachments carry a `filename`. */
interface MessagePart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: MessagePart[];
  headers?: { name: string; value: string }[];
}

/** A message from `users.messages.get` with `format=full`. `internalDate` is epoch milliseconds as a string. */
export interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: MessagePart;
}

/** `accessToken` and `now` exist so tests can avoid OAuth and the clock. */
interface GmailOptions {
  credentials?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  accessToken?: () => Promise<string>;
}

const API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const KEYS = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'] as const;
/** Only mail from these sender domains is parsed; alert bodies are untrusted HTML, so everything else is ignored. */
const SENDERS = ['linkedin.com', 'naukri.com', 'indeed.com', 'indeedmail.com'];

/** True for the domain itself or a subdomain; a plain suffix test would accept look-alike hosts such as `evillinkedin.com`. */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Canonicalises a link from an alert email to a job page on a known board, or returns null.
 * Accepts only https links with no credentials or port and a recognised path shape, and rebuilds the
 * URL from the extracted id, so tracking redirects and look-alike links are dropped.
 */
export function jobLink(value: string): { url: string; publisher: string; id: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (hostMatches(host, 'linkedin.com')) {
      const id = /\/jobs\/view\/(?:[^/]*-)?(\d+)\/?$/.exec(url.pathname)?.[1];
      if (id)
        return { url: `https://www.linkedin.com/jobs/view/${id}/`, publisher: 'LinkedIn', id };
    }
    if (hostMatches(host, 'naukri.com') && url.pathname.startsWith('/job-listings-')) {
      const id = /-(\d{8,})\/?$/.exec(url.pathname)?.[1];
      if (id) return { url: `${url.origin}${url.pathname}`, publisher: 'Naukri', id };
    }
    if (
      hostMatches(host, 'indeed.com') &&
      ['/viewjob', '/rc/clk', '/pagead/clk'].includes(url.pathname)
    ) {
      const id = url.searchParams.get('jk');
      if (id && /^[a-z0-9]+$/i.test(id)) {
        return { url: `https://www.indeed.com/viewjob?jk=${id}`, publisher: 'Indeed', id };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Decoded text of every non-attachment part with the given MIME type, depth first. */
function bodies(part: MessagePart | undefined, mimeType: string): string[] {
  if (!part || part.filename) return [];
  const own =
    part.mimeType === mimeType && part.body?.data
      ? [Buffer.from(part.body.data, 'base64url').toString('utf8')]
      : [];
  return [...own, ...(part.parts ?? []).flatMap((child) => bodies(child, mimeType))];
}

/**
 * Extracts job cards from one alert email. The `From` address domain must be in `SENDERS`; mail
 * from anywhere else yields no jobs. Results are de-duplicated by canonical link.
 */
export function parseGmailMessage(message: GmailMessage): RawJob[] {
  const from =
    message.payload?.headers?.find((header) => header.name.toLowerCase() === 'from')?.value ?? '';
  const sender = /(?:<|^|\s)[^<>\s@]+@([^<>\s]+)>?\s*$/.exec(from)?.[1]?.toLowerCase();
  if (!sender || !SENDERS.some((domain) => hostMatches(sender, domain))) return [];

  const jobs = new Map<string, RawJob>();
  for (const html of bodies(message.payload, 'text/html')) {
    const document = load(html);
    document('script, style, footer, blockquote').remove();
    document('a[href]').each((_index, element) => {
      const anchor = document(element);
      const link = jobLink(anchor.attr('href') ?? '');
      if (!link || jobs.has(link.url)) return;
      const titleText = anchor.text().replace(/\s+/g, ' ').trim();
      if (
        titleText.length < 4 ||
        /^(view|apply|see|explore|click|learn|more|job details)\b/i.test(titleText)
      )
        return;

      // Climb to the largest ancestor that still holds exactly one distinct job link. That element is
      // the job card, and its text lines hold the company and location next to the title.
      let card = anchor.parent();
      for (let depth = 0; depth < 6; depth += 1) {
        const parent = card.parent();
        if (!parent.length || parent.is('body, html') || card.is('tr, li, article')) break;
        const targets = new Set(
          parent
            .find('a[href]')
            .toArray()
            .map((child) => jobLink(document(child).attr('href') ?? '')?.url)
            .filter(Boolean),
        );
        if (targets.size !== 1) break;
        card = parent;
      }
      const lines = htmlToText(card.html())
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const combined = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(titleText);
      const title = combined?.[1] ?? titleText;
      const titleIndex = lines.findIndex((line) => line === titleText);
      const companyName =
        combined?.[2] ??
        lines.find((line) => /^company\s*:/i.test(line))?.replace(/^company\s*:\s*/i, '') ??
        (titleIndex >= 0 ? lines[titleIndex + 1] : undefined);
      if (
        !companyName ||
        companyName.length > 160 ||
        /^(view|apply|see|unsubscribe|http|\d|location\s*:)\b/i.test(companyName)
      )
        return;
      const location = lines
        .find((line) => /^location\s*:/i.test(line))
        ?.replace(/^location\s*:\s*/i, '');
      const salary = lines.find((line) => /^(salary|package|ctc)\s*:/i.test(line));
      jobs.set(link.url, {
        source: 'gmail',
        sourceJobId: `${link.publisher.toLowerCase()}:${link.id}`,
        title,
        companyName,
        ...(location ? { location } : {}),
        ...(salary ? { salaryRaw: salary.replace(/^[^:]+:\s*/, '') } : {}),
        description: lines.slice(0, 40).join('\n').slice(0, 6000),
        // An alert email carries only a teaser, so these leads stay capped by the low-confidence ceiling.
        hasFullDescription: false,
        applyUrl: link.url,
        sourceUrl: link.url,
        sourcePublisher: link.publisher,
      });
    });
  }
  return [...jobs.values()];
}

/**
 * Gmail provider. It is unavailable until the three OAuth variables are set. Scans at most 200
 * messages per run and never throws for a single unreadable message.
 */
export function createGmailProvider(options: GmailOptions = {}): JobProvider {
  const credentials = options.credentials ?? {};
  const missing = KEYS.filter((key) => !credentials[key]);
  const auth = new OAuth2Client({
    clientId: credentials.GMAIL_CLIENT_ID,
    clientSecret: credentials.GMAIL_CLIENT_SECRET,
    transporterOptions: { timeout: 20_000 },
  });
  auth.setCredentials({ refresh_token: credentials.GMAIL_REFRESH_TOKEN });

  return {
    id: 'gmail',
    kind: 'email',
    label: 'Gmail job alerts',
    unavailableReason: missing.length
      ? `Set ${missing.join(', ')} with Gmail read-only access`
      : null,
    async *search(query, ctx) {
      if (missing.length || ctx.signal?.aborted) return;
      try {
        const token = options.accessToken
          ? await options.accessToken()
          : (await auth.getAccessToken()).token;
        if (!token) throw new Error('No access token');
        const request = {
          headers: { authorization: `Bearer ${token}` },
          noCache: true,
          signal: ctx.signal,
        };
        const after = Math.floor(
          ((options.now?.() ?? Date.now()) - query.postedWithinDays * 86_400_000) / 1000,
        );
        // Exclude trash, spam, sent and drafts so only inbound alerts are read.
        const search = `after:${after} {${SENDERS.map((domain) => `from:${domain}`).join(' ')}} -in:trash -in:spam -in:sent -in:drafts`;
        const seen = new Set<string>();
        let pageToken: string | undefined;
        let scanned = 0;
        let yielded = 0;
        do {
          if (ctx.signal?.aborted) return;
          const url = new URL(API);
          url.searchParams.set('q', search);
          // Page size shrinks near the 200-message scan cap so the cap is exact.
          url.searchParams.set('maxResults', String(Math.min(50, 200 - scanned)));
          if (pageToken) url.searchParams.set('pageToken', pageToken);
          const page = await ctx.http.getJson<{
            messages?: { id: string }[];
            nextPageToken?: string;
          }>(url.href, request);
          for (const entry of page.messages ?? []) {
            if (ctx.signal?.aborted || yielded >= query.maxResults) return;
            scanned += 1;
            try {
              const message = await ctx.http.getJson<GmailMessage>(
                `${API}/${encodeURIComponent(entry.id)}?format=full`,
                request,
              );
              // Re-check the cutoff against the message's own timestamp rather than relying only on the query.
              if (Number(message.internalDate) < after * 1000) continue;
              for (const job of parseGmailMessage(message)) {
                if (seen.has(job.sourceJobId)) continue;
                seen.add(job.sourceJobId);
                yield job;
                yielded += 1;
                if (yielded >= query.maxResults) return;
              }
            } catch (error) {
              if (ctx.signal?.aborted || isAbortError(error)) return;
              ctx.log?.({
                level: 'warn',
                source: 'gmail',
                message: 'Could not read one job-alert email; continuing.',
              });
            }
          }
          pageToken = page.nextPageToken;
        } while (pageToken && scanned < 200);
        ctx.log?.({
          level: 'info',
          source: 'gmail',
          message: `Read ${scanned} recent alerts; extracted ${yielded} jobs. Email snippets are capped at 80% match.${pageToken ? ' Reached the 200-message scan limit.' : ''}`,
        });
      } catch (error) {
        if (ctx.signal?.aborted || isAbortError(error)) return;
        // A fixed message on purpose: the underlying error can contain tokens or request details.
        throw new Error(
          'Gmail could not be read. Check Gmail API access and GMAIL OAuth credentials with gmail.readonly permission.',
        );
      }
    },
  };
}
