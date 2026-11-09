import { describe, expect, it } from 'vitest';
import { segmentResumeText } from './preview-segments.js';

describe('resume preview segmentation', () => {
  it('preserves every character across long text and line boundaries', () => {
    const source = `${'a'.repeat(7)}\n${'b'.repeat(8)}\n${'c'.repeat(9)}`;
    const chunks = segmentResumeText(source, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(source);
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
  });

  it('handles empty text and validates its limit', () => {
    expect(segmentResumeText('')).toEqual(['']);
    expect(() => segmentResumeText('resume', 0)).toThrow(RangeError);
  });
});
