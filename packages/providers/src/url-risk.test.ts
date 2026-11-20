import { describe, expect, it } from 'vitest';
import { detectUrlRiskIndicators } from './url-risk.js';

describe('detectUrlRiskIndicators', () => {
  it('does not flag a conventional HTTPS ATS application URL', () => {
    expect(
      detectUrlRiskIndicators(
        'https://boards.greenhouse.io/acme/jobs/4001',
        'https://boards.greenhouse.io/acme/jobs/4001',
      ),
    ).toEqual([]);
  });

  it.each([
    ['plain HTTP', 'http://jobs.example.test/apply', ['http_transport']],
    [
      'embedded credentials',
      'https://applicant:secret@jobs.example.test/apply',
      ['embedded_credentials'],
    ],
    ['a non-standard port', 'https://jobs.example.test:8443/apply', ['nonstandard_port']],
    ['an IP literal host', 'https://192.0.2.4/apply', ['ip_literal_host']],
    ['an internationalized punycode host', 'https://xn--pple-43d.example/apply', ['punycode_host']],
    ['a known shortener', 'https://go.bit.ly/abc123', ['url_shortener']],
    [
      'an absolute external redirect parameter',
      'https://jobs.example.test/apply?redirect=https%3A%2F%2Fevil.example%2Fform',
      ['external_redirect_parameter'],
    ],
    ['an unsupported scheme', 'javascript:alert(1)', ['invalid_url', 'unsupported_scheme']],
    ['a malformed URL', 'https://[broken', ['invalid_url']],
  ])('returns %s as an indicator', (_label, url, expected) => {
    expect(detectUrlRiskIndicators(url, 'https://jobs.example.test/listing')).toEqual(expected);
  });

  it('evaluates an external redirect parameter without making a request', () => {
    expect(
      detectUrlRiskIndicators(
        'https://jobs.example.test/apply?next=https%3A%2F%2Fjobs.example.test%2Fform',
        'https://jobs.example.test/listing',
      ),
    ).toEqual([]);
  });

  it.each([
    ['camel-case query key', 'redirectUrl=https%3A%2F%2Fevil.example%2Fform'],
    ['protocol-relative target', 'next=%2F%2Fevil.example%2Fform'],
  ])('detects an external redirect with a %s', (_label, query) => {
    expect(
      detectUrlRiskIndicators(
        `https://jobs.example.test/apply?${query}`,
        'https://jobs.example.test/listing',
      ),
    ).toEqual(['external_redirect_parameter']);
  });

  it('reports an invalid supplied apply URL and inspects the safe source fallback', () => {
    expect(
      detectUrlRiskIndicators('javascript:alert(1)', 'http://boards.example.test/listing'),
    ).toEqual(['http_transport', 'invalid_url', 'unsupported_scheme']);
  });

  it('does not confuse a shortener lookalike with a known shortener', () => {
    expect(
      detectUrlRiskIndicators(
        'https://bit.ly.attacker.example/apply',
        'https://jobs.example.test/listing',
      ),
    ).toEqual([]);
  });
});
