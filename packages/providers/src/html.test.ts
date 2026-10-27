import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  descriptionToText,
  extractCanonicalUrl,
  extractMailtoAddresses,
  htmlToText,
  isPlausibleEmail,
  looksLikeHtml,
  repairMojibake,
  snippet,
  tidyText,
} from './html.js';

describe('htmlToText', () => {
  it('keeps list items on separate lines', () => {
    // The whole point: a tag-stripper would produce "ReactNode.jsPostgreSQL",
    // which is three skills the matching engine would never find.
    const text = htmlToText('<ul><li>React</li><li>Node.js</li><li>PostgreSQL</li></ul>');

    expect(text).toBe('- React\n- Node.js\n- PostgreSQL');
  });

  it('preserves the required / preferred split the demand extractor keys on', () => {
    const text = htmlToText(
      '<h3>Requirements</h3><ul><li>5+ years of Python</li></ul>' +
        '<h3>Nice to have</h3><ul><li>Kubernetes</li></ul>',
    );

    expect(text).toBe('Requirements\n\n- 5+ years of Python\n\nNice to have\n\n- Kubernetes');
  });

  it('turns paragraphs into blank-line-separated blocks and <br> into line breaks', () => {
    expect(htmlToText('<p>One</p><p>Two<br>Three</p>')).toBe('One\n\nTwo\nThree');
  });

  it('drops script, style and svg content entirely', () => {
    const text = htmlToText(
      '<p>Real text</p><script>var leak = "secret";</script><style>.a{color:red}</style>',
    );

    expect(text).toBe('Real text');
  });

  it('separates inline tags with a space rather than welding words', () => {
    expect(htmlToText('<p><b>Senior</b><i>Engineer</i></p>')).toBe('Senior Engineer');
  });

  it('decodes entities', () => {
    expect(htmlToText('<p>R&amp;D &mdash; 5&nbsp;years&hellip;</p>')).toBe('R&D — 5 years…');
  });

  it('separates table cells with tabs', () => {
    expect(htmlToText('<table><tr><td>Level</td><td>Senior</td></tr></table>')).toBe(
      'Level\tSenior',
    );
  });

  it('never leaves more than one blank line between blocks', () => {
    expect(htmlToText('<div><p>A</p></div><div></div><div><p>B</p></div>')).toBe('A\n\nB');
  });

  it('returns an empty string for null, undefined and empty input', () => {
    expect(htmlToText(null)).toBe('');
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText('')).toBe('');
  });

  it('strips comments', () => {
    expect(htmlToText('<p>Visible<!-- hidden --></p>')).toBe('Visible');
  });

  it('handles a realistic Greenhouse fragment', () => {
    const html = [
      '<p><strong>About the role</strong></p>',
      '<p>We are hiring a Senior Backend Engineer.</p>',
      '<p><strong>Requirements</strong></p>',
      '<ul>',
      '<li>6+ years building services in <strong>Go</strong> or Java</li>',
      '<li>Experience with Kubernetes &amp; Terraform</li>',
      '</ul>',
      '<p><strong>Bonus points</strong></p>',
      '<ul><li>gRPC</li></ul>',
    ].join('');

    expect(htmlToText(html)).toBe(
      [
        'About the role',
        '',
        'We are hiring a Senior Backend Engineer.',
        '',
        'Requirements',
        '',
        '- 6+ years building services in Go or Java',
        '- Experience with Kubernetes & Terraform',
        '',
        'Bonus points',
        '',
        '- gRPC',
      ].join('\n'),
    );
  });
});

describe('decodeEntities', () => {
  it('decodes named entities case-insensitively', () => {
    expect(decodeEntities('&AMP; &lt; &GT;')).toBe('& < >');
  });

  it('decodes decimal and hex numeric entities', () => {
    expect(decodeEntities('&#8377;12,00,000 &#x20B9;')).toBe('₹12,00,000 ₹');
  });

  it('leaves unknown and malformed entities alone', () => {
    expect(decodeEntities('&notarealentity; &#999999999; &;')).toBe(
      '&notarealentity; &#999999999; &;',
    );
  });

  it('leaves lone surrogates as-is rather than producing broken text', () => {
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');
  });

  it('short-circuits when there is no ampersand', () => {
    expect(decodeEntities('plain text')).toBe('plain text');
  });
});

