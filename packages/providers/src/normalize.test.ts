import { describe, expect, it } from 'vitest';
import type { RawJob } from '@job-radar/shared';
import {
  canonicalCompany,
  canonicalLocation,
  canonicalTitle,
  companySlug,
  dedupeJobs,
  jobFingerprint,
  mergeDuplicates,
  normalizeDate,
  normalizeJob,
  normalizeLocation,
  normalizeSalary,
  normalizeUrl,
} from './normalize.js';

const NOW = Date.parse('2026-03-01T00:00:00.000Z');

function rawJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: 'greenhouse',
    sourceJobId: '4001',
    title: 'Senior Backend Engineer',
    companyName: 'Acme Technologies Pvt Ltd',
    location: 'Bengaluru, Karnataka, India',
    hasFullDescription: true,
    sourceUrl: 'https://boards.greenhouse.io/acme/jobs/4001',
    ...overrides,
  };
}

const FULL_JD = [
  'About the role',
  'We are hiring a Senior Backend Engineer to own our payments platform.',
  'Requirements',
  '- 6+ years of professional experience with Node.js and TypeScript',
  '- Strong PostgreSQL and Redis background',
  '- Experience running services on AWS with Kubernetes',
  'Nice to have',
  '- GraphQL',
].join('\n');

