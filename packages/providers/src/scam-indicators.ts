import { RECRUITMENT_SCAM_INDICATORS, type RecruitmentScamIndicator } from '@careerscope/shared';

const MAX_DESCRIPTION_LENGTH = 100_000;
// Keep negation tied to an action in the same clause. This also handles rules
// whose match begins with a subject, such as "You do not need to pay a fee".
const NEGATED_ACTION =
  /\b(?:no|not|never|without|don't|do not|doesn't|does not)\b(?!\s+(?:only|just)\b)[^,.!?;]{0,48}\b(?:pay|paid|send|submit|provide|deposit|cash|return|refund|transfer|forward|receive|move|process|earn|post|use)\b/i;
const ACTION =
  /\b(?:pay|paid|send|submit|provide|deposit|cash|return|refund|transfer|forward|receive|move|process|earn|post|use)\b/gi;
const CLAUSE_BOUNDARY = /[,;.!?]|\b(?:but|however|yet|though|although)\b/gi;
const NEGATED_FEE_REQUIREMENT =
  /\b(?:no|not|never|without|don't|do not|doesn't|does not)\b[^,.!?;]{0,48}\b(?:application|registration|training|security|equipment)\s+fee\b|\b(?:application|registration|training|security|equipment)\s+fee\b[^,.!?;]{0,20}\b(?:is\s+|are\s+|was\s+|were\s+)?not\s+(?:required|necessary|needed)\b/i;

type Rule = {
  code: RecruitmentScamIndicator;
  pattern: RegExp;
};

const RULES: readonly Rule[] = [
  {
    code: 'candidate_upfront_payment',
    pattern:
      /\b(?:pay|send|submit|provide)\b[^.!?;]{0,50}\b(?:fee|deposit|payment)\b[^.!?;]{0,70}\b(?:to\s+(?:apply|get hired|secure|start|receive|be considered)|before\s+(?:you can|your job|the\s+(?:job|position|role|interview|training|onboarding))|as a condition of employment)\b|\b(?:you|applicants?|candidates?)\b[^.!?;]{0,60}\b(?:must|need to|have to|are required to)\b[^.!?;]{0,40}\b(?:pay|send|submit|provide)\b[^.!?;]{0,40}\b(?:fee|deposit|payment)\b|\b(?:application|registration|training|security|equipment)\s+fee\b[^.!?;]{0,20}\b(?:required|must be paid)\b/i,
  },
  {
    code: 'fake_check_return',
    pattern:
      /\b(?:check|cheque)\b[^;]{0,90}\b(?:deposit|cash|mobile deposit)\b[^;]{0,90}\b(?:send|return|refund|transfer|forward)\b|\b(?:deposit|cash)\b[^;]{0,90}\b(?:check|cheque)\b[^;]{0,90}\b(?:send|return|refund|transfer|forward)\b/i,
  },
  {
    code: 'personal_account_money_transfer',
    pattern:
      /\bpersonal\s+(?:bank\s+)?account\b[^.!?;]{0,90}\b(?:receive|deposit|transfer|move|forward|process|send)\b|\b(?:receive|deposit|transfer|move|forward|process|send)\b[^.!?;]{0,90}\b(?:funds|money|payments?)\b[^.!?;]{0,90}\bpersonal\s+(?:bank\s+)?account\b/i,
  },
  {
    code: 'paid_positive_reviews',
    pattern:
      /\b(?:pay|paid|earn|payment|commission|money)\b[^.!?;]{0,80}\b(?:positive|five[- ]star|5[- ]star)\s+(?:online\s+)?(?:reviews?|ratings?)\b|\b(?:positive|five[- ]star|5[- ]star)\s+(?:online\s+)?(?:reviews?|ratings?)\b[^.!?;]{0,80}\b(?:pay|paid|earn|payment|commission|money)\b/i,
  },
];

/**
 * Detect a small set of explicit recruitment-scam patterns in listing text.
 * This is offline and deterministic: no network, reputation service, or score.
 * A hit means “review this claim,” not that the employer or listing is fraudulent.
 */
export function detectRecruitmentScamIndicators(listingText: string): RecruitmentScamIndicator[] {
  const bounded = listingText.slice(0, MAX_DESCRIPTION_LENGTH);
  // Preserve sentence punctuation so a check/deposit instruction followed by a
  // separate “send the balance back” sentence still has adjacent evidence.
  const passages = bounded.split(/\n+/u);
  const found = new Set<RecruitmentScamIndicator>();

  for (const { code, pattern } of RULES) {
    if (
      passages.some((passage) => {
        const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
        const clauseEnds = [...passage.matchAll(CLAUSE_BOUNDARY)].flatMap((boundary) =>
          boundary.index === undefined ? [] : [boundary.index + boundary[0].length],
        );
        for (const match of passage.matchAll(globalPattern)) {
          if (match.index === undefined) continue;
          const actions = [...match[0].matchAll(ACTION)];
          if (actions.length === 0) {
            const context = passage.slice(
              clauseStartAt(clauseEnds, match.index),
              match.index + match[0].length,
            );
            if (!NEGATED_FEE_REQUIREMENT.test(context)) return true;
            continue;
          }

          if (
            actions.some((action) => {
              if (action.index === undefined) return false;
              const actionIndex = match.index + action.index;
              const context = passage.slice(
                clauseStartAt(clauseEnds, actionIndex),
                actionIndex + action[0].length,
              );
              return !NEGATED_ACTION.test(context);
            })
          ) {
            return true;
          }
        }
        return false;
      })
    ) {
      found.add(code);
    }
  }

  return RECRUITMENT_SCAM_INDICATORS.filter((code) => found.has(code));
}

function clauseStartAt(clauseEnds: readonly number[], index: number): number {
  let low = 0;
  let high = clauseEnds.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const clauseEnd = clauseEnds[middle];
    if (clauseEnd !== undefined && clauseEnd <= index) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? 0 : (clauseEnds[low - 1] ?? 0);
}
