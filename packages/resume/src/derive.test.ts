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
  // CS-64 AC2 changed deriveTitles to report WHY a title set is empty, so it
  // returns { status, titles } rather than a bare array. These assertions are
  // about the titles and keep asserting exactly what they did; the status is
  // exercised on its own below, where it is the subject rather than noise.
  const titlesOf = (text: string, experience: string) => deriveTitles(text, experience).titles;

  const { experience } = splitSections(RESUME);

  it('strips the date range off a title line', () => {
    expect(titlesOf(RESUME, experience)).toContain('Senior Associate');
  });

  it('keeps the header headline alongside internal ladder titles', () => {
    // "Senior Associate" says nothing about the craft; the headline does, and the
    // matcher needs both.
    expect(titlesOf(RESUME, experience)).toContain('Full Stack Software Engineer');
  });

  it('does not treat a company line as a title', () => {
    expect(titlesOf(RESUME, experience)).not.toContain('CREDERA Hyderabad, India');
  });

  it('keeps a hyphenated title intact but drops a spaced-dash employer', () => {
    expect(titlesOf('', 'Full-Stack Developer - Acme Corp, Pune')).toEqual([
      'Full-Stack Developer',
    ]);
  });

  it('drops the employer after a pipe or an "at"', () => {
    expect(titlesOf('', 'Software Engineer II | Google, Bengaluru')).toEqual([
      'Software Engineer II',
    ]);
    expect(titlesOf('', 'Backend Developer at Razorpay')).toEqual(['Backend Developer']);
  });

  it('ignores bullet lines describing responsibilities', () => {
    const titles = titlesOf('', '- Worked with the platform engineer on rollout');
    expect(titles).toHaveLength(0);
  });

  // CS-56: titles are the one derived fact that is not taxonomy-bound, so the
  // character set is constrained at extraction. Before this, every fixture
  // below extracted verbatim — "<img src=x onerror=alert > Senior Engineer"
  // was a stored, API-served match-evidence title.
  describe('character constraint (CS-56)', () => {
    const hostile = [
      ['markup', '<img src=x onerror=alert(1)> Senior Engineer'],
      ['a script tag', 'Software Engineer <script>fetch("/steal")</script>'],
      ['template interpolation', 'Lead Developer ${process.env.SECRET}'],
      ['handlebars/angular syntax', 'Engineer {{constructor.constructor(1)}}'],
      ['a NUL control character', 'Senior Engineer\u0000'],
      ['a BEL control character', 'Senior\u0007Engineer'],
      ['a bidirectional override', 'Senior Engineer\u202erepenoisseD'],
      ['a zero-width joiner', 'Data\u200bScientist'],
      ['a quoted attribute break', 'Senior Engineer" onmouseover="x'],
      ['a backtick shell expansion', 'Senior Engineer `whoami`'],
      // F-1 (re-review 2026-09-25): these are category Mn, so the `\p{M}` allow
      // in TITLE_STRAY_RE — which exists so accents survive — let them back in.
      // Invisible characters that change how a string renders must cost the
      // segment, exactly like the bidi overrides above.
      ['a variation selector', 'Senior Engineer\ufe0f'],
      ['a Mongolian free variation selector', 'Senior\u180bEngineer'],
      ['a supplementary variation selector', 'Senior Engineer\u{e0101}'],
    ] as const;

    it.each(hostile)('refuses a title carrying %s', (_label, line) => {
      const titles = titlesOf('', line);
      expect(titles).toEqual([]);
    });

    it('never emits a title containing a refused character from a whole resume', () => {
      const resume = `JANE DOE
<script>alert(1)</script> Staff Engineer

PROFESSIONAL EXPERIENCE
Senior Engineer {{7*7}} | Acme, Pune | Mar 2023 - Present
- Did things.
Principal Platform Engineer | Acme, Pune | Jan 2020 - Feb 2023
- Did other things.
`;
      const titles = titlesOf(resume, splitSections(resume).experience);
      // F-56-1 (re-review 2026-09-25): THIS ASSERTION IS THE TEST. Without a
      // legitimate role in the fixture, every hostile segment above is refused,
      // `titles` is empty, and the per-character loop below runs ZERO times
      // while still reporting green — a standing guard that proves nothing, and
      // one that a future regression returning `[]` broadly would leave intact.
      // The paired positive belongs in the same test as the negative.
      expect(titles).toContain('Principal Platform Engineer');
      for (const title of titles) {
        // `$` is deliberately NOT here (F-56-2): it was removed from the
        // refusal set, so including it would encode a stale intent about which
        // tier owns it. It is a stray, neutralised to a space, asserted below.
        expect(title).not.toMatch(/[<>{}`\\"=|]/);
        for (const character of title) {
          // Control and invisible-formatting code points, checked numerically
          // because a regex literal spelling them out trips no-control-regex.
          const point = character.codePointAt(0) ?? 0;
          expect(point).toBeGreaterThan(0x1f);
          expect(point === 0x7f || (point >= 0x200b && point <= 0x202e)).toBe(false);
        }
      }
    });

    it('keeps a real title that shares its line with an unusable segment', () => {
      // Refusing per segment rather than per line: the employer segment is
      // unusable, the role segment is a perfectly ordinary title.
      expect(titlesOf('', 'Senior Engineer | <script>Acme</script>, Pune')).toEqual([
        'Senior Engineer',
      ]);
    });

    it('strips a stray decorative character instead of discarding the title', () => {
      expect(titlesOf('', 'Principal Engineer ★')).toEqual(['Principal Engineer']);
    });

    // F-4 (re-review 2026-09-25): `$` used to be a refused character, and a
    // refused character costs the ENTIRE segment. Unlike the other nine
    // refusals, `$` has real probability in a genuine title, so refusing it was
    // the over-strict failure mode this constraint is not allowed to have. It
    // is now a stray: neutralised to a space, title kept.
    it('keeps a real title carrying a currency symbol instead of dropping it', () => {
      expect(titlesOf('', 'Engineer, $1B Platform segment')).toEqual([
        'Engineer, 1B Platform segment',
      ]);
    });

    it('keeps an orthographic Devanagari ZWNJ and rejects a boundary joiner', () => {
      const orthographic = titlesOf('', 'क\u200cष Engineer');
      expect(orthographic).toEqual(['क\u200cष Engineer']);
      expect(titlesOf('', 'क\u200cSenior Engineer')).toEqual([]);
    });

    // Moving `$` out of the refusal set must NOT re-open template
    // interpolation: `${` needs `{`, which is still refused, so the segment
    // still dies. This asserts that composition rather than assuming it.
    it('still refuses template interpolation now that the dollar sign is a stray', () => {
      expect(titlesOf('', 'Engineer ${constructor.constructor(1)}')).toEqual([]);
    });

    it.each([
      ['a hyphen', 'Full-Stack Developer', 'Full-Stack Developer'],
      ['a period', 'Sr. Software Engineer', 'Sr. Software Engineer'],
      ['an ampersand', 'Head of Engineering & Design', 'Head of Engineering & Design'],
      ['a slash', 'Front End Developer/Designer', 'Front End Developer/Designer'],
      ['a comma and a digit', 'Associate Engineer, Tier 3', 'Associate Engineer, Tier 3'],
      ['a plus sign', 'C++ Engineer', 'C++ Engineer'],
      ['a hash', 'C# Developer', 'C# Developer'],
      ['an apostrophe', 'Women’s Health Program Lead', 'Women’s Health Program Lead'],
      ['accented letters', 'Sénior Software Engineer', 'Sénior Software Engineer'],
      ['a tilde-free umlaut', 'Engineer für Zürich', 'Engineer für Zürich'],
    ])('still extracts a real title with %s', (_label, line, expected) => {
      expect(titlesOf('', line)).toEqual([expected]);
    });
  });

  // CS-64 AC2 and AC3. AC1 - which languages this product supports - is the
  // owner's decision and is NOT decided here: nothing below detects or names a
  // language, and no role word in any new language was added. What changed is
  // that "could not determine" stopped being spelled the same way as
  // "determined nothing".
  describe('undeterminable title sets are reported, not silently emptied (CS-64)', () => {
    it('distinguishes cannot-read from nothing-to-read, and still reads English', () => {
      // ALL THREE IN ONE TEST, which AC3 requires and which is the only reason
      // the first assertion is worth anything: a `deriveTitles` broken for
      // everybody would satisfy "the non-English resume yields no titles"
      // perfectly. The English case is the control that proves the function
      // still works, and the empty case is the control that proves the two
      // empty results are genuinely different values rather than one value
      // with two names.
      const nonEnglish = [
        'Ingeniero de software sénior en Acme',
        'Responsable del diseño de sistemas distribuidos',
      ].join('\n');
      const undeterminable = deriveTitles('', nonEnglish);
      expect(undeterminable.status).toBe('undeterminable');
      expect(undeterminable.titles).toEqual([]);

      // Control 1 - English still works, in the same test.
      const english = deriveTitles('', 'Senior Software Engineer | Acme Corp, Pune');
      expect(english.status).toBe('derived');
      expect(english.titles).toEqual(['Senior Software Engineer']);

      // Control 2 - nothing to read is its own answer, and it is NOT the same
      // answer as the first case. This is the assertion that looks redundant
      // and is the entire point of the ticket.
      const empty = deriveTitles('', '   \n\n  ');
      expect(empty.status).toBe('no-content');
      expect(empty.titles).toEqual([]);
      expect(empty.status).not.toBe(undeterminable.status);
    });

    it('carries the status out through deriveFields, where every consumer reads it', () => {
      // A status no caller receives is a comment. deriveFields is the only
      // production path into DerivedResume, so this is where it has to appear.
      const spanish = 'EXPERIENCIA\nIngeniero de software sénior en Acme\n- Diseñó servicios.';
      const unreadable = deriveFields(spanish, NOW);
      expect(unreadable.titles).toEqual([]);
      expect(unreadable.titlesStatus).toBe('undeterminable');

      // Paired positive on the same surface: the real resume fixture still
      // derives titles and says so.
      const readable = deriveFields(RESUME, NOW);
      expect(readable.titlesStatus).toBe('derived');
      expect(readable.titles.length).toBeGreaterThan(0);
    });
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
