import { describe, expect, it } from 'vitest';
import {
  detectEmploymentType,
  detectRemote,
  extractDemandedSkills,
  extractDemands,
  extractYears,
} from './demands.js';
import { JAVA_HEAVY_JD, NEAR_EXACT_JD } from './matching.fixtures.js';

function weightOf(demands: { skill: string; weight: number }[], skill: string): number | undefined {
  return demands.find((d) => d.skill === skill)?.weight;
}

describe('extractDemandedSkills', () => {
  it('weights a required skill above a nice-to-have', () => {
    const demands = extractDemandedSkills(NEAR_EXACT_JD, 'Full Stack Software Engineer');
    expect(weightOf(demands, 'React')).toBe(1);
    expect(weightOf(demands, 'TypeScript')).toBe(1);
    expect(weightOf(demands, 'GraphQL')).toBe(0.5);
    expect(weightOf(demands, 'Web3.js')).toBe(0.5);
  });

  it('demotes a skill softened inline even inside a required block', () => {
    const jd = [
      'Requirements',
      '- Strong React and TypeScript',
      '- Familiarity with Kubernetes is a plus',
    ].join('\n');
    const demands = extractDemandedSkills(jd, 'Frontend Engineer');
    expect(weightOf(demands, 'React')).toBe(1);
    expect(weightOf(demands, 'Kubernetes')).toBe(0.5);
  });

  it('keeps the higher weight when a skill is asked for twice', () => {
    const jd = [
      'Nice to have',
      '- Some exposure to Docker',
      'Requirements',
      '- Production Docker experience',
    ].join('\n');
    expect(weightOf(extractDemandedSkills(jd, 'DevOps Engineer'), 'Docker')).toBe(1);
  });

  it('treats the title as a hard requirement', () => {
    // The description never says React; the title does, and that is the firmest
    // statement of intent a posting makes.
    const demands = extractDemandedSkills('We move fast and ship often.', 'React Engineer');
    expect(weightOf(demands, 'React')).toBe(1);
  });

  it('scores an unstructured short posting at required weight', () => {
    const demands = extractDemandedSkills(
      'Looking for someone strong in Node.js and PostgreSQL to join us.',
      'Backend Engineer',
    );
    expect(weightOf(demands, 'Node.js')).toBe(1);
    expect(weightOf(demands, 'PostgreSQL')).toBe(1);
  });

  it('does not treat a benefits section as a requirement block', () => {
    const jd = [
      'Requirements',
      '- Strong Python',
      'What we offer',
      '- A Kubernetes-powered internal platform you never have to touch',
    ].join('\n');
    const demands = extractDemandedSkills(jd, 'Data Engineer');
    expect(weightOf(demands, 'Python')).toBe(1);
    // Mentioned under a neutral heading, so it still counts — but the point is
    // that the "Requirements" block was closed rather than running to the end.
    expect(weightOf(demands, 'Kubernetes')).toBe(1);
  });
});

describe('extractYears', () => {
  it('reads a range', () => {
    expect(extractYears('3-6 years of professional experience')).toEqual({ min: 3, max: 6 });
    expect(extractYears('5 to 8 years of experience required')).toEqual({ min: 5, max: 8 });
    expect(extractYears('4 – 8 yrs experience')).toEqual({ min: 4, max: 8 });
  });

  it('reads an open-ended minimum', () => {
    expect(extractYears('7+ years of experience')).toEqual({ min: 7, max: null });
    expect(extractYears('minimum of 5 years experience')).toEqual({ min: 5, max: null });
    expect(extractYears('at least 2 years of relevant experience')).toEqual({ min: 2, max: null });
  });

  it('prefers the range when a posting states both', () => {
    expect(extractYears('3-6 years of experience. 4+ years in React.')).toEqual({ min: 3, max: 6 });
  });

  it('returns nulls when the posting is silent', () => {
    expect(extractYears('We want someone hungry to learn.')).toEqual({ min: null, max: null });
  });

  it('rejects an implausible figure rather than believing it', () => {
    expect(extractYears('99 years of experience')).toEqual({ min: null, max: null });
  });

  it('reads a transposed range in the order the author meant', () => {
    expect(extractYears('8-3 years of experience')).toEqual({ min: 3, max: 8 });
  });
});

describe('detectRemote', () => {
  it('accepts an unambiguous remote posting', () => {
    expect(detectRemote('This is a fully remote position.')).toBe(true);
    expect(detectRemote('Work from home, anywhere in India.')).toBe(true);
  });

  it('refuses a hybrid posting that mentions remote days', () => {
    expect(detectRemote('Hybrid — 3 days in office, 2 days remote.')).toBe(false);
  });

  it('refuses an explicit denial', () => {
    expect(detectRemote('This is not a remote role.')).toBe(false);
  });

  it('lets an on-site description override the board flag', () => {
    // Boards mislabel constantly; the words in the description win.
    expect(detectRemote('You will work on-site in Pune.', true)).toBe(false);
  });

  it('trusts the board flag when the text says nothing', () => {
    expect(detectRemote('Join our platform team.', true)).toBe(true);
    expect(detectRemote('Join our platform team.', false)).toBe(false);
  });
});

describe('detectEmploymentType', () => {
  it('reads the common phrasings', () => {
    expect(detectEmploymentType('This is a full-time permanent role')).toBe('fulltime');
    expect(detectEmploymentType('6 month contract, extendable')).toBe('contract');
    expect(detectEmploymentType('Summer internship programme')).toBe('internship');
    expect(detectEmploymentType('Part-time, 20 hours a week')).toBe('parttime');
  });

  it('returns null when nothing indicates a type', () => {
    expect(detectEmploymentType('Join our growing team.')).toBeNull();
  });
});

describe('extractDemands', () => {
  it('reads a full posting in one pass', () => {
    const demands = extractDemands({
      title: 'Senior Backend Engineer',
      descriptionText: JAVA_HEAVY_JD,
    });

    expect(demands.minYears).toBe(4);
    expect(demands.maxYears).toBe(8);
    expect(demands.seniority).toBe('senior');
    expect(demands.isRemote).toBe(false);
    expect(demands.skills.map((d) => d.skill)).toEqual(
      expect.arrayContaining(['Java', 'Spring Boot', 'Kafka', 'Oracle DB', 'PL/SQL']),
    );
  });

  it('prefers the provider-supplied employment type over the text', () => {
    const demands = extractDemands({
      title: 'Software Engineer',
      descriptionText: 'A full-time opportunity to consult on contract engagements.',
      employmentType: 'contract',
    });
    expect(demands.employmentType).toBe('contract');
  });

  it('falls back to the title when the description has no level', () => {
    const demands = extractDemands({
      title: 'Staff Engineer',
      descriptionText: 'Build things that matter.',
    });
    expect(demands.seniority).toBe('staff');
  });
});
