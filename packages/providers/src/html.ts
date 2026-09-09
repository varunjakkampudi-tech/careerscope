/**
 * HTML → plain text, tuned for job descriptions.
 *
 * The matching engine reads descriptions as text: it looks for skill names,
 * "5+ years", and section headings like "Nice to have". A generic tag-stripper
 * ruins all three — it welds `<li>React</li><li>Node</li>` into "ReactNode"
 * (two skills become one non-skill) and flattens the required/preferred split
 * the demand extractor depends on. So this keeps block boundaries as newlines
 * and list items as "- " bullets.
 *
 * No DOM parser: these payloads are provider-authored fragments, not arbitrary
 * documents, and the output is never re-rendered as HTML — it is scored and
 * displayed as text. Bringing in a full parser would buy correctness we do not
 * need and a dependency on every ATS adapter's hot path.
 */

/** Tags whose content is markup or code, not prose. Dropped whole. */
const DROP_CONTENT = /<(script|style|noscript|iframe|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Tags that end a line of prose. */
const BLOCK_TAGS =
  'p|div|section|article|header|footer|main|aside|h[1-6]|ul|ol|dl|dt|dd|table|thead|tbody|tr|blockquote|pre|form|fieldset|figure|figcaption|address|hr';

const BLOCK_BOUNDARY = new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi');
const LIST_ITEM = /<li\b[^>]*>/gi;
const LINE_BREAK = /<br\s*\/?>/gi;
const CELL_BOUNDARY = /<\/(?:td|th)\s*>/gi;
const ANY_TAG = /<[^>]+>/g;

/** The handful of entities that actually show up in job posts. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  eacute: 'é',
  reg: '®',
  copy: '©',
  trade: '™',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  times: '×',
  frac12: '½',
};

/**
 * Decode HTML entities. Numeric forms are clamped to valid code points, because
 * a malformed `&#1114112;` in someone's JD should not throw inside a search run.
 */
export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,31});/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      // Lone surrogates are not characters; leaving the entity is the honest result.
      if (code >= 0xd800 && code <= 0xdfff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Convert a description fragment to readable plain text.
 *
 * Block elements become blank lines and `<li>` becomes "- ", so the demand
 * extractor still sees one skill per line and headings stay on their own line.
 */
export function htmlToText(input: string | null | undefined): string {
  if (!input) return '';

  let text = input.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(DROP_CONTENT, '\n');
  text = text.replace(LINE_BREAK, '\n');
  text = text.replace(LIST_ITEM, '\n- ');
  text = text.replace(CELL_BOUNDARY, '\t');
  text = text.replace(BLOCK_BOUNDARY, '\n');
  text = text.replace(ANY_TAG, ' ');
  text = decodeEntities(text);

  return tidyText(text);
}

/**
 * Normalise whitespace without destroying structure: runs of spaces collapse,
 * trailing spaces go, and three or more newlines become two — so one blank line
 * still separates paragraphs and headings.
 *
 * Tabs survive, because they are how `htmlToText` keeps table cells apart.
 */
export function tidyText(input: string): string {
  return (
    input
      .replace(/\r\n?/g, '\n')
      // A non-breaking space is a space as far as any reader is concerned.
      .replace(/\u00a0/g, ' ')
      .replace(/[^\S\n\t]+/g, ' ')
      .replace(/ *\t[ \t]*/g, '\t')
      .replace(/ *\n */g, '\n')
      .replace(/\t*\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/(?:\n- )+(?=\n- )/g, '\n- ') // empty bullets from `<li></li>`
      .trim()
  );
}

/**
 * Text for any description, HTML or not.
 *
 * `isHtml` is what the board *claims*. Several boards label an HTML field as
 * plain text, so markup is stripped whenever it is actually present — trusting
 * the label would put raw tags in front of the user. The sniff is deliberately
 * strict, so a JD writing "latency < 200ms" is left alone.
 */
export function descriptionToText(input: string | null | undefined, isHtml?: boolean): string {
  if (!input) return '';
  if (isHtml === true || looksLikeHtml(input)) return htmlToText(input);
  return tidyText(decodeEntities(input));
}

/**
 * True when the string carries real markup. Requires a recognisable tag rather
 * than any `<`, so a JD saying "latency < 200ms" is not mangled into HTML.
 */
export function looksLikeHtml(input: string): boolean {
  return /<(?:\/?[a-z][a-z0-9]*)\b[^>]*>/i.test(input);
}

/** Collapse to a single line and clip — for log lines and list snippets. */
export function snippet(input: string, maxChars = 280): string {
  const flat = input.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Every `mailto:` address in a page, lowercased and de-duplicated.
 *
 * Used by company enrichment, which only ever records an address it has
 * actually seen on the employer's own page — never one assembled from a
 * pattern. Extraction stays here so that rule has a single implementation.
 */
export function extractMailtoAddresses(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/mailto:([^"'?\s<>)]+)/gi)) {
    const raw = decodeEntities(match[1] ?? '')
      .trim()
      .toLowerCase();
    if (isPlausibleEmail(raw)) found.add(raw);
  }
  return [...found];
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export function isPlausibleEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

/**
 * Undo UTF-8 text that was decoded as Latin-1 somewhere upstream — the "â€™"
 * form of a right single quote.
 *
 * This is not hypothetical tidiness: RemoteOK serves it in the majority of its
 * descriptions, and the damage lands on apostrophes and dashes, which are
 * everywhere in prose. Left alone it reaches both the user's screen and the
 * skill extractor's input.
 *
 * The repair is only attempted when the text carries a mojibake signature, and
 * abandoned if the bytes turn out not to be valid UTF-8 — so text that is
 * merely accented, a genuine "Zürich", is returned untouched.
 */
export function repairMojibake(input: string): string {
  if (!MOJIBAKE.test(input)) return input;

  const bytes = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    // Any character outside Latin-1 means this was never a byte-level mix-up.
    if (code > 0xff) return input;
    bytes[i] = code;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Not valid UTF-8 underneath, so the original was right after all.
    return input;
  }
}

/**
 * A Latin-1 rendering of a UTF-8 lead byte (0xC2 / 0xC3 / 0xE2 — punctuation and
 * accents) followed by a continuation byte (0x80–0xBF). Requiring the *pair* is
 * what keeps a legitimately accented word from being "repaired" into nonsense.
 */
const MOJIBAKE = /[\u00c2\u00c3\u00e2][\u0080-\u00bf]/;

/** `<link rel="canonical">` or `og:url`, when a board buries the real URL. */
export function extractCanonicalUrl(html: string): string | null {
  const canonical = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1];
  if (canonical) return decodeEntities(canonical.trim());

  const og = html.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i)?.[1];
  return og ? decodeEntities(og.trim()) : null;
}
