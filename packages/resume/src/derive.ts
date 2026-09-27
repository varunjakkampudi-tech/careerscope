import {
  extractSkills,
  isRefusedCodePoint,
  normalizeSkillList,
  REFUSED_SYNTAX,
} from '@job-radar/shared';
import { headerBlock, splitSections, type Sections } from './sections.js';

/* -------------------------------------------------------------------------- */
/* Contact details                                                            */
/* -------------------------------------------------------------------------- */

export interface Contact {
  email?: string;
  phone?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
}

export function deriveContact(text: string): Contact {
  const flat = text.replace(/\s+/g, ' ');
  const email = first(flat, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return {
    email,
    phone: derivePhone(flat),
    linkedin: toUrl(first(flat, /linkedin\.com\/in\/[A-Za-z0-9\-_%]+/i)),
    github: toUrl(first(flat, /github\.com\/[A-Za-z0-9\-_]+/i)),
    portfolio: derivePortfolio(flat, email),
  };
}

function derivePhone(flat: string): string | undefined {
  // Prefer a number carrying a country code or separators; a bare 10-digit run
  // is too easily a date range or an ID.
  const candidates = [
    /\+\d{1,3}[\s-]?\d{3,5}[\s-]?\d{3,5}[\s-]?\d{0,5}/,
    /\(\d{3}\)\s?\d{3}[\s-]?\d{4}/,
    /\b\d{3}[\s-]\d{3}[\s-]\d{4}\b/,
    /\b[6-9]\d{9}\b/, // Indian mobile
  ];
  for (const re of candidates) {
    const hit = first(flat, re);
    if (hit) return hit.replace(/\s{2,}/g, ' ').trim();
  }
  return undefined;
}

function derivePortfolio(flat: string, email?: string): string | undefined {
  const emailDomain = email?.split('@')[1]?.toLowerCase() ?? '';
  const skip = new Set([
    'gmail.com',
    'outlook.com',
    'yahoo.com',
    'hotmail.com',
    'linkedin.com',
    'github.com',
    'gitlab.com',
    'bitbucket.org',
    'hackerrank.com',
    'leetcode.com',
    'stackoverflow.com',
    'medium.com',
    'npmjs.com',
    emailDomain,
  ]);
  // The label before the dot must be at least two characters: "B.Tech" and
  // "M.Tech" on an education line otherwise read as websites, and a degree is a
  // much more common string in a resume than a personal site.
  const matches = flat.matchAll(
    /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]+\.(?:in|io|dev|me|app|tech|xyz|co|com|net|site|page)(?:\/[^\s,;]*)?)\b/gi,
  );
  for (const m of matches) {
    const url = (m[1] ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    const domain = (url.split('/')[0] ?? '').toLowerCase();
    if (!domain || skip.has(domain)) continue;
    // A bare TLD-looking token inside an email or a file name is not a site.
    if (domain.split('.').length < 2) continue;
    if (ACADEMIC_PREFIX.test(domain)) continue;
    return `https://${url}`;
  }
  return undefined;
}

/** Degree abbreviations that look like domains once the dot is taken literally. */
const ACADEMIC_PREFIX = /^(?:b|m|bs|ms|ba|ma|bsc|msc|be|me|btech|mtech|mba|bca|mca|phd)\./i;

function first(text: string, re: RegExp): string | undefined {
  const m = text.match(re);
  return m ? m[0].trim() : undefined;
}

function toUrl(value?: string): string | undefined {
  if (!value) return undefined;
  return value.startsWith('http') ? value : `https://www.${value}`;
}

/* -------------------------------------------------------------------------- */
/* Name                                                                       */
/* -------------------------------------------------------------------------- */

const NOT_A_NAME =
  /resume|curriculum|vitae|\bcv\b|profile|summary|engineer|developer|@|http|\d|street|road|phone|email/i;

/**
 * The name is the first short, alphabetic header line. When an email is present
 * its local part disambiguates the ordering, which matters for the many resumes
 * that lead with the surname.
 */