describe('descriptionToText', () => {
  it('honours an explicit isHtml=false', () => {
    expect(descriptionToText('Salary < 20 LPA', false)).toBe('Salary < 20 LPA');
  });

  it('sniffs markup when the provider does not say', () => {
    expect(descriptionToText('<p>Hello</p>')).toBe('Hello');
  });

  it('cleans up a plain-text description that arrives full of tags anyway', () => {
    // Several boards label an HTML field as plain text. Trusting the label
    // would put raw markup in front of the user.
    expect(descriptionToText('<p>Hello</p>', false)).toBe('Hello');
  });

  it('does not treat a less-than sign as markup', () => {
    expect(descriptionToText('Latency < 200ms and > 99.9% uptime')).toBe(
      'Latency < 200ms and > 99.9% uptime',
    );
  });

  it('returns an empty string for nullish input', () => {
    expect(descriptionToText(null)).toBe('');
    expect(descriptionToText(undefined)).toBe('');
  });
});

describe('looksLikeHtml', () => {
  it('recognises real tags', () => {
    expect(looksLikeHtml('<div class="x">')).toBe(true);
    expect(looksLikeHtml('text with <br/> in it')).toBe(true);
  });

  it('rejects bare comparison operators', () => {
    expect(looksLikeHtml('a < b > c')).toBe(false);
    expect(looksLikeHtml('5 <= 10')).toBe(false);
  });
});

describe('tidyText', () => {
  it('collapses spaces and non-breaking spaces but keeps paragraphs', () => {
    expect(tidyText('A   B C\n\n\n\nD')).toBe('A B C\n\nD');
  });

  it('trims each line and the whole string', () => {
    expect(tidyText('  line one   \n   line two  ')).toBe('line one\nline two');
  });

  it('normalises CRLF', () => {
    expect(tidyText('a\r\nb')).toBe('a\nb');
  });
});

describe('snippet', () => {
  it('flattens whitespace', () => {
    expect(snippet('a\n\nb   c')).toBe('a b c');
  });

  it('returns short text unchanged', () => {
    expect(snippet('short', 20)).toBe('short');
  });

  it('clips at a word boundary and marks the cut', () => {
    const result = snippet('alpha beta gamma delta epsilon', 20);

    expect(result).toBe('alpha beta gamma…');
  });

  it('hard-clips when there is no usable word boundary', () => {
    expect(snippet('a'.repeat(40), 10)).toBe(`${'a'.repeat(10)}…`);
  });
});

describe('extractMailtoAddresses', () => {
  it('finds addresses and lowercases them', () => {
    const html = '<a href="mailto:Careers@Example.com">Apply</a>';

    expect(extractMailtoAddresses(html)).toEqual(['careers@example.com']);
  });

  it('strips query parameters', () => {
    const html = '<a href="mailto:jobs@example.com?subject=Hi%20there">Apply</a>';

    expect(extractMailtoAddresses(html)).toEqual(['jobs@example.com']);
  });

  it('de-duplicates repeats across a page', () => {
    const html = '<a href="mailto:hr@x.com">a</a> <a href="mailto:HR@x.com">b</a>';

    expect(extractMailtoAddresses(html)).toEqual(['hr@x.com']);
  });

  it('ignores malformed addresses rather than recording a bad one', () => {
    const html = '<a href="mailto:not-an-email">x</a><a href="mailto:">y</a>';

    expect(extractMailtoAddresses(html)).toEqual([]);
  });

  it('returns an empty list when the page has no mailto at all', () => {
    // The enrichment contract: no observed address means the field stays null,
    // never a constructed careers@<domain> guess.
    expect(extractMailtoAddresses('<p>Apply through our portal.</p>')).toEqual([]);
  });
});

