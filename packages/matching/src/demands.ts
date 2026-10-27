/**
 * Reads what a job description asks for: weighted skills, years, remote status, employment type.
 * Feeds `dimensions.ts` and `score.ts`; skill vocabulary comes from `@careerscope/shared`.
 */

import {
  extractSkills,
  normalizeSkillList,
  type DemandedSkill,
  type EmploymentType,
  type JobDemands,
} from '@careerscope/shared';
import { seniorityOf } from './seniority.js';

/*
 * Scoring runs over the job's demands, not the candidate's whole tech stack:
 * scoring against everything a candidate knows would cap the score at the
 * fraction of their skills a job names. Those demands are pulled out of the
 * description first, here.
 */

/** Headings that introduce a hard requirement. */
const REQUIRED_HEADING =
  /^\s*(?:what\s+)?(?:you'?ll\s+need|requirements?|required\s+(?:skills?|qualifications?|experience)|must[- ]haves?|minimum\s+qualifications?|basic\s+qualifications?|key\s+skills?|essential(?:\s+skills?)?|who\s+you\s+are|qualifications?)\b/i;

/** Headings that introduce a soft preference. */
const PREFERRED_HEADING =
  /^\s*(?:nice[- ]to[- ]haves?|preferred\s+(?:skills?|qualifications?|experience)?|bonus(?:\s+points?)?|good\s+to\s+have|desirable|plus(?:es)?|would\s+be\s+a\s+plus|additionally)\b/i;

/** Headings that end a requirements block without starting a new one. */
const NEUTRAL_HEADING =
  /^\s*(?:about\s+(?:us|the\s+(?:company|team|role))|benefits?|perks?|what\s+we\s+offer|compensation|equal\s+opportunity|our\s+(?:mission|values)|why\s+join|how\s+to\s+apply|responsibilities|what\s+you'?ll\s+do|the\s+role|day\s+to\s+day)\b/i;

/** Weights stored on each demanded skill; preferred asks count half as much. */
const REQUIRED_WEIGHT = 1;
const PREFERRED_WEIGHT = 0.5;

/** How firmly the surrounding section heading asks for the skills beneath it. */
type Emphasis = 'required' | 'preferred' | 'neutral';

/**
 * Split a description into blocks by their heading emphasis. Everything before
 * the first heading is neutral — most short board postings are entirely neutral,
 * which is fine: their skills still count, just at the required weight, because
 * an unqualified mention in a short JD is a genuine ask.
 */
function blocksByEmphasis(text: string): { emphasis: Emphasis; body: string }[] {
  const lines = text.split('\n');
  const blocks: { emphasis: Emphasis; body: string[] }[] = [{ emphasis: 'neutral', body: [] }];

  for (const line of lines) {
    // A heading is short and introduces a list; a sentence containing the word
    // "requirements" mid-paragraph is not a heading.
    const isHeadingShaped = line.trim().length > 0 && line.trim().length <= 70;
    if (isHeadingShaped) {
      if (PREFERRED_HEADING.test(line)) {
        blocks.push({ emphasis: 'preferred', body: [] });
        continue;
      }
      if (REQUIRED_HEADING.test(line)) {
        blocks.push({ emphasis: 'required', body: [] });
        continue;
      }
      if (NEUTRAL_HEADING.test(line)) {
        blocks.push({ emphasis: 'neutral', body: [] });
        continue;
      }
    }
    blocks[blocks.length - 1]?.body.push(line);
  }

  return blocks.map((b) => ({ emphasis: b.emphasis, body: b.body.join('\n') }));
}

/** Inline softeners that demote a skill even inside a "required" block. */
const INLINE_PREFERRED =
  /\b(?:nice to have|preferred|a plus|bonus|desirable|familiarity with|exposure to|awareness of|would be (?:a )?(?:plus|great))\b/i;

/**
 * Skills the job asks for, each weighted by how firmly it was asked.
 *
 * A skill named in both a required and a preferred block keeps the higher
 * weight — asking twice never weakens the ask.
 */
export function extractDemandedSkills(descriptionText: string, title: string): DemandedSkill[] {
  const weights = new Map<string, number>();

  const add = (skill: string, weight: number) => {
    const current = weights.get(skill) ?? 0;
    if (weight > current) weights.set(skill, weight);
  };

  // The title is the firmest statement of intent a posting makes.
  for (const skill of extractSkills(title)) add(skill, REQUIRED_WEIGHT);

  for (const { emphasis, body } of blocksByEmphasis(descriptionText)) {
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      const softened = INLINE_PREFERRED.test(line);
      const weight = emphasis === 'preferred' || softened ? PREFERRED_WEIGHT : REQUIRED_WEIGHT;
      for (const skill of extractSkills(line)) add(skill, weight);
    }
  }

  return normalizeSkillList([...weights.keys()]).map((skill) => ({
    skill,
    weight: weights.get(skill) ?? REQUIRED_WEIGHT,
  }));
}

/* -------------------------------------------------------------------------- */
/* Years of experience                                                        */
/* -------------------------------------------------------------------------- */

/** Experience patterns, tried in order: a range, then "N+ years", then a plain "N years of experience". */
const YEAR_RANGE = /(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi;
const YEAR_MIN =
  /(?:minimum\s+(?:of\s+)?|at\s+least\s+|>=?\s*)?(\d{1,2})(?:\.\d)?\s*\+\s*(?:years?|yrs?)\b/gi;
const YEAR_PLAIN =
  /(?:minimum\s+(?:of\s+)?|at\s+least\s+)?(\d{1,2})(?:\.\d)?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:relevant\s+|professional\s+|hands[- ]on\s+|proven\s+|industry\s+|solid\s+)?(?:work\s+)?experience\b/i;

/** How far, in characters, the word "experience" may sit from a years figure. */
const EXPERIENCE_WINDOW = 40;
const EXPERIENCE_WORD = /\b(?:experience|experienced|exp)\b/i;

/**
 * True when "experience" appears within ~40 characters of the match, in the same
 * sentence. "25+ years of history" and "10 years ago" are not experience asks.
 */
function nearExperience(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - EXPERIENCE_WINDOW), start);
  const after = text.slice(end, end + EXPERIENCE_WINDOW);
  const beforeSentence = before.slice(
    Math.max(before.lastIndexOf('.'), before.lastIndexOf('\n')) + 1,
  );
  const afterSentence = after.split(/[.\n]/)[0] ?? '';
  return EXPERIENCE_WORD.test(beforeSentence) || EXPERIENCE_WORD.test(afterSentence);
}

