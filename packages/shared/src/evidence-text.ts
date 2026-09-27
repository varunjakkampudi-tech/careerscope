/**
 * Control and invisible-formatting code points, expressed as code point ranges
 * rather than a regular expression: a regex literal spelling out \u0000 is
 * exactly what `no-control-regex` exists to stop, and the escape hatch is not
 * available here.
 *
 * This lives in `shared` rather than in `resume` because two packages need the
 * same refusal set for different operations, and the SET is the thing that must
 * not drift. `resume` REJECTS a title segment containing any of these at
 * extraction time (CS-56); `matching` NEUTRALISES them when assembling the
 * `reason` string that becomes stored match evidence (CS-66). Rejecting a
 * reason would discard the explanation of a score, so the two operations
 * legitimately differ — but if their character sets ever diverged, a code point
 * refused at one boundary would be renderable at the other, which is precisely
 * the gap CS-66 exists to close.
 */
export function isRefusedCodePoint(point: number): boolean {
  return (
    point < 0x20 || // C0 controls; whitespace is collapsed to spaces by callers
    point === 0x7f || // DEL
    (point >= 0x80 && point <= 0x9f) || // C1 controls
    (point >= 0x200b && point <= 0x200f) || // zero-width and directional marks
    (point >= 0x202a && point <= 0x202e) || // bidirectional embedding/override
    (point >= 0x2066 && point <= 0x2069) || // bidirectional isolates
    // Variation selectors. These are category Mn, so `\p{M}` in a stray-character
    // pattern — which exists so accents survive — would otherwise ALLOW them
    // straight back in (CS-56 re-review finding F-1, 2026-09-25). They are
    // invisible and exist to make a string render as something other than what
    // it is, which is the stated purpose of this refusal set.
    (point >= 0x180b && point <= 0x180d) || // Mongolian free variation selectors
    (point >= 0xfe00 && point <= 0xfe0f) || // variation selectors 1-16
    (point >= 0xe0100 && point <= 0xe01ef) || // variation selectors supplement
    point === 0xfeff // zero-width no-break space
  );
}

/**
 * Characters that carry meaning in a markup, template or shell-ish renderer.
 *
 * VISIBLE, unlike `isRefusedCodePoint`, and that is why they are a separate
 * set: an invisible character can be deleted without changing what a string
 * says, while deleting a visible one silently rewrites it. Both tiers must be
 * handled, though, because AC2 of CS-66 names markup and template syntax
 * alongside the invisible classes — and until 2026-09-25 only the invisible
 * half was enforced at the evidence boundary, so `<img src=x onerror=...>`
 * typed into a target role reached stored evidence verbatim.
 *
 * Shared for the same reason the code-point predicate is: `resume` REJECTS a
 * title segment containing any of these at extraction (CS-56) and `matching`
 * NEUTRALISES them when assembling stored evidence (CS-66). The OPERATIONS
 * differ deliberately; the SET must not, or a character refused at one
 * boundary is renderable at the other.
 *
 * `$` is deliberately absent. A refused character costs a resume title segment
 * entirely, and "Engineer, $1B Platform segment" is a real title that must not
 * be dropped silently. Template interpolation needs `${`, and `{` is refused,
 * so `${...}` is still defused without it.
 */
export const REFUSED_SYNTAX: ReadonlySet<string> = new Set([
  '<',
  '>',
  '{',
  '}',
  '`',
  '\\',
  '"',
  '=',
  '|',
]);

/**
 * Constrain text that is about to become stored, renderable evidence.
 *
 * NEUTRALISES rather than rejects, deliberately. A match `reason` explains a
 * score; discarding it because one character was hostile would leave a number
 * nobody can audit, which is the failure the reason string exists to prevent.
 *
 * Invisible refused code points are REMOVED — they say nothing, so removing
 * them cannot change what a legitimate reason says. Refused syntax characters
 * are replaced with a SPACE rather than removed, because deleting them would
 * join neighbouring words into text the owner never wrote, and because a
 * space is what keeps `<img src=x onerror=alert(1)> Engineer` readable as the
 * harmless words it then is. Whitespace is collapsed afterwards, so a run of
 * them never widens the result.
 */
export function constrainEvidenceText(text: string): string {
  let out = '';
  for (const character of text) {
    if (isRefusedCodePoint(character.codePointAt(0) ?? 0)) continue;
    out += REFUSED_SYNTAX.has(character) ? ' ' : character;
  }
  return out.replace(/\s+/g, ' ').trim();
}
