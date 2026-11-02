import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText, tidyText } from './html.js';

// S1-F023 changed the tag scanners so they are linear on hostile input. These tests prove the extracted text
// did not change for real provider markup: the pre-fix pipeline is kept here verbatim and compared with the
// current one on every fixture and on a set of realistic description fragments.
const legacyBlockBoundary =
  /<\/?(?:p|div|section|article|header|footer|main|aside|h[1-6]|ul|ol|dl|dt|dd|table|thead|tbody|tr|blockquote|pre|form|fieldset|figure|figcaption|address|hr)\b[^>]*>/gi;

function legacyHtmlToText(input: string | null | undefined): string {
  if (!input) return '';
  let text = input.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(
    /<(script|style|noscript|iframe|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    '\n',
  );
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(/<\/(?:td|th)\s*>/gi, '\t');
  text = text.replace(legacyBlockBoundary, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  return tidyText(text);
}

const fixtureDir = fileURLToPath(new URL('./scrape/__fixtures__/', import.meta.url));
const fixtures = readdirSync(fixtureDir).filter((name) => name.endsWith('.html'));

const realisticFragments = [
  '<p>We need <strong>React</strong> and <em>TypeScript</em>.</p><ul><li>5+ years of Node.js</li><li>Kafka &amp; Redis</li></ul>',
  '<h3>Nice to have</h3><ul><li>GraphQL</li><li>AWS</li></ul><p>Salary: $120k &ndash; $150k</p>',
  '<div>Line one<br/>Line two<br>Line three</div><table><tr><td>Python</td><td>Go</td></tr></table>',
  '<script>var x = "<b>not text</b>";</script><p>Real text after script</p><!-- hidden comment -->',
  '<p>Use a &lt; b and c &gt; d comparison; &#8217;quoted&#8217; and &#x2014; dash.</p>',
  '<ul><li><a href="https://example.com/apply">Apply here</a></li></ul><iframe src="x"></iframe><p>done</p>',
];

describe('htmlToText keeps extracted text identical to the pre-fix pipeline (S1-F023)', () => {
  it('the legacy copy really removes block tags, so the comparison is meaningful', () => {
    expect(legacyHtmlToText('<p>One</p><p>Two</p>')).toBe('One\n\nTwo');
  });

  it.each(fixtures)('fixture %s', (name) => {
    const html = readFileSync(`${fixtureDir}${name}`, 'utf8');
    expect(htmlToText(html)).toBe(legacyHtmlToText(html));
  });

  it.each(realisticFragments.map((fragment, index) => [index, fragment] as const))(
    'realistic fragment %i',
    (_index, fragment) => {
      expect(htmlToText(fragment)).toBe(legacyHtmlToText(fragment));
    },
  );
});