/** The first match of `pattern` (a global regex) that sits next to the word "experience". */
function firstExperienceMatch(text: string, pattern: RegExp): RegExpMatchArray | null {
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (nearExperience(text, start, start + match[0].length)) return match;
  }
  return null;
}

/**
 * The experience band the posting asks for. Returns nulls when the posting is
 * silent, which the experience dimension treats as neutral rather than as a
 * mismatch — most postings simply don't say.
 */
export function extractYears(text: string): { min: number | null; max: number | null } {
  const range = firstExperienceMatch(text, YEAR_RANGE);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    // "8-3 years" is a transposition, not a demand for negative experience.
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    if (isSaneYear(min) && isSaneYear(max)) return { min, max };
  }

  const plus = firstExperienceMatch(text, YEAR_MIN);
  if (plus) {
    const min = Number(plus[1]);
    if (isSaneYear(min)) return { min, max: null };
  }

  const plain = text.match(YEAR_PLAIN);
  if (plain) {
    const min = Number(plain[1]);
    if (isSaneYear(min)) return { min, max: null };
  }

  return { min: null, max: null };
}

/** Bounds a parsed year count to 0..40 so an unrelated number is not read as a requirement. */
function isSaneYear(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 40;
}

/* -------------------------------------------------------------------------- */
/* Remote and employment type                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Remote wording trusted as an explicit statement about the role. A bare
 * "remote" is deliberately absent: "collaborate with remote teams" says nothing
 * about where this job sits.
 */
