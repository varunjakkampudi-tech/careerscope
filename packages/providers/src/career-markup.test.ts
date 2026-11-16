import { describe, expect, it } from 'vitest';
import { readJobPostingMarkup } from './career-markup.js';

const pageUrl = 'https://careers.example/jobs/42';
const markup = (data: unknown) =>
  `<html><script type="application/ld+json">${JSON.stringify(data)}</script></html>`;

describe('readJobPostingMarkup', () => {
  it('reads a posting and structured graph entries without fetching or enabling a source', () => {
    const html = markup({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'JobPosting',
          title: 'Senior Engineer',
          url: '/jobs/42?ref=careers',
          hiringOrganization: { name: 'Example Corp' },
          description: '<p>Build <strong>reliable</strong> systems.</p>',
          jobLocation: {
            address: { addressLocality: 'Pune', addressRegion: 'MH', addressCountry: 'IN' },
          },
          jobLocationType: 'TELECOMMUTE',
          employmentType: ['FULL_TIME', 'CONTRACTOR'],
          datePosted: '2026-11-01',
          validThrough: '2026-12-01',
        },
        { '@type': 'Organization', name: 'Ignored' },
      ],
    });

    expect(readJobPostingMarkup(html, pageUrl)).toEqual([
      {
        title: 'Senior Engineer',
        companyName: 'Example Corp',
        sourceUrl: 'https://careers.example/jobs/42?ref=careers',
        description: 'Build reliable systems.',
        location: 'Pune, MH, IN',
        isRemote: true,
        employmentType: 'FULL_TIME, CONTRACTOR',
        postedAt: '2026-11-01',
        validThrough: '2026-12-01',
      },
    ]);
  });

  it('accepts arrays, multiple nodes, and type arrays; rejects invalid or incomplete entries', () => {
    const html = markup([
      {
        '@type': ['Thing', 'https://schema.org/JobPosting'],
        title: 'Analyst',
        hiringOrganization: { name: 'Acme' },
      },
      { '@type': 'JobPosting', title: 'Missing employer' },
      {
        '@type': 'JobPosting',
        title: 'Unsafe URL',
        hiringOrganization: 'Acme',
        url: 'javascript:alert(1)',
      },
    ]);

    expect(readJobPostingMarkup(html, pageUrl)).toEqual([
      { title: 'Analyst', companyName: 'Acme', sourceUrl: pageUrl },
    ]);
  });

  it('finds script tag ends outside quoted attribute values', () => {
    const posting = JSON.stringify({
      '@type': 'JobPosting',
      title: 'Engineer',
      hiringOrganization: 'Acme',
    });
    const html =
      `<script data-note=">" type="application/ld+json">${posting}</script>` +
      `<script data-note='>' type='application/ld+json'>${posting}</script>`;

    expect(readJobPostingMarkup(html, pageUrl)).toEqual([
      { title: 'Engineer', companyName: 'Acme', sourceUrl: pageUrl },
      { title: 'Engineer', companyName: 'Acme', sourceUrl: pageUrl },
    ]);
  });

  it('skips malformed scripts, oversized content, and non-http page URLs', () => {
    expect(
      readJobPostingMarkup('<script type="application/ld+json">{bad}</script>', pageUrl),
    ).toEqual([]);
    expect(readJobPostingMarkup('x'.repeat(2_000_001), pageUrl)).toEqual([]);
    expect(readJobPostingMarkup(markup({ '@type': 'JobPosting' }), 'file:///etc/passwd')).toEqual(
      [],
    );
  });
});
