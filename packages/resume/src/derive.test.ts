import { describe, expect, it } from 'vitest';
import {
  deriveContact,
  deriveFields,
  deriveLocation,
  deriveName,
  deriveSkills,
  deriveTitles,
  deriveYears,
  findDateRanges,
} from './derive.js';
import { splitSections } from './sections.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');

/**
 * Modelled on the real PDF this was built against: a letter-spaced headline that
 * PDF extraction has already collapsed, a role dated twice (company line and
 * title line), and a degree abbreviation that looks like a domain.
 */
const RESUME = `JAKKAMPUDI VARUN
FULL STACK SOFTWARE ENGINEER
Hyderabad, India | +91 6301655098 | varun.jakkampudi14@gmail.com
linkedin.com/in/jakkampudi-varun | github.com/varunjakkampudi-tech

PROFESSIONAL EXPERIENCE
CREDERA Hyderabad, India | Mar 2023 - Present
Formerly TA Digital, now part of Omnicom Group
Senior Associate Mar 2023 - Present
- Built design-system components in React and TypeScript, documented in Storybook.
- Cut Largest Contentful Paint by 40% through code splitting and image policy.
- Authored REST API contracts consumed by three downstream squads.

INFOSYS Bengaluru, India | Jun 2021 - Feb 2023
Systems Engineer Jun 2021 - Feb 2023
- Maintained Angular dashboards backed by Spring Boot services.
- Wrote PL/SQL reports against Oracle.

TECHNICAL SKILLS
Languages: JavaScript, TypeScript, Java, Python
Frontend: React, Angular, SASS, Storybook
Backend: Node.js, Express, Spring Boot
Cloud: AWS, Docker, Kubernetes

EDUCATION
B.Tech in Information Technology, JNTU Hyderabad, 2021
`;

describe('deriveContact', () => {
  it('reads email, phone and profile links', () => {
    const contact = deriveContact(RESUME);
    expect(contact.email).toBe('varun.jakkampudi14@gmail.com');
    expect(contact.phone).toBe('+91 6301655098');
    expect(contact.linkedin).toBe('https://www.linkedin.com/in/jakkampudi-varun');
    expect(contact.github).toBe('https://www.github.com/varunjakkampudi-tech');
  });

  it('does not mistake a degree abbreviation for a personal site', () => {
    // "B.Tech" parses as domain + TLD if the label length is not constrained.
    expect(deriveContact(RESUME).portfolio).toBeUndefined();
    expect(deriveContact('M.Tech in CSE, 2019').portfolio).toBeUndefined();
  });

  it('still finds a real portfolio domain', () => {
    const contact = deriveContact('Portfolio: varunj.dev | mail me at a@b.com');
    expect(contact.portfolio).toBe('https://varunj.dev');
  });

  it('ignores the domain the email itself is on', () => {
    const contact = deriveContact('jane@acme.io — see acme.io for details');
    expect(contact.portfolio).toBeUndefined();
  });
});

describe('deriveName', () => {
  it('orders surname-first headers using the email local part', () => {
    expect(deriveName(RESUME, 'varun.jakkampudi14@gmail.com')).toBe('Varun Jakkampudi');
  });

  it('leaves an already-first-name-first header alone', () => {
    expect(deriveName('Priya Sharma\nSenior Engineer\n', 'priya.sharma@x.com')).toBe(
      'Priya Sharma',
    );
  });

  it('does not read a job title as a name', () => {
    expect(deriveName('Full Stack Software Engineer\nHyderabad\n')).toBeUndefined();
  });
});

describe('deriveLocation', () => {
  it('reads "City, Country" from the header', () => {
    expect(deriveLocation(RESUME)).toBe('Hyderabad, India');
  });

  it('falls back to a bare known city', () => {
    expect(deriveLocation('Ravi Kumar\nPune • ravi@x.com\n')).toBe('Pune, India');
  });

  it('handles a US city and state', () => {
    expect(deriveLocation('Sam Lee\nAustin, TX | sam@x.com\n')).toBe('Austin, TX');
  });
});

