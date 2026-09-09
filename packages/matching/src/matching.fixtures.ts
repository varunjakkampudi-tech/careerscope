import type { CandidateContext, Job } from '@job-radar/shared';

/**
 * Fixtures for the engine's tests. Modelled on the real resume in `data/` and on
 * job descriptions in the shape the ATS providers actually return, so a passing
 * assertion here says something about production behaviour rather than about a
 * strawman.
 *
 * Not part of the built package — excluded in tsconfig.
 */

export const NOW = Date.parse('2026-09-05T12:00:00Z');

/** Varun's profile: full-stack React/Node, Hyderabad, ~4 years. */
export const CANDIDATE: CandidateContext = {
  skills: [
    'JavaScript',
    'TypeScript',
    'React',
    'Next.js',
    'Redux',
    'HTML5',
    'CSS3',
    'SASS',
    'Tailwind CSS',
    'Storybook',
    'Accessibility',
    'Web Performance',
    'Node.js',
    'Express.js',
    'REST API',
    'GraphQL',
    'MongoDB',
    'PostgreSQL',
    'Redis',
    'Docker',
    'AWS',
    'CI/CD',
    'GitHub Actions',
    'Git',
    'Jest',
    'Testing Library',
    'Cypress',
    'Agile',
    'Jira',
    'AEM',
    'Web3.js',
    'Angular',
    'Figma',
  ],
  recentSkills: [
    'JavaScript',
    'TypeScript',
    'React',
    'SASS',
    'Storybook',
    'Accessibility',
    'Web Performance',
    'REST API',
    'AEM',
    'Web3.js',
  ],
  titles: ['Full Stack Software Engineer', 'Senior Associate'],
  yearsOfExperience: 4,
  locations: ['Hyderabad', 'Bangalore', 'Remote'],
  homeLocation: 'Hyderabad, India',
  remoteOnly: false,
  willingToRelocate: true,
  expectedSalary: 2_000_000,
  minSalary: 1_600_000,
  employmentTypes: ['fulltime'],
  excludeKeywords: [],
  excludeCompanies: [],
  resumeText: 'Full Stack Software Engineer with 4 years building React and Node.js products.',
};

export function candidate(overrides: Partial<CandidateContext> = {}): CandidateContext {
  return { ...CANDIDATE, ...overrides };
}

export function job(overrides: Partial<Job> = {}): Job {
  const base: Job = {
    id: 'job-1',
    fingerprint: 'fp-1',
    source: 'greenhouse',
    sourceJobId: '1',
    title: 'Software Engineer',
    company: {
      id: 'co-1',
      name: 'Acme Corp',
      website: 'https://acme.example',
      careersUrl: 'https://acme.example/careers',
      atsPortalUrl: 'https://boards.greenhouse.io/acme',
      careersEmail: null,
      emailConfidence: 'unverified',
    },
    location: 'Hyderabad, India',
    isRemote: false,
    employmentType: 'fulltime',
    salary: {
      raw: null,
      min: null,
      max: null,
      currency: null,
      period: null,
      annualMin: null,
      annualMax: null,
    },
    postedAt: new Date(NOW - 2 * 86_400_000).toISOString(),
    descriptionText: '',
    hasFullDescription: true,
    techStack: [],
    requiredYears: { min: null, max: null },
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    // Greenhouse is the origin, not a re-publisher. Only the aggregators fill
    // this in.
    sourcePublisher: null,
    firstSeenAt: new Date(NOW).toISOString(),
    lastSeenAt: new Date(NOW).toISOString(),
  };
  return { ...base, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* Job descriptions                                                           */
/* -------------------------------------------------------------------------- */

/** Written to fit the candidate closely — this one has to clear 85%. */
export const NEAR_EXACT_JD = `
About the role

We are hiring a Full Stack Software Engineer to build and ship customer-facing
product surfaces end to end. You will own features from design review through
production rollout, working alongside designers and product managers in a small,
senior team.

What you'll do
- Build accessible, performant interfaces used by millions of people every month
- Design and maintain REST APIs backing those interfaces
- Keep our component library healthy and well documented
- Review code, mentor teammates and raise the bar on testing

Requirements
- 3-6 years of professional software engineering experience
- Strong JavaScript and TypeScript, with deep React experience
- Comfortable writing Node.js services and REST API endpoints
- Working knowledge of SASS or a comparable styling approach
- Experience with Storybook and component-driven development
- A real commitment to accessibility and web performance
- Familiarity with Git-based workflows and CI/CD

Nice to have
- Exposure to GraphQL
- Interest in Web3.js and on-chain data

What we offer
Competitive salary, health cover for you and your family, and a genuine hybrid
arrangement out of our Hyderabad office.
`.trim();

/** Same seniority band, completely different craft — must land well under 60%. */
export const JAVA_HEAVY_JD = `
About the role

Our Payments Platform team is looking for a Backend Engineer to work on
high-throughput transaction processing for tier-one banking customers.

Requirements
- 4-8 years of backend engineering experience
- Expert-level Core Java and Spring Boot
- Deep Hibernate and JPA knowledge, including query tuning
- Production experience with Kafka and event-driven architecture
- Strong Oracle DB and PL/SQL skills, including stored procedures
- Kubernetes and Helm in a regulated production environment
- JUnit and a disciplined approach to unit testing

Nice to have
- Cassandra
- Groovy for build tooling

This is an on-site role based in our Chennai delivery centre.
`.trim();

/** All the right words, none of the substance — the confidence clamp's job. */
export const SNIPPET_JD =
  'Full Stack Software Engineer — React, TypeScript, Node.js. Hyderabad. Apply now.';