export function deriveName(text: string, email?: string): string | undefined {
  const lines = headerBlock(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const header = lines.find(
    (l) =>
      /^[A-Za-z][A-Za-z.'\- ]{2,48}$/.test(l) &&
      l.split(/\s+/).length <= 4 &&
      !NOT_A_NAME.test(l) &&
      !looksLikePlace(l),
  );
  if (!header) return undefined;

  const tokens = header
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z'-]/g, ''))
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
  if (tokens.length === 0) return undefined;
  if (tokens.length === 1) return tokens[0];

  const local = email?.split('@')[0]?.toLowerCase().replace(/\d+/g, '') ?? '';
  const segments = local.split(/[^a-z]+/).filter(Boolean);
  if (segments.length >= 2) {
    const firstFromEmail = tokens.find((t) => t.toLowerCase() === segments[0]);
    if (firstFromEmail) {
      const rest = tokens.filter((t) => t !== firstFromEmail);
      return [firstFromEmail, ...rest].join(' ');
    }
  }
  return tokens.join(' ');
}

/**
 * A header line that is nothing but a city or a country. Plenty of resumes put
 * the location on its own line directly under the headline, where it is exactly
 * as name-shaped as a real name.
 */
function looksLikePlace(line: string): boolean {
  const cleaned = line.replace(/[^A-Za-z ]/g, '').trim();
  if (!cleaned) return false;
  if (INDIAN_CITIES.some((city) => city.toLowerCase() === cleaned.toLowerCase())) return true;
  return new RegExp(`^(?:${COUNTRIES})$`, 'i').test(cleaned);
}

/* -------------------------------------------------------------------------- */
/* Location                                                                   */
/* -------------------------------------------------------------------------- */

const INDIAN_CITIES = [
  'Hyderabad',
  'Bangalore',
  'Bengaluru',
  'Chennai',
  'Mumbai',
  'Pune',
  'Delhi',
  'New Delhi',
  'Gurgaon',
  'Gurugram',
  'Noida',
  'Kolkata',
  'Ahmedabad',
  'Kochi',
  'Cochin',
  'Coimbatore',
  'Jaipur',
  'Indore',
  'Chandigarh',
  'Bhubaneswar',
  'Visakhapatnam',
  'Vijayawada',
  'Nagpur',
  'Lucknow',
  'Trivandrum',
  'Thiruvananthapuram',
  'Mysore',
  'Mysuru',
  'Vadodara',
  'Surat',
];

const COUNTRIES =
  'India|United States|USA|U\\.S\\.A\\.|US|UK|United Kingdom|Canada|Australia|Germany|Netherlands|Singapore|Ireland|UAE|Dubai|Qatar|Poland|Spain|France';

/** City from the header block. Falls back to a bare known city name. */
export function deriveLocation(text: string): string | undefined {
  const header = headerBlock(text);

  const withCountry = header.match(
    new RegExp(
      `\\b([A-Z][a-zA-Z]+(?:[ -][A-Z][a-zA-Z]+)?),\\s*(?:[A-Z][a-zA-Z]+,\\s*)?(${COUNTRIES})\\b`,
    ),
  );
  if (withCountry) {
    const city = cleanCity(withCountry[1] ?? '');
    if (city) return `${city}, ${withCountry[2]}`;
  }

  // "Hyderabad, Telangana" / "Austin, TX" — a region rather than a country.
  const withRegion = header.match(
    /\b([A-Z][a-zA-Z]+(?:[ -][A-Z][a-zA-Z]+)?),\s*([A-Z]{2}|[A-Z][a-zA-Z]{3,})\b/,
  );
  if (
    withRegion &&
    INDIAN_CITIES.some((c) => c.toLowerCase() === (withRegion[1] ?? '').toLowerCase())
  ) {
    return `${withRegion[1]}, ${withRegion[2]}`;
  }

  for (const city of INDIAN_CITIES) {
    if (new RegExp(`\\b${city}\\b`, 'i').test(header)) return `${city}, India`;
  }
  if (withRegion) {
    const city = cleanCity(withRegion[1] ?? '');
    if (city) return `${city}, ${withRegion[2]}`;
  }
  return undefined;
}

function cleanCity(raw: string): string {
  // Strip acronym tokens that bleed in from an adjacent skills line ("AWS Pune").
  return raw
    .split(/\s+/)
    .filter((t) => !/^[A-Z0-9]{2,}$/.test(t))
    .join(' ')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Dates and years of experience                                              */
/* -------------------------------------------------------------------------- */

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const MONTH_ALT = Object.keys(MONTHS).join('|');
const DATE_TOKEN = `(?:(?:${MONTH_ALT})[a-z]*\\.?[ ]?[',]?[ ]?\\d{4}|\\d{1,2}[/-]\\d{4}|\\d{4})`;
const PRESENT = `present|current|now|till date|to date|ongoing`;
const RANGE_RE = new RegExp(
  `(${DATE_TOKEN})\\s*(?:-|–|—|to|until|through)\\s*(${PRESENT}|${DATE_TOKEN})`,
  'gi',
);

export interface DateRange {
  start: number;
  end: number;
  /** Offset of the match in the source text, used to slice role blocks. */
  index: number;
}

function parseDateToken(token: string, now: number): number | null {
  const value = token.trim().toLowerCase();
  if (new RegExp(`^(?:${PRESENT})$`, 'i').test(value)) return now;

  const monthYear = value.match(new RegExp(`^(${MONTH_ALT})[a-z]*\\.?[ ]?[',]?[ ]?(\\d{4})$`));
  if (monthYear) {
    const month = MONTHS[monthYear[1] ?? ''] ?? 0;
    return Date.UTC(Number(monthYear[2]), month, 1);
  }

  const numeric = value.match(/^(\d{1,2})[/-](\d{4})$/);
  if (numeric) {
    const month = Math.min(11, Math.max(0, Number(numeric[1]) - 1));
    return Date.UTC(Number(numeric[2]), month, 1);
  }

  const yearOnly = value.match(/^(\d{4})$/);
  if (yearOnly) return Date.UTC(Number(yearOnly[1]), 0, 1);

  return null;
}

export function findDateRanges(text: string, now = Date.now()): DateRange[] {
  const ranges: DateRange[] = [];
  const upperBound = now + 366 * 86_400_000;

  RANGE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RANGE_RE.exec(text)) !== null) {
    const start = parseDateToken(m[1] ?? '', now);
    const end = parseDateToken(m[2] ?? '', now);
    if (start === null || end === null) continue;
    if (end < start) continue;
    if (start < Date.UTC(1970, 0, 1) || end > upperBound) continue;
    ranges.push({ start, end, index: m.index });
  }
  return ranges;
}

/**
 * Total professional experience in years.
 *
 * Prefers an explicit claim ("6+ years of experience"). Otherwise it measures
 * the employment date ranges, merging overlaps first — concurrent roles, or the
 * same role repeated in a summary, must not each add to the total. Most resumes
 * never state a number, so this fallback is what makes the experience dimension
 * usable at all.
 */
export function deriveYears(text: string, experience: string, now = Date.now()): number | null {
  const explicit = text.match(
    /(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)(?:\s+\d+\s*(?:months?|mos?))?\s+(?:of\s+)?(?:professional\s+|industry\s+|relevant\s+|hands[- ]on\s+)?(?:work\s+)?experience/i,
  );
  if (explicit) {
    const value = Number(explicit[1]);
    if (Number.isFinite(value) && value > 0 && value < 60) return value;
  }

  const ranges = findDateRanges(experience || text, now);
  if (ranges.length === 0) return null;

  const merged = mergeRanges(ranges);
  const totalMs = merged.reduce((sum, r) => sum + (r.end - r.start), 0);
  const years = totalMs / (365.25 * 86_400_000);
  if (years <= 0 || years > 60) return null;
  return Math.round(years * 10) / 10;
}

function mergeRanges(ranges: DateRange[]): { start: number; end: number }[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      out.push({ start: range.start, end: range.end });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Titles                                                                     */
/* -------------------------------------------------------------------------- */

// ROLE_WORDS is a hard gate: a line containing none of these words is never
// considered a title, in the experience block or the headline, with no
// fallback. It is therefore ENGLISH-ONLY BY CONSTRUCTION — "Ingénieur logiciel
// senior", "Softwareentwickler" and "Desarrollador de software" each derive
// zero titles, verified directly rather than assumed.
//
// The character allowlist below is NOT the cause and must not be blamed for it:
// it permits \p{M} so accents survive, and "Ingénieur Software Engineer"
// derives intact. This list is the sole gate.
//
// The failure is SILENT - a non-English resume parses fine and simply
// contributes no titles, which is indistinguishable from a resume that had no
// recognisable role. Documented in docs/KNOWN-LIMITATIONS.md; which languages
// to support is an owner product decision, so do not extend this list
// piecemeal without one.
const ROLE_WORDS =
  /\b(engineer|developer|architect|programmer|analyst|consultant|designer|scientist|administrator|specialist|manager|associate|principal|director|founder|president|lead|head|intern|sde|swe|cto|vp)\b/i;

/** Matches a full date range or a bare month-year, so titles can be de-dated. */
const DATE_STRIP_RE = new RegExp(
  `(?:${DATE_TOKEN})\\s*(?:-|–|—|to|until|through)\\s*(?:${PRESENT}|${DATE_TOKEN})` +
    `|(?:${MONTH_ALT})[a-z]*\\.?[ ]?[',]?[ ]?\\d{4}`,
  'gi',
);

/** Acronyms that must survive the shouting-headline fix below. */
const TITLE_ACRONYMS = new Set([
  'ii',
  'iii',
  'iv',
  'sde',
  'swe',
  'qa',
  'ui',
  'ux',
  'ai',
  'ml',
  'it',
  'cto',
  'vp',
  'sre',
]);

/**
 * Headlines are often set in all caps, which the profile form would then echo
 * back as shouting. Title-case them, but leave mixed-case titles exactly as the
 * candidate wrote them.
 */
function presentTitle(segment: string): string {
  if (segment !== segment.toUpperCase()) return segment;
  return segment
    .toLowerCase()
    .split(' ')
    .map((word) =>
      TITLE_ACRONYMS.has(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

/**
 * CS-56: a title is the one derived fact that is not taxonomy-bound — techStack
 * and recentSkills can only ever be names the skill taxonomy already knows,
 * while a title is whatever the resume says. Length alone is not a content
 * constraint, so the character set is constrained here, at extraction, rather
 * than trusting every future consumer of derived.titles (an email digest, a PDF
 * export, an admin snapshot) to escape it the way today's JSX does.
 *
 * Two tiers, because the two problems are different:
 *
 * REFUSED — characters that carry meaning in a markup, template or shell-ish
 * renderer, plus the non-whitespace control characters and the bidirectional
 * and zero-width formatting characters used to make a string read as something
 * other than what it is. None of these appear in a real job title, so a segment
 * containing one is not a title that needs cleaning: it is not a title.
 *
 * ALLOWED — everything a real title legitimately uses: Unicode letters and the
 * combining marks that accent them (Développeur), digits (Engineer II, Tier 3),
 * and the punctuation real titles carry — "Full-Stack", "Sr.", "R&D",
 * "Front End Developer/Designer", "C++", "C#", "Engineer, Platform",
 * "Women's Health Lead". Anything else outside that set is a stray character
 * (a bullet glyph, a decorative symbol) and is replaced with a space instead of
 * costing the whole title, so a real title is never silently dropped.
 *
 * `$` was in this refusal set until 2026-09-25 and was moved out deliberately
 * (re-review finding F-4). A refused character costs the ENTIRE segment, and
 * nine of the ten refusals have effectively zero probability in a real job
 * title — but `$` does not: "Engineer, $1B Platform segment" would have been
 * dropped silently, which is the over-strict failure mode this constraint is
 * explicitly not allowed to have. Refusing it was also redundant: template
 * interpolation needs `${`, and `{` is still refused, so `${...}` still costs
 * the segment. `$` now falls through to TITLE_STRAY_RE and is neutralised to a
 * space, keeping the rest of the title.
 *
 * MOVED TO `@job-radar/shared` as `REFUSED_SYNTAX` (CS-66 re-review, AC2). It
 * had stayed here while only the invisible-character predicate moved, and that
 * asymmetry was the live gap: `matching` neutralised the invisible half of the
 * refusal set when assembling stored evidence and let markup and template
 * syntax through verbatim, so a target role typed as
 * `<img src=x onerror=alert(1)> Engineer` was refused at this inlet and
 * renderable through the other. Two packages, one set, two operations.
 */
const TITLE_STRAY_RE = /[^\p{L}\p{M}\p{N} .,&/'’+#()\-–—]/gu;

/**
 * Control and invisible-formatting code points.
 *
 * MOVED TO `@job-radar/shared` (CS-66) rather than copied: `matching` needs the
 * same refusal set when it assembles the `reason` string that becomes stored
 * match evidence, and two copies of a security-relevant character set is a
 * divergence waiting to happen — a code point refused here but renderable there
 * is exactly the gap. The operations still differ and should: extraction
 * REJECTS a segment outright, evidence assembly NEUTRALISES. Only the set is
 * shared.
 */

/** Empty when the segment must not become a title at all. */
function constrainTitleCharacters(segment: string): string {
  for (const character of segment) {
    if (REFUSED_SYNTAX.has(character)) return '';
    if (isRefusedCodePoint(character.codePointAt(0) ?? 0)) return '';
  }
  return segment
    .replace(TITLE_STRAY_RE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,;:\s]+|[,;:.\s]+$/g, '')
    .trim();
}

/**
 * Why a title set is what it is.
 *
 * CS-64 AC2. `deriveTitles` used to return `[]` for a resume it could not read
 * and `[]` for a resume that genuinely names no role, and no caller could tell
 * the two apart — a silent failure dressed as a finding. The extractor's role
 * vocabulary (ROLE_WORDS) is English-only, so "no match" is very often an
 * inability rather than a result, and reporting it as a result is the defect.
 *
 * NOT A LANGUAGE CLAIM, deliberately. Which languages this product supports is
 * CS-64 AC1 and belongs to the owner; nothing here detects, names or decides a
 * language. The three states are about what the extractor could see:
 *
 * - `derived`         — at least one title was recognised.
 * - `no-content`      — there was nothing to read: no experience text and no
 *                       header block. "Determined nothing", honestly.
 * - `undeterminable`  — there WAS text and none of it was recognisable as a
 *                       role. That covers a resume written in a language this
 *                       extractor does not read, and equally an English resume
 *                       whose roles it failed to match. Both are "could not
 *                       determine", which is exactly what it now says.
 */
export type TitleDerivationStatus = 'derived' | 'no-content' | 'undeterminable';

export interface TitleDerivation {
  status: TitleDerivationStatus;
  titles: string[];
}

/**
 * Job titles held, most recent first, followed by the header headline (the line
 * under the name) when it names a role.
 *
 * The headline is kept even when real titles were found, because internal
 * ladder titles are often useless for matching — "Senior Associate" at a
 * consultancy says nothing about the craft, while the headline right above it
 * says "Full Stack Software Engineer".
 *
 * Returns a STATUS alongside the titles, never a bare array: see
 * TitleDerivationStatus for why an empty array was not an honest answer.
 */
export function deriveTitles(text: string, experience: string): TitleDerivation {
  const found: string[] = [];
  const push = (raw: string) => {
    const cleaned = raw
      .replace(DATE_STRIP_RE, ' ')
      .replace(/\s*\(.*?\)\s*/g, ' ')
      .replace(/\s+(?:at|@)\s+.*$/i, '') // "Software Engineer at Acme"
      // A dash with spaces around it separates title from employer; a dash
      // without them is part of the title itself ("Full-Stack Developer").
      .replace(/\s+[-–—]\s+/g, ' | ')
      .replace(/\s+/g, ' ')
      .trim();

    // "Senior Engineer | Acme Corp, Hyderabad" — the role is one segment and the
    // employer and city are others. Keep only the segment naming a role.
    // Constraining per segment, not per line, keeps a real title that merely
    // shares a line with something unusable.
    const segment = cleaned
      .split(/\s*[|•·]\s*/)
      .map((part) => part.replace(/^[,;:\s]+|[,;:.\s]+$/g, ''))
      .map(constrainTitleCharacters)
      .find((part) => part !== '' && ROLE_WORDS.test(part));
    if (!segment) return;

    if (segment.length < 3 || segment.length > 60) return;
    if (/\d{4}/.test(segment)) return;
    const title = presentTitle(segment);
    if (found.some((t) => t.toLowerCase() === title.toLowerCase())) return;
    found.push(title);
  };

  for (const line of experience.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 90) continue;
    if (/^[-•*·]/.test(trimmed)) continue; // bullet: a responsibility, not a title
    if (ROLE_WORDS.test(trimmed)) push(trimmed);
    if (found.length >= 8) break;
  }

  for (const line of headerBlock(text).split('\n')) {
    if (ROLE_WORDS.test(line)) {
      push(line);
      break;
    }
  }
  if (found.length) return { status: 'derived', titles: found };
  // Everything this function was ever able to look at. If it holds no letters
  // there was nothing to read, and saying "no titles" is honest. If it holds
  // text and nothing matched, the extractor could not determine the answer -
  // which is a different statement, and the one that used to be silent.
  const readable = `${experience}\n${headerBlock(text)}`;
  return { status: /\p{L}/u.test(readable) ? 'undeterminable' : 'no-content', titles: [] };
}

/* -------------------------------------------------------------------------- */
/* Skills                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Skills across the whole resume, plus the subset used in the most recent role.
 *
 * Recency matters: someone who used Angular four jobs ago and React today is a
 * stronger React candidate than the flat skill list suggests, so the matcher
 * weights recent skills higher.
 */
export function deriveSkills(
  text: string,
  sections: Sections,
  now = Date.now(),
): { techStack: string[]; recentSkills: string[] } {
  const techStack = normalizeSkillList(extractSkills(text));
  const recentBlock = mostRecentRoleBlock(sections.experience, now);
  const recentSkills = recentBlock ? normalizeSkillList(extractSkills(recentBlock)) : [];
  return { techStack, recentSkills };
}

/**
 * The slice of the experience section describing the latest role. Resumes are
 * usually reverse-chronological but not always, so the block is chosen by the
 * latest end date rather than by position.
 */
function mostRecentRoleBlock(experience: string, now: number): string | null {
  if (!experience) return null;
  const boundaries = roleBoundaries(findDateRanges(experience, now));
  if (boundaries.length === 0) return null;

  let bestPos = 0;
  for (let i = 1; i < boundaries.length; i += 1) {
    if ((boundaries[i]?.end ?? -Infinity) > (boundaries[bestPos]?.end ?? -Infinity)) bestPos = i;
  }

  const current = boundaries[bestPos];
  if (!current) return null;
  // Start a little before the date so the title line above it is included.
  const start = Math.max(0, current.index - 160);

  // A dated sub-item inside the role — a project, a promotion — would otherwise
  // cut the block off above the bullets where the skills actually are, so skip
  // past any boundary too close to be a separate job.
  let end = experience.length;
  for (let i = bestPos + 1; i < boundaries.length; i += 1) {
    const candidate = boundaries[i]?.index ?? experience.length;
    if (candidate - start >= MIN_ROLE_BLOCK) {
      end = candidate;
      break;
    }
  }
  return experience.slice(start, end);
}

/** Shortest slice that could plausibly hold a role's bullet points. */
const MIN_ROLE_BLOCK = 240;

/**
 * One boundary per role. A single role commonly dates itself twice — once on the
 * company line and once on the title line — and treating the repeat as the start
 * of the next role truncates the block to a sliver containing no skills at all.
 */
function roleBoundaries(ranges: DateRange[]): DateRange[] {
  const byIndex = [...ranges].sort((a, b) => a.index - b.index);
  const out: DateRange[] = [];
  for (const range of byIndex) {
    const last = out[out.length - 1];
    if (last && last.start === range.start && last.end === range.end) continue;
    out.push(range);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export interface DerivedFields {
  fullName?: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  techStack: string[];
  recentSkills: string[];
  titles: string[];
  /** Why `titles` is what it is (CS-64 AC2). Never inferrable from the array. */
  titlesStatus: TitleDerivationStatus;
  yearsOfExperience: number | null;
}

export function deriveFields(text: string, now = Date.now()): DerivedFields {
  const sections = splitSections(text);
  const contact = deriveContact(text);
  const { techStack, recentSkills } = deriveSkills(text, sections, now);
  const titles = deriveTitles(text, sections.experience);

  return {
    fullName: deriveName(text, contact.email),
    email: contact.email,
    phone: contact.phone,
    location: deriveLocation(text),
    linkedin: contact.linkedin,
    github: contact.github,
    portfolio: contact.portfolio,
    techStack,
    recentSkills,
    titles: titles.titles,
    titlesStatus: titles.status,
    yearsOfExperience: deriveYears(text, sections.experience, now),
  };
}
