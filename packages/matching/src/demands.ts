import {
  extractSkills,
  normalizeSkillList,
  type DemandedSkill,
  type EmploymentType,
  type JobDemands,
} from '@job-radar/shared';
import { seniorityOf } from './seniority.js';

/**
 * Reading what a job actually asks for.
 *
 * This is the half of the engine that the old `matcher.ts` got wrong: it scored
 * against the candidate's whole tech stack, so naming 5 of someone's 20 skills
 * capped the score at 25% and nothing ever reached the 85% threshold. Scoring
 * has to run over the *job's* demands, which means those demands have to be
 * pulled out of the description first.
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

const REQUIRED_WEIGHT = 1;
const PREFERRED_WEIGHT = 0.5;

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

const YEAR_RANGE = /(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/i;
const YEAR_MIN =
  /(?:minimum\s+(?:of\s+)?|at\s+least\s+|>=?\s*)?(\d{1,2})(?:\.\d)?\s*\+\s*(?:years?|yrs?)\b/i;
const YEAR_PLAIN =
  /(?:minimum\s+(?:of\s+)?|at\s+least\s+)?(\d{1,2})(?:\.\d)?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:relevant\s+|professional\s+|hands[- ]on\s+|proven\s+|industry\s+|solid\s+)?(?:work\s+)?experience\b/i;

/**
 * The experience band the posting asks for. Returns nulls when the posting is
 * silent, which the experience dimension treats as neutral rather than as a
 * mismatch — most postings simply don't say.
 */
export function extractYears(text: string): { min: number | null; max: number | null } {
  const range = text.match(YEAR_RANGE);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    // "8-3 years" is a transposition, not a demand for negative experience.
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    if (isSaneYear(min) && isSaneYear(max)) return { min, max };
  }

  const plus = text.match(YEAR_MIN);
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

function isSaneYear(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 40;
}

/* -------------------------------------------------------------------------- */
/* Remote and employment type                                                 */
/* -------------------------------------------------------------------------- */

const REMOTE_RE =
  /\b(?:fully[- ]remote|100%\s*remote|work\s+from\s+home|remote[- ]first|remote)\b/i;
const ONSITE_RE = /\b(?:on[- ]?site|in[- ]office|hybrid|work\s+from\s+office|wfo)\b/i;

/**
 * Whether the job is genuinely remote. "Remote" is checked after the on-site
 * words because postings routinely say "this is not a remote role" and "hybrid —
 * 3 days in office, 2 days remote".
 */
export function detectRemote(text: string, flagged = false): boolean {
  if (/\bnot\s+(?:a\s+)?remote\b|\bno\s+remote\b/i.test(text)) return false;
  if (ONSITE_RE.test(text)) return false;
  if (flagged) return true;
  return REMOTE_RE.test(text);
}

const EMPLOYMENT_RE: { type: EmploymentType; re: RegExp }[] = [
  { type: 'internship', re: /\b(?:internship|intern)\b/i },
  {
    type: 'contract',
    re: /\b(?:contract|contractor|freelance|c2h|corp[- ]to[- ]corp|consultancy engagement)\b/i,
  },
  { type: 'temporary', re: /\b(?:temporary|temp\b|seasonal)\b/i },
  { type: 'parttime', re: /\b(?:part[- ]time)\b/i },
  { type: 'fulltime', re: /\b(?:full[- ]time|permanent)\b/i },
];

export function detectEmploymentType(text: string): EmploymentType | null {
  for (const { type, re } of EMPLOYMENT_RE) {
    if (re.test(text)) return type;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export interface DemandSource {
  title: string;
  descriptionText: string;
  isRemote?: boolean;
  employmentType?: EmploymentType | null;
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
    isRemote: detectRemote(text, job.isRemote),
    employmentType: job.employmentType ?? detectEmploymentType(text),
  };
}
