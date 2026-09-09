import { describe, expect, it } from 'vitest';
import { publicApplicationUrl } from './applicationBrowser.js';

describe('application destinations', () => {
  it.each([
    'http://example.com',
    'file:///tmp/resume',
    'https://localhost',
    'https://127.0.0.1',
    'https://10.0.0.1',
    'https://[::1]',
    'https://user:pass@example.com',
    'https://example.com:8080',
  ])('rejects unsafe destination %s', (url) => {
    expect(() => publicApplicationUrl(url)).toThrow();
  });
  it('accepts a public employer portal', () => {
    expect(publicApplicationUrl('https://jobs.lever.co/acme').hostname).toBe('jobs.lever.co');
  });
});
