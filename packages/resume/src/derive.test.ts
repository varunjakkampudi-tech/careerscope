import { describe, expect, it } from 'vitest';
import {
  deriveContact,
  deriveEducation,
  deriveEducationClaims,
  deriveFields,
  deriveExperienceClaims,
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
 * Synthetic resume text exercising a letter-spaced headline that PDF extraction
 * has already collapsed, a role dated twice (company line and title line), and
 * a degree abbreviation that looks like a domain.
 */
const RESUME = `ALEX EXAMPLE
FULL STACK SOFTWARE ENGINEER
Pune, India | +1 202-555-0100 | alex.example@example.invalid
linkedin.com/in/example-candidate | github.com/example-candidate

PROFESSIONAL EXPERIENCE
Example Systems Pune, India | Mar 2023 - Present
Formerly Sample Works, now part of Example Group
Senior Associate Mar 2023 - Present
- Built design-system components in React and TypeScript, documented in Storybook.
- Cut Largest Contentful Paint by 40% through code splitting and image policy.
- Authored REST API contracts consumed by three downstream squads.

Northstar Labs Bengaluru, India | Jun 2021 - Feb 2023
Systems Engineer Jun 2021 - Feb 2023
- Maintained Angular dashboards backed by Spring Boot services.
- Wrote PL/SQL reports against Oracle.

TECHNICAL SKILLS
Languages: JavaScript, TypeScript, Java, Python
Frontend: React, Angular, SASS, Storybook
Backend: Node.js, Express, Spring Boot
Cloud: AWS, Docker, Kubernetes

EDUCATION
B.Tech in Information Technology, Example Institute, 2021
`;

describe('deriveContact', () => {
  it('reads email, phone and profile links', () => {
    const contact = deriveContact(RESUME);
    expect(contact.email).toBe('alex.example@example.invalid');
    expect(contact.phone).toBe('+1 202-555-0100');
    expect(contact.linkedin).toBe('https://www.linkedin.com/in/example-candidate');
    expect(contact.github).toBe('https://www.github.com/example-candidate');
  });

  it('does not mistake a degree abbreviation for a personal site', () => {
    // "B.Tech" parses as domain + TLD if the label length is not constrained.
    expect(deriveContact(RESUME).portfolio).toBeUndefined();
    expect(deriveContact('M.Tech in CSE, 2019').portfolio).toBeUndefined();
  });

  it('still finds a real portfolio domain', () => {
    const contact = deriveContact('Portfolio: candidate.dev | mail me at a@b.com');
    expect(contact.portfolio).toBe('https://candidate.dev');
  });

  it('ignores the domain the email itself is on', () => {
    const contact = deriveContact('jane@acme.io — see acme.io for details');
    expect(contact.portfolio).toBeUndefined();
  });
});

describe('deriveName', () => {
  it('orders surname-first headers using the email local part', () => {
    expect(deriveName(RESUME, 'alex.example@example.invalid')).toBe('Alex Example');
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
    expect(deriveLocation(RESUME)).toBe('Pune, India');
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

  it('does not treat education dates as employment duration without an experience section', () => {
    expect(deriveYears('EDUCATION\nExample University 2020 - 2024', '', NOW)).toBeNull();
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

      // Paired positive on the same surface: the synthetic resume fixture still
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
  it('extracts bounded per-role experience claims with source provenance and unverified status', () => {
    const fields = deriveFields(
      [
        'PROFESSIONAL EXPERIENCE',
        'Senior Software Engineer at Acme Corp | Jan 2021 - Present',
        '- Built React services for millions of users.',
        'Software Developer — Beta Labs | Jan 2018 - Dec 2020',
        '- Delivered TypeScript applications.',
        'EDUCATION',
        'Bachelor of Science, Example University, 2017',
      ].join('\n'),
      NOW,
    );
    expect(fields.experienceClaims).toHaveLength(2);
    expect(fields.experienceClaims[0]).toMatchObject({
      title: 'Senior Software Engineer',
      employer: 'Acme Corp',
      startDate: Date.UTC(2021, 0, 1),
      endDate: NOW,
      sourceSection: 'experience',
      claimStatus: 'unverified',
      description: expect.stringContaining('Built React services'),
    });
    expect(fields.experienceClaims[1]).toMatchObject({
      title: 'Software Developer',
      employer: 'Beta Labs',
      startDate: Date.UTC(2018, 0, 1),
      endDate: Date.UTC(2020, 11, 1),
      claimStatus: 'unverified',
    });
    expect(fields.extractionEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'experience',
          sourceSection: 'experience',
          evidenceKind: 'direct-claim',
        }),
      ]),
    );
  });

  it('does not create work-history claims from education dates or invent employer fields', () => {
    expect(
      deriveFields('EDUCATION\nBachelor of Science, University, 2018-2022', NOW).experienceClaims,
    ).toEqual([]);
    const [claim] = deriveExperienceClaims(
      'Engineer Jan 2020 - Jan 2022\nBuilt reliable systems.',
      NOW,
    );
    expect(claim).toMatchObject({ title: 'Engineer', claimStatus: 'unverified' });
    expect(claim).not.toHaveProperty('employer');
  });

  it('does not infer an employer from an unrelated preceding experience sentence', () => {
    const [claim] = deriveExperienceClaims(
      'Worked on cloud migration and reliability\nEngineer | Jan 2020 - Jan 2022\nBuilt distributed services.',
      NOW,
    );
    expect(claim).toMatchObject({ title: 'Engineer', claimStatus: 'unverified' });
    expect(claim).not.toHaveProperty('employer');
  });

  it('does not promote a same-date project line to employer, but accepts an explicit employer label', () => {
    const [ambiguous] = deriveExperienceClaims(
      'Migrated legacy systems | Jan 2020 - Jan 2022\nEngineer | Jan 2020 - Jan 2022\nBuilt distributed services.',
      NOW,
    );
    expect(ambiguous).not.toHaveProperty('employer');
    expect(ambiguous?.sourceText).toContain('Migrated legacy systems');

    const [labeled] = deriveExperienceClaims(
      'Company: Acme Corp | Jan 2020 - Jan 2022\nEngineer | Jan 2020 - Jan 2022\nBuilt distributed services.',
      NOW,
    );
    expect(labeled?.employer).toBe('Acme Corp');
    expect(labeled?.sourceText).toContain('Company: Acme Corp');
  });

  it('bounds a role description before the next undated role header', () => {
    const [first] = deriveExperienceClaims(
      'Senior Engineer | Jan 2020 - Jan 2022\nProduct Designer at Gamma\nDesigned candidate research workflows.',
      NOW,
    );
    expect(first).toBeDefined();
    expect(first).not.toHaveProperty('description');
    expect(first?.sourceText).not.toContain('Designed candidate research workflows');
  });

  it('keeps duplicate role dates together and leaves dated bullet projects inside the role', () => {
    const claims = deriveExperienceClaims(
      [
        'Acme Corp | Jan 2020 - Present',
        'Senior Engineer | Jan 2020 - Present',
        '- Led migration from Jan 2022 - Mar 2022',
        '- Improved service reliability.',
        'Beta Labs | Feb 2017 - Dec 2019',
        'Developer | Feb 2017 - Dec 2019',
        '- Built platform services.',
      ].join('\n'),
      NOW,
    );
    expect(claims).toHaveLength(2);
    expect(claims[0]?.startDate).toBe(Date.UTC(2020, 0, 1));
    expect(claims[0]?.endDate).toBe(NOW);
    expect(claims[0]?.sourceText).toContain('Led migration from Jan 2022 - Mar 2022');
    expect(claims[1]).not.toHaveProperty('employer');
    expect(claims[1]?.sourceText).toContain('Beta Labs');
  });

  it('produces the full derived profile the onboarding form pre-fills', () => {
    const fields = deriveFields(RESUME, NOW);
    expect(fields).toMatchObject({
      fullName: 'Alex Example',
      email: 'alex.example@example.invalid',
      phone: '+1 202-555-0100',
      location: 'Pune, India',
      portfolio: undefined,
    });
    expect(fields.titles[0]).toBe('Senior Associate');
    expect(fields.techStack.length).toBeGreaterThan(8);
    expect(fields.yearsOfExperience).toBeGreaterThan(4);
    expect(fields.education).toEqual(['B.Tech in Information Technology, Example Institute, 2021']);
  });

  it('copies education claims only from the education section without implying verification', () => {
    expect(
      deriveEducation(
        [
          '• B.Sc. Physics, Example University (2019–2023)',
          '',
          'Email: ignored@example.invalid',
        ].join('\n'),
      ),
    ).toEqual(['B.Sc. Physics, Example University (2019–2023)']);
    expect(
      deriveFields('Alex Example\nEDUCATION\nB.A. History, College Name, 2020').education,
    ).toEqual(['B.A. History, College Name, 2020']);
    expect(
      deriveFields('Alex Example\nWORK EXPERIENCE\nEducation Consultant at Acme').education,
    ).toEqual([]);
  });

  it('normalizes structured education details and retains unverified source provenance', () => {
    expect(
      deriveEducationClaims('• B.Tech in Information Technology, Example Institute, 2021'),
    ).toEqual([
      {
        normalizedText: 'B.Tech in Information Technology, Example Institute, 2021',
        sourceText: 'B.Tech in Information Technology, Example Institute, 2021',
        sourceSection: 'education',
        extractionConfidence: 'probable',
        credentialStatus: 'unverified',
        degree: 'Bachelor of Technology',
        fieldOfStudy: 'Information Technology',
        institution: 'Example Institute',
        endYear: 2021,
      },
    ]);
    expect(deriveEducationClaims('Completed relevant coursework')).toEqual([
      {
        normalizedText: 'Completed relevant coursework',
        sourceText: 'Completed relevant coursework',
        sourceSection: 'education',
        extractionConfidence: 'unverified',
        credentialStatus: 'unverified',
      },
    ]);
    expect(
      deriveEducationClaims('Completed relevant coursework, online platform, 2021')[0],
    ).not.toHaveProperty('institution');
    expect(
      deriveEducationClaims(
        'Bachelor of Science in Computer Science from Example University (2020–2023)',
      ),
    ).toMatchObject([
      {
        normalizedText:
          'Bachelor of Science in Computer Science from Example University (2020-2023)',
        sourceSection: 'education',
        extractionConfidence: 'probable',
        credentialStatus: 'unverified',
        degree: 'Bachelor of Science',
        fieldOfStudy: 'Computer Science',
        institution: 'Example University',
        startYear: 2020,
        endYear: 2023,
      },
    ]);
  });

  it('does not infer an institution from an unrelated phrase after at or from', () => {
    expect(
      deriveEducationClaims('Bachelor of Science from 2019 to 2023; internship at Acme')[0],
    ).toMatchObject({
      degree: 'Bachelor of Science',
      credentialStatus: 'unverified',
      extractionConfidence: 'unverified',
    });
    expect(
      deriveEducationClaims('Bachelor of Science from 2019 to 2023; internship at Acme')[0],
    ).not.toHaveProperty('institution');
  });

  it('stops institution extraction before later employment text', () => {
    expect(
      deriveEducationClaims(
        'Bachelor of Science from Example University, internship at Acme, 2020',
      )[0],
    ).toMatchObject({ institution: 'Example University' });
  });

  it('preserves reversed education dates as source text without structured dates', () => {
    const [claim] = deriveEducationClaims('Bachelor of Science, Example University, 2023-2020');
    expect(claim).toMatchObject({
      sourceText: 'Bachelor of Science, Example University, 2023-2020',
      credentialStatus: 'unverified',
      extractionConfidence: 'unverified',
      institution: 'Example University',
    });
    expect(claim).not.toHaveProperty('startYear');
    expect(claim).not.toHaveProperty('endYear');
  });

  it('retains source-section evidence for extracted experience and skill fields', () => {
    const fields = deriveFields(RESUME, NOW);
    expect(fields.extractionEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'techStack',
          sourceSection: 'skills',
          extractionConfidence: 'probable',
        }),
        expect.objectContaining({
          field: 'titles',
          sourceSection: 'experience',
          extractionConfidence: 'probable',
        }),
        expect.objectContaining({
          field: 'education',
          sourceSection: 'education',
          extractionConfidence: 'probable',
          sourceText: 'B.Tech in Information Technology, Example Institute, 2021',
        }),
      ]),
    );
    for (const [field, values] of [
      ['techStack', fields.techStack],
      ['recentSkills', fields.recentSkills],
      ['titles', fields.titles],
      ['education', fields.education],
    ] as const) {
      for (const value of values) {
        expect(
          fields.extractionEvidence.some(
            (evidence) => evidence.field === field && evidence.value === value,
          ),
          field + ' value ' + value + ' should retain source evidence',
        ).toBe(true);
      }
    }
    if (fields.yearsOfExperience !== null) {
      expect(
        fields.extractionEvidence.some(
          (evidence) =>
            evidence.field === 'yearsOfExperience' &&
            evidence.value === String(fields.yearsOfExperience),
        ),
      ).toBe(true);
    }
    expect(fields.extractionEvidence.every((evidence) => evidence.sourceText.length <= 200)).toBe(
      true,
    );
  });

  it('requires whole-token source evidence for extracted skills', () => {
    const fields = deriveFields(
      'PROFESSIONAL EXPERIENCE\nEngineer at Google from Jan 2020 - Jan 2024\nBuilt internal tools.\n\nTECHNICAL SKILLS\nGo',
      NOW,
    );
    expect(fields.techStack).toContain('Go');
    expect(
      fields.extractionEvidence.some(
        (entry) => entry.field === 'techStack' && entry.value === 'Go',
      ),
    ).toBe(true);

    const substringOnly = deriveFields(
      'PROFESSIONAL EXPERIENCE\nEngineer at Google from Jan 2020 - Jan 2024\nBuilt Google integrations.\n\nTECHNICAL SKILLS\nGoogle Workspace',
      NOW,
    );
    expect(
      substringOnly.extractionEvidence.some(
        (entry) => entry.field === 'techStack' && entry.value === 'Go',
      ),
    ).toBe(false);
  });

  it('marks document-wide skill matches as supporting evidence when the occurrence is outside a skill section', () => {
    const fields = deriveFields(
      'EDUCATION\nBachelor of Science in React Studies, Example University, 2020\n',
      NOW,
    );
    const evidence = fields.extractionEvidence.find(
      (entry) => entry.field === 'techStack' && entry.value === 'React',
    );

    expect(fields.techStack).toContain('React');
    expect(evidence).toMatchObject({
      sourceSection: 'document',
      evidenceKind: 'supporting-source',
      extractionConfidence: 'unverified',
    });
  });

  it('labels calculated experience years as supported by employment dates, not directly claimed', () => {
    const fields = deriveFields(
      'PROFESSIONAL EXPERIENCE\nRole A Jan 2020 - Jan 2024\nRole B Jan 2021 - Jan 2023\nBuilt services.',
      NOW,
    );
    const evidence = fields.extractionEvidence.filter(
      (entry) => entry.field === 'yearsOfExperience',
    );
    expect(fields.yearsOfExperience).toBe(4);
    expect(evidence).toHaveLength(2);
    expect(evidence.every((entry) => entry.evidenceKind === 'supporting-source')).toBe(true);
    expect(evidence.every((entry) => /2020|2021|2023|2024/.test(entry.sourceText))).toBe(true);
  });
});