describe('normalizeJob', () => {
  it('produces a complete job from a full ATS payload', () => {
    const job = normalizeJob(
      rawJob({
        description: `<p>About the role</p><ul><li>6+ years with Node.js and TypeScript</li><li>PostgreSQL</li></ul>`,
        descriptionIsHtml: true,
        salaryRaw: '₹28,00,000 - ₹42,00,000 per year',
        postedAt: '2026-02-20T10:00:00.000Z',
        applyUrl: 'https://boards.greenhouse.io/acme/jobs/4001#app',
        companyWebsite: 'https://acme.example',
      }),
      { now: NOW },
    );

    expect(job.title).toBe('Senior Backend Engineer');
    expect(job.company.name).toBe('Acme Technologies Pvt Ltd');
    expect(job.company.id).toBe('acme');
    expect(job.company.website).toBe('https://acme.example/');
    expect(job.location).toBe('Bengaluru, Karnataka, India');
    expect(job.descriptionText).toContain('- 6+ years with Node.js and TypeScript');
    expect(job.techStack).toEqual(expect.arrayContaining(['Node.js', 'TypeScript', 'PostgreSQL']));
    expect(job.requiredYears).toEqual({ min: 6, max: null });
    expect(job.salary.annualMin).toBe(2_800_000);
    expect(job.salary.annualMax).toBe(4_200_000);
    expect(job.postedAt).toBe('2026-02-20T10:00:00.000Z');
    expect(job.applyUrl).toBe('https://boards.greenhouse.io/acme/jobs/4001#app');
    expect(job.hasFullDescription).toBe(true);
    expect(job.firstSeenAt).toBe('2026-03-01T00:00:00.000Z');
    expect(job.lastSeenAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('reads skills out of the title as well as the body', () => {
    // A thin listing may never repeat in prose what its title already says.
    const job = normalizeJob(
      rawJob({ title: 'Senior React Native Engineer', description: 'Join our mobile team.' }),
      { now: NOW },
    );

    expect(job.techStack).toContain('React Native');
  });

  it('marks a description-less listing as not full, whatever the board claims', () => {
    const job = normalizeJob(rawJob({ hasFullDescription: true, description: '' }), { now: NOW });

    expect(job.hasFullDescription).toBe(false);
  });

  it('keeps hasFullDescription false when the provider only had a teaser', () => {
    const job = normalizeJob(
      rawJob({ hasFullDescription: false, description: 'Great opportunity for a backend dev.' }),
      { now: NOW },
    );

    expect(job.hasFullDescription).toBe(false);
    expect(job.descriptionText).toBe('Great opportunity for a backend dev.');
  });

  it('falls back to the source url when there is no apply url', () => {
    const job = normalizeJob(rawJob({ applyUrl: undefined }), { now: NOW });

    expect(job.applyUrl).toBe('https://boards.greenhouse.io/acme/jobs/4001');
  });

  it('ignores a relative apply url rather than storing a broken link', () => {
    const job = normalizeJob(rawJob({ applyUrl: '/jobs/4001/apply' }), { now: NOW });

    expect(job.applyUrl).toBe('https://boards.greenhouse.io/acme/jobs/4001');
  });

  it('detects remote from the description when the board does not flag it', () => {
    const job = normalizeJob(
      rawJob({ location: undefined, description: 'This is a fully remote position.' }),
      { now: NOW },
    );

    expect(job.isRemote).toBe(true);
    expect(job.location).toBe('Remote');
  });

  it('says so plainly when the location is unknown and the role is not remote', () => {
    const job = normalizeJob(rawJob({ location: undefined, description: FULL_JD }), { now: NOW });

    expect(job.location).toBe('Location not stated');
  });

  it('infers the employment type from the text when unset', () => {
    const job = normalizeJob(
      rawJob({ employmentType: undefined, description: 'This is a 6 month contract engagement.' }),
      { now: NOW },
    );

    expect(job.employmentType).toBe('contract');
  });

  it('prefers the employment type the board stated', () => {
    const job = normalizeJob(
      rawJob({ employmentType: 'fulltime', description: 'Previously a contract role.' }),
      { now: NOW },
    );

    expect(job.employmentType).toBe('fulltime');
  });

  it('survives an empty payload without inventing values', () => {
    const job = normalizeJob(
      {
        source: 'remoteok',
        sourceJobId: '1',
        title: '',
        companyName: '',
        hasFullDescription: false,
        sourceUrl: 'https://remoteok.com/l/1',
      },
      { now: NOW },
    );

    expect(job.title).toBe('Untitled role');
    expect(job.company.name).toBe('Unknown company');
    expect(job.salary).toEqual({
      raw: null,
      min: null,
      max: null,
      currency: null,
      period: null,
      annualMin: null,
      annualMax: null,
    });
    expect(job.postedAt).toBeNull();
    expect(job.requiredYears).toEqual({ min: null, max: null });
    expect(job.techStack).toEqual([]);
  });
});

describe('jobFingerprint', () => {
  it('matches the same role posted through two different boards', () => {
    const a = jobFingerprint('Senior Backend Engineer', 'Acme Technologies Pvt Ltd', 'Bengaluru');
    const b = jobFingerprint('Senior Backend Engineer (Remote-friendly)', 'Acme', 'Bangalore, KA');

    expect(a).toBe(b);
  });

  it('separates the same title in two cities', () => {
    // Merging these would silently hide one of two jobs the candidate would
    // answer differently.
    const blr = jobFingerprint('Software Engineer', 'Acme', 'Bangalore');
    const hyd = jobFingerprint('Software Engineer', 'Acme', 'Hyderabad');

    expect(blr).not.toBe(hyd);
  });

  it('keys remote roles on "remote" rather than the office city they are listed under', () => {
    const a = jobFingerprint('Platform Engineer', 'Acme', 'Bangalore', true);
    const b = jobFingerprint('Platform Engineer', 'Acme', 'Pune', true);

    expect(a).toBe(b);
  });

  it('separates different companies', () => {
    expect(jobFingerprint('SDE II', 'Acme', 'Pune')).not.toBe(
      jobFingerprint('SDE II', 'Globex', 'Pune'),
    );
  });

  it('is stable across calls', () => {
    expect(jobFingerprint('SDE II', 'Acme', 'Pune')).toBe(jobFingerprint('SDE II', 'Acme', 'Pune'));
  });
});

describe('canonicalTitle', () => {
  it('drops bracketed decoration', () => {
    expect(canonicalTitle('Backend Engineer (Remote) [India]')).toBe('backend engineer');
  });

  it('drops requisition ids', () => {
    expect(canonicalTitle('Data Engineer - JR-2291')).toBe('data engineer');
    expect(canonicalTitle('Data Engineer Req #88213')).toBe('data engineer');
  });

  it('drops gendered suffixes used on European boards', () => {
    expect(canonicalTitle('Software Engineer (m/f/d)')).toBe('software engineer');
  });

  it('keeps the characters that distinguish real technologies', () => {
    expect(canonicalTitle('C++ / C# Developer')).toBe('c++ c# developer');
  });
});

describe('canonicalCompany', () => {
  it('strips legal and generic suffixes', () => {
    expect(canonicalCompany('Acme Technologies Pvt. Ltd.')).toBe('acme');
    expect(canonicalCompany('Acme Solutions India Private Limited')).toBe('acme');
  });

  it('keeps a distinguishing word that is not a suffix', () => {
    expect(canonicalCompany('Acme Health Inc')).toBe('acme health');
  });
});

describe('canonicalLocation', () => {
  it('reduces a full address to its city', () => {
    expect(canonicalLocation('Bengaluru, Karnataka, India')).toBe('bangalore');
  });

  it('applies city aliases in both directions of common usage', () => {
    expect(canonicalLocation('Gurugram')).toBe('gurgaon');
    expect(canonicalLocation('New Delhi, India')).toBe('delhi');
  });

  it('strips work-arrangement words that are not part of the place', () => {
    expect(canonicalLocation('Pune (Hybrid)')).toBe('pune');
    expect(canonicalLocation('Chennai - Remote')).toBe('chennai');
  });
});

describe('companySlug', () => {
  it('is url-safe and stable', () => {
    expect(companySlug('Acme Health Inc')).toBe('acme-health');
  });

  it('hashes rather than colliding when a name is entirely suffixes', () => {
    const a = companySlug('Pvt Ltd');
    const b = companySlug('Private Limited');

    expect(a).toMatch(/^c-[0-9a-f]{10}$/);
    expect(a).not.toBe(b);
  });
});

describe('normalizeSalary', () => {
  it('prefers structured numbers over prose', () => {
    const salary = normalizeSalary(
      rawJob({
        salaryMin: 120_000,
        salaryMax: 150_000,
        salaryCurrency: 'USD',
        salaryPeriod: 'year',
        salaryRaw: 'Competitive, $120k-$150k plus equity',
      }),
    );

    expect(salary.annualMin).toBe(120_000);
    expect(salary.annualMax).toBe(150_000);
    expect(salary.currency).toBe('USD');
    expect(salary.raw).toBe('Competitive, $120k-$150k plus equity');
  });

  it('annualises a monthly figure', () => {
    const salary = normalizeSalary(
      rawJob({ salaryMin: 100_000, salaryCurrency: 'INR', salaryPeriod: 'month' }),
    );

    expect(salary.annualMin).toBe(1_200_000);
  });

  it('swaps a min and max sent the wrong way round', () => {
    const salary = normalizeSalary(rawJob({ salaryMin: 150_000, salaryMax: 120_000 }));

    expect(salary.min).toBe(120_000);
    expect(salary.max).toBe(150_000);
  });

  it('parses Indian prose when there are no numeric fields', () => {
    const salary = normalizeSalary(rawJob({ salaryRaw: '18-24 LPA' }));

    expect(salary.annualMin).toBe(1_800_000);
    expect(salary.annualMax).toBe(2_400_000);
  });

  it('stays null for an undisclosed salary rather than reporting zero', () => {
    const salary = normalizeSalary(rawJob({ salaryRaw: 'Not disclosed' }));

    expect(salary.annualMin).toBeNull();
    expect(salary.annualMax).toBeNull();
    expect(salary.raw).toBe('Not disclosed');
  });

  it('ignores a zero sent in place of a missing number', () => {
    const salary = normalizeSalary(rawJob({ salaryMin: 0, salaryMax: 0 }));

    expect(salary.min).toBeNull();
    expect(salary.max).toBeNull();
  });
});

describe('normalizeLocation', () => {
  it('tidies separators', () => {
    expect(normalizeLocation('Pune|Maharashtra', false)).toBe('Pune, Maharashtra');
  });

  it('re-cases a shouted location', () => {
    expect(normalizeLocation('BENGALURU, INDIA', false)).toBe('Bengaluru, India');
  });

  it('leaves a correctly cased location alone, including state codes', () => {
    expect(normalizeLocation('Bengaluru, KA', false)).toBe('Bengaluru, KA');
  });
});

describe('normalizeDate', () => {
  it('accepts ISO strings', () => {
    expect(normalizeDate('2026-02-20T10:00:00Z', NOW)).toBe('2026-02-20T10:00:00.000Z');
  });

  it('accepts epoch seconds and milliseconds', () => {
    expect(normalizeDate(1_771_286_400, NOW)).toBe('2026-02-17T00:00:00.000Z');
    expect(normalizeDate(1_771_286_400_000, NOW)).toBe('2026-02-17T00:00:00.000Z');
  });

  it('accepts numeric strings', () => {
    expect(normalizeDate('1771286400', NOW)).toBe('2026-02-17T00:00:00.000Z');
  });

  it('clamps a future date to now instead of dropping the listing', () => {
    expect(normalizeDate('2027-01-01T00:00:00Z', NOW)).toBe('2026-03-01T00:00:00.000Z');
  });

  it('returns null for unparseable and absent values', () => {
    expect(normalizeDate('last Tuesday', NOW)).toBeNull();
    expect(normalizeDate('', NOW)).toBeNull();
    expect(normalizeDate(undefined, NOW)).toBeNull();
    expect(normalizeDate(null, NOW)).toBeNull();
  });

  it('rejects an epoch-zero artefact', () => {
    expect(normalizeDate(0, NOW)).toBeNull();
    expect(normalizeDate('1970-01-01T00:00:00Z', NOW)).toBeNull();
  });
});

describe('normalizeUrl', () => {
  it('accepts http and https', () => {
    expect(normalizeUrl('https://example.com/jobs/1')).toBe('https://example.com/jobs/1');
  });

  it('rejects relative, empty and non-http urls', () => {
    expect(normalizeUrl('/jobs/1')).toBeNull();
    expect(normalizeUrl('  ')).toBeNull();
    expect(normalizeUrl(undefined)).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('mailto:careers@example.com')).toBeNull();
  });
});

describe('dedupeJobs', () => {
  const atsFull = normalizeJob(
    rawJob({ source: 'greenhouse', description: FULL_JD, postedAt: '2026-02-20T00:00:00Z' }),
    { now: NOW },
  );
  const scrapedThin = normalizeJob(
    rawJob({
      source: 'naukri',
      sourceJobId: 'n-77',
      companyName: 'Acme',
      location: 'Bangalore',
      hasFullDescription: false,
      description: 'Senior Backend Engineer at Acme.',
      salaryRaw: '28-42 LPA',
      sourceUrl: 'https://naukri.com/job/77',
    }),
    { now: NOW },
  );

  it('collapses the same opening seen through two sources', () => {
    expect(dedupeJobs([atsFull, scrapedThin])).toHaveLength(1);
  });

  it('keeps the copy with the full description', () => {
    const [merged] = dedupeJobs([scrapedThin, atsFull]);

    expect(merged?.source).toBe('greenhouse');
    expect(merged?.hasFullDescription).toBe(true);
  });

  it('backfills the salary the winning copy was missing', () => {
    const [merged] = dedupeJobs([atsFull, scrapedThin]);

    expect(merged?.salary.annualMin).toBe(2_800_000);
  });

  it('keeps genuinely different jobs apart', () => {
    const other = normalizeJob(rawJob({ title: 'Frontend Engineer' }), { now: NOW });

    expect(dedupeJobs([atsFull, other])).toHaveLength(2);
  });

  it('returns an empty array for no input', () => {
    expect(dedupeJobs([])).toEqual([]);
  });
});

describe('mergeDuplicates', () => {
  it('unions tech stacks and widens the seen-at window', () => {
    const a = normalizeJob(rawJob({ description: 'We use Node.js and PostgreSQL.' }), {
      now: Date.parse('2026-02-01T00:00:00Z'),
    });
    const b = normalizeJob(
      rawJob({ source: 'linkedin', description: 'We use Node.js and Redis and Kubernetes.' }),
      { now: NOW },
    );

    const merged = mergeDuplicates(a, b);

    expect(merged.techStack).toEqual(expect.arrayContaining(['PostgreSQL', 'Redis']));
    expect(merged.firstSeenAt).toBe('2026-02-01T00:00:00.000Z');
    expect(merged.lastSeenAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('treats a role as remote if either copy said so', () => {
    const onsite = normalizeJob(rawJob({ description: FULL_JD }), { now: NOW });
    const remote = normalizeJob(
      rawJob({ source: 'remotive', description: `${FULL_JD}\nFully remote.` }),
      { now: NOW },
    );

    expect(mergeDuplicates(onsite, remote).isRemote).toBe(true);
  });

  it('prefers an ATS copy over an aggregator copy of equal richness', () => {
    const ats = normalizeJob(rawJob({ source: 'lever', description: FULL_JD }), { now: NOW });
    const aggregator = normalizeJob(rawJob({ source: 'jsearch', description: FULL_JD }), {
      now: NOW,
    });

    expect(mergeDuplicates(aggregator, ats).source).toBe('lever');
  });
});