const REMOTE_RE =
  /\b(?:fully[- ]remote|100%\s*remote|remote[- ]first|remote[- ]only|work\s+from\s+home|wfh|(?:this|the)\s+(?:role|position|job|opportunity)\s+is\s+(?:fully\s+|completely\s+)?remote|remote\s+(?:position|role|job|opportunity))\b/i;
/** A bare "remote" counts only in the title or location, where it describes the job itself. */
const HEADLINE_REMOTE_RE = /\bremote\b/i;
const ONSITE_RE = /\b(?:on[- ]?site|in[- ]office|hybrid|work\s+from\s+office|wfo)\b/i;

/**
 * Whether the job is genuinely remote. "Remote" is checked after the on-site
 * words because postings routinely say "this is not a remote role" and "hybrid —
 * 3 days in office, 2 days remote".
 *
 * `headline` is the title and location. Only there does a bare "remote" count;
 * in the description it needs an explicit phrase such as "fully remote" or
 * "this role is remote".
 */
export function detectRemote(text: string, flagged = false, headline = ''): boolean {
  const all = `${text}\n${headline}`;
  if (/\bnot\s+(?:a\s+)?remote\b|\bno\s+remote\b/i.test(all)) return false;
  if (ONSITE_RE.test(all)) return false;
  if (flagged) return true;
  return HEADLINE_REMOTE_RE.test(headline) || REMOTE_RE.test(text);
}

/** Employment type patterns in priority order; the first match wins. */
const EMPLOYMENT_RE: { type: EmploymentType; re: RegExp }[] = [
  { type: 'internship', re: /\b(?:internship|intern)\b/i },
  {
    type: 'contract',
    // Bare "contract" is not enough: "smart contract systems" is a technology.
    re: /\b(?:contract(?:ual)?[- ](?:role|position|basis|employment|job|opportunity|engagement|to[- ](?:hire|perm\w*))|(?:\d+|one|two|three|six|nine|twelve)[- ]months?\s+contract|(?:employment|job)\s+type\s*[:-]\s*contract|on\s+contract|contractor|freelance|c2h|corp[- ]to[- ]corp|consultancy engagement)\b|\(\s*contract\s*\)/i,
  },
  { type: 'temporary', re: /\b(?:temporary|temp\b|seasonal)\b/i },
  { type: 'parttime', re: /\b(?:part[- ]time)\b/i },
  { type: 'fulltime', re: /\b(?:full[- ]time|permanent)\b/i },
];

/** First employment type named in the text, or null when it names none. */
export function detectEmploymentType(text: string): EmploymentType | null {
  for (const { type, re } of EMPLOYMENT_RE) {
    if (re.test(text)) return type;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/** The posting fields `extractDemands` needs; a stored `Job` satisfies it. */
export interface DemandSource {
  title: string;
  descriptionText: string;
  isRemote?: boolean;
  employmentType?: EmploymentType | null;
  /** Where the job is; with the title, the only place a bare "remote" is believed. */
  location?: string;
}

/** Everything the engine needs to read out of a posting, in one pass. */
export function extractDemands(job: DemandSource): JobDemands {
  const text = `${job.title}\n${job.descriptionText}`;
  const years = extractYears(text);
  return {
    skills: extractDemandedSkills(job.descriptionText, job.title),
    minYears: years.min,
    maxYears: years.max,
    seniority: seniorityOf(job.title) ?? seniorityOf(job.descriptionText.slice(0, 600)),
    isRemote: detectRemote(text, job.isRemote, `${job.title}\n${job.location ?? ''}`),
    employmentType: job.employmentType ?? detectEmploymentType(text),
  };
}