describe('deriveContact on hostile input', () => {
  it('finishes in linear time on a long run of address characters with no @ or domain', () => {
    const started = performance.now();
    expect(deriveContact('a'.repeat(100_000)).email).toBeUndefined();
    expect(deriveContact(`x@${'a'.repeat(100_000)}`).email).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('still reads ordinary and unusual addresses', () => {
    expect(deriveContact('Reach me at first.last+tag@mail.example.co.in today').email).toBe(
      'first.last+tag@mail.example.co.in',
    );
  });
});

describe('deriveFields on hostile input', () => {
  it('finishes in bounded time on dash-heavy text, which backtracks the portfolio pattern quadratically', () => {
    const started = performance.now();
    expect(deriveContact('1-'.repeat(60_000)).portfolio).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('still finds a portfolio link in ordinary text', () => {
    expect(deriveContact('Work: jane-doe.dev and more').portfolio).toBe('https://jane-doe.dev');
  });
});

describe('date ranges on hostile input', () => {
  it('finishes in bounded time on long runs of month names, which backtrack the letter suffix', () => {
    const started = performance.now();
    expect(findDateRanges('jan'.repeat(40_000))).toEqual([]);
    expect(findDateRanges('may'.repeat(40_000))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('still reads full month names, including September, as range ends', () => {
    const ranges = findDateRanges('September 2019 - Present', Date.UTC(2024, 0, 1));
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.start).toBe(Date.UTC(2019, 8, 1));
  });
});

describe('section headings keep job titles out of the heading list (S1-F037)', () => {
  it('keeps a title that starts with a heading word inside its own section', () => {
    const { experience, education } = splitSections(
      ['Experience', 'Education Consultant', 'Built payments.', 'Education', 'BSc Physics'].join(
        '\n',
      ),
    );
    expect(experience).toContain('Built payments.');
    expect(education).toContain('BSc Physics');
    expect(education).not.toContain('Built payments.');
  });

  it('still reads real heading variants', () => {
    const sections = splitSections(
      ['Skills & Tools', 'Go', 'Work Experience:', 'Built payments.'].join('\n'),
    );
    expect(sections.skills).toContain('Go');
    expect(sections.experience).toContain('Built payments.');
  });
});
