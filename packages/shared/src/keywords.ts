/**
 * Excluded-keyword matching shared by the provider pre-filter and the matching
 * engine's hard gate, so the two can never disagree about whether a posting is
 * excluded.
 */

const WORD_CHAR = '\\p{L}\\p{N}_';

/**
 * True when `keyword` appears in `text` as a whole word or phrase (case-insensitive).
 *
 * Boundaries are Unicode letters, digits and underscore, so "intern" excludes
 * "Intern, Backend" but not "Internal Tools Engineer" or "International
 * Payments Engineer". A blank keyword never matches.
 */
export function matchesExcludedKeyword(text: string, keyword: string): boolean {
  const term = keyword.trim().toLowerCase();
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![${WORD_CHAR}])${escaped}(?![${WORD_CHAR}])`, 'u').test(
    text.toLowerCase(),
  );
}
