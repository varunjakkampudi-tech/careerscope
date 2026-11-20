import { RECRUITMENT_SCAM_INDICATORS, type RecruitmentScamIndicator } from '@careerscope/shared';

const MAX_DESCRIPTION_LENGTH = 100_000;
// Keep negation tied to an action in the same clause. This also handles rules
// whose match begins with a subject, such as "You do not need to pay a fee".
const NEGATED_ACTION =
  /\b(?:no|not|never|without|don't|do not|doesn't|does not)\b(?!\s+(?:only|just)\b)[^,.!?;]{0,48}\b(?:pay|send|submit|provide|deposit|cash|return|refund|transfer|forward|receive|move|process|earn|post|use)\b/i;

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
        const match = pattern.exec(passage);
        if (!match || match.index === undefined) return false;
        const context = passage.slice(Math.max(0, match.index - 48), match.index + match[0].length);
        return !NEGATED_ACTION.test(context);
      })
    ) {
      found.add(code);
    }
  }

  return RECRUITMENT_SCAM_INDICATORS.filter((code) => found.has(code));
}
