import { describe, expect, it } from 'vitest';
import { detectRecruitmentScamIndicators } from './scam-indicators.js';

describe('detectRecruitmentScamIndicators', () => {
  it('flags explicit fees required to apply or get hired', () => {
    expect(
      detectRecruitmentScamIndicators(
        'Pay a registration fee before you can be considered for this position.',
      ),
    ).toEqual(['candidate_upfront_payment']);
    expect(
      detectRecruitmentScamIndicators('Pay a registration fee to be considered for this role.'),
    ).toEqual(['candidate_upfront_payment']);
  });

  it('does not flag clear no-fee disclaimers or ordinary payroll language', () => {
    expect(
      detectRecruitmentScamIndicators(
        'There is no application fee. Employees receive monthly salary payments by direct deposit.',
      ),
    ).toEqual([]);
  });

  it('does not flag a direct statement that paying a fee is unnecessary', () => {
    expect(
      detectRecruitmentScamIndicators('You do not need to pay a registration fee to apply.'),
    ).toEqual([]);
  });

  it('does not let a separate no-fee clause hide an affirmative fee demand', () => {
    expect(
      detectRecruitmentScamIndicators(
        'We do not charge applicants an application fee, but applicants must pay a registration fee to apply.',
      ),
    ).toEqual(['candidate_upfront_payment']);
  });

  it('flags a check deposit followed by a request to send money back', () => {
    expect(
      detectRecruitmentScamIndicators(
        'We will mail you a check to deposit. Send the remaining equipment funds back to our vendor.',
      ),
    ).toEqual(['fake_check_return']);
  });

  it('does not flag warnings that tell applicants never to return deposited check funds', () => {
    expect(
      detectRecruitmentScamIndicators(
        'Never deposit a check and send money back to someone offering you a job.',
      ),
    ).toEqual([]);
  });

  it('flags requests to move employer funds through a personal account', () => {
    expect(
      detectRecruitmentScamIndicators(
        'Receive client funds in your personal bank account and transfer them to our partner.',
      ),
    ).toEqual(['personal_account_money_transfer']);
  });

  it('does not flag a warning against using a personal account', () => {
    expect(
      detectRecruitmentScamIndicators(
        'Never use your personal account to receive or transfer company funds.',
      ),
    ).toEqual([]);
  });

  it('flags explicit compensation for positive reviews but not generic review work', () => {
    expect(
      detectRecruitmentScamIndicators('Earn money by posting positive online reviews.'),
    ).toEqual(['paid_positive_reviews']);
    expect(
      detectRecruitmentScamIndicators('Review customer feedback and summarize recurring issues.'),
    ).toEqual([]);
  });

  it('returns signals in stable order and scans no more than 100,000 characters', () => {
    expect(
      detectRecruitmentScamIndicators(
        `${'x'.repeat(100_000)} Pay an application fee to secure the job.`,
      ),
    ).toEqual([]);
    expect(
      detectRecruitmentScamIndicators(
        'Earn money by posting positive reviews. Pay a registration fee to apply.',
      ),
    ).toEqual(['candidate_upfront_payment', 'paid_positive_reviews']);
  });
});
