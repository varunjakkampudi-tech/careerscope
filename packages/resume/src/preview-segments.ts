export function segmentResumeText(text: string, maxLength = 4000): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 1)
    throw new RangeError('maxLength must be positive');
  if (text.length === 0) return [''];
  const segments: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLength, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end - 1);
      if (boundary > start) end = boundary + 1;
    }
    segments.push(text.slice(start, end));
    start = end;
  }
  return segments;
}