describe('isPlausibleEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isPlausibleEmail('careers@example.co.in')).toBe(true);
    expect(isPlausibleEmail('talent.team+jobs@example.com')).toBe(true);
  });

  it('rejects missing parts and over-long values', () => {
    expect(isPlausibleEmail('careers@')).toBe(false);
    expect(isPlausibleEmail('@example.com')).toBe(false);
    expect(isPlausibleEmail('careers@example')).toBe(false);
    expect(isPlausibleEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});

describe('extractCanonicalUrl', () => {
  it('prefers the canonical link', () => {
    const html =
      '<link rel="canonical" href="https://example.com/jobs/1"/>' +
      '<meta property="og:url" content="https://example.com/other"/>';

    expect(extractCanonicalUrl(html)).toBe('https://example.com/jobs/1');
  });

  it('falls back to og:url', () => {
    const html = '<meta property="og:url" content="https://example.com/jobs/2"/>';

    expect(extractCanonicalUrl(html)).toBe('https://example.com/jobs/2');
  });

  it('returns null when neither is present', () => {
    expect(extractCanonicalUrl('<html><body>nothing</body></html>')).toBeNull();
  });

  it('decodes entities in the extracted url', () => {
    const html = '<link rel="canonical" href="https://example.com/j?a=1&amp;b=2"/>';

    expect(extractCanonicalUrl(html)).toBe('https://example.com/j?a=1&b=2');
  });
});

/**
 * The damaged strings are written as escapes rather than pasted in. Half the
 * characters involved are invisible C1 controls, so a literal would be a test
 * nobody could review and one stray byte away from silently asserting nothing.
 */
describe('repairMojibake', () => {
  /** UTF-8 bytes rendered as Latin-1 — what RemoteOK actually serves. */
  const RIGHT_QUOTE = '\u00e2\u0080\u0099'; // e2 80 99 -> right single quote
  const EM_DASH = '\u00e2\u0080\u0094'; // e2 80 94 -> em dash
  const E_ACUTE = '\u00c3\u00a9'; // c3 a9 -> e acute

  it('repairs the punctuation that dominates the damage', () => {
    expect(repairMojibake(`We${RIGHT_QUOTE}re hiring`)).toBe('We’re hiring');
    expect(repairMojibake(`remote ${EM_DASH} worldwide`)).toBe('remote — worldwide');
    expect(repairMojibake(`Caf${E_ACUTE} Corp`)).toBe('Café Corp');
  });

  it('repairs every occurrence in a long description, not just the first', () => {
    const damaged = `<p>We${RIGHT_QUOTE}re hiring ${EM_DASH} you${RIGHT_QUOTE}ll ship.</p>`;

    expect(repairMojibake(damaged)).toBe('<p>We’re hiring — you’ll ship.</p>');
  });

  it('leaves clean text exactly as it was', () => {
    const clean = 'Senior Engineer — Zürich, naïve café résumé';

    expect(repairMojibake(clean)).toBe(clean);
  });

  it('leaves a lone accented character alone', () => {
    // "Zürich" is one Latin-1 character with no continuation byte after it.
    // Decoding it as UTF-8 would fail, and a looser rule would mangle it.
    expect(repairMojibake('Zürich Labs')).toBe('Zürich Labs');
    expect(repairMojibake('Résumé')).toBe('Résumé');
  });

  it('gives up when the bytes underneath are not valid UTF-8', () => {
    // A lead byte followed by a continuation byte, so it trips the detector,
    // but 0xc3 0x28 is not a legal sequence. Better the odd string than nonsense.
    const notUtf8 = 'A\u00c3(B\u00c2C';

    expect(repairMojibake(notUtf8)).toBe(notUtf8);
  });

  it('gives up when the string contains characters no byte could hold', () => {
    // A real ’ next to damaged text means the string was already decoded once
    // as something wider than Latin-1, so the byte reinterpretation is invalid.
    const mixed = `Don’t ${RIGHT_QUOTE} touch`;

    expect(repairMojibake(mixed)).toBe(mixed);
  });

  it('handles the empty string', () => {
    expect(repairMojibake('')).toBe('');
  });
});