describe('findDateRanges', () => {
  it('parses month-year ranges and "Present"', () => {
    const ranges = findDateRanges('Mar 2023 - Present', NOW);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.start).toBe(Date.UTC(2023, 2, 1));
    expect(ranges[0]?.end).toBe(NOW);
  });

  it('rejects ranges that end before they start', () => {
    expect(findDateRanges('2021 - 2019', NOW)).toHaveLength(0);
  });

  it('rejects end dates implausibly far in the future', () => {
    expect(findDateRanges('Jan 2020 - Dec 2099', NOW)).toHaveLength(0);
  });
});

describe('deriveYears', () => {
  it('prefers an explicitly stated number', () => {
    const text = '7+ years of professional experience\nJan 2024 - Present';
    expect(deriveYears(text, '', NOW)).toBe(7);
  });

  it('measures date ranges when no number is stated', () => {
    const { experience } = splitSections(RESUME);
    // Jun 2021 → Sep 2026, contiguous across the two roles.
    expect(deriveYears(RESUME, experience, NOW)).toBeCloseTo(5.2, 1);
  });

  it('merges overlapping ranges so concurrent roles are not double counted', () => {
    const experience = 'Role A Jan 2020 - Jan 2024\nRole B Jan 2021 - Jan 2023';
    expect(deriveYears('', experience, NOW)).toBeCloseTo(4, 1);
  });

  it('returns null when there is nothing to measure', () => {
    expect(deriveYears('Skills: React', '', NOW)).toBeNull();
  });
});

describe('deriveTitles', () => {
  const { experience } = splitSections(RESUME);

  it('strips the date range off a title line', () => {
    expect(deriveTitles(RESUME, experience)).toContain('Senior Associate');
  });

  it('keeps the header headline alongside internal ladder titles', () => {
    // "Senior Associate" says nothing about the craft; the headline does, and the
    // matcher needs both.
    expect(deriveTitles(RESUME, experience)).toContain('Full Stack Software Engineer');
  });

  it('does not treat a company line as a title', () => {
    expect(deriveTitles(RESUME, experience)).not.toContain('CREDERA Hyderabad, India');
  });

  it('keeps a hyphenated title intact but drops a spaced-dash employer', () => {
    expect(deriveTitles('', 'Full-Stack Developer - Acme Corp, Pune')).toEqual([
      'Full-Stack Developer',
    ]);
  });

  it('drops the employer after a pipe or an "at"', () => {
    expect(deriveTitles('', 'Software Engineer II | Google, Bengaluru')).toEqual([
      'Software Engineer II',
    ]);
    expect(deriveTitles('', 'Backend Developer at Razorpay')).toEqual(['Backend Developer']);
  });

  it('ignores bullet lines describing responsibilities', () => {
    const titles = deriveTitles('', '- Worked with the platform engineer on rollout');
    expect(titles).toHaveLength(0);
  });
});

describe('deriveSkills', () => {
  it('collects the whole stack from the whole document', () => {
    const stack = deriveSkills(RESUME, splitSections(RESUME), NOW).techStack;
    expect(stack).toEqual(
      expect.arrayContaining(['JavaScript', 'TypeScript', 'React', 'Angular', 'AWS', 'Kubernetes']),
    );
  });

  it('scopes recent skills to the latest role even when it is dated twice', () => {
    // The company line and the title line carry the same range; treating the
    // repeat as the next role truncates the block above the bullet points.
    const { recentSkills } = deriveSkills(RESUME, splitSections(RESUME), NOW);
    expect(recentSkills).toEqual(expect.arrayContaining(['React', 'TypeScript', 'Storybook']));
    expect(recentSkills).not.toContain('Angular');
  });

  it('returns no recent skills when the experience section has no dates', () => {
    const sections = splitSections('EXPERIENCE\nSome company, some role\n- did things');
    expect(deriveSkills('React', sections, NOW).recentSkills).toEqual([]);
  });
});

describe('deriveFields', () => {
  it('produces the full derived profile the onboarding form pre-fills', () => {
    const fields = deriveFields(RESUME, NOW);
    expect(fields).toMatchObject({
      fullName: 'Varun Jakkampudi',
      email: 'varun.jakkampudi14@gmail.com',
      phone: '+91 6301655098',
      location: 'Hyderabad, India',
      portfolio: undefined,
    });
    expect(fields.titles[0]).toBe('Senior Associate');
    expect(fields.techStack.length).toBeGreaterThan(8);
    expect(fields.yearsOfExperience).toBeGreaterThan(4);
  });
});
