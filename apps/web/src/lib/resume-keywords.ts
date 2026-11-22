const stopWords = new Set(
  'about after again all also and any are because been before being between both but can candidate could did does doing down each few from further had has have having here how into itself just more most other our out over own same should some such than that the their them then there these they this those through too under until very was were what when where which while who why will with would your'.split(
    ' ',
  ),
);
const unchangedSForms = new Set([
  'analysis',
  'basis',
  'crisis',
  'economics',
  'ethics',
  'mathematics',
  'news',
  'physics',
  'series',
  'species',
  'status',
  'thesis',
]);

function canonicalToken(token: string): string {
  if (/[+#.-]/u.test(token)) return token;
  if (unchangedSForms.has(token)) return token;
  if (token.endsWith('ies') && token.length > 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith('s') && !token.endsWith('ss') && token.length > 3) return token.slice(0, -1);
  return token;
}

function terms(fields: string[]): string[] {
  const found = new Set<string>();
  const phrases = new Set<string>();
  for (const field of fields) {
    const source = field.toLocaleLowerCase();
    const matches = [
      ...source.matchAll(/(?:\.[\p{L}\p{N}]+|[\p{L}\p{N}]+)(?:[+#]|[.-][\p{L}\p{N}]+)*/gu),
    ];
    const tokens = matches.map((match) => ({
      raw: match[0]!,
      value: canonicalToken(match[0]!),
      start: match.index!,
      end: match.index! + match[0]!.length,
    }));
    for (const token of tokens) {
      if ((token.value.length > 2 || /[+#.-]/u.test(token.value)) && !stopWords.has(token.value)) {
        found.add(token.value);
      }
    }
    for (let index = 0; index < tokens.length - 1; index += 1) {
      const current = tokens[index]!;
      const next = tokens[index + 1]!;
      const separator = source.slice(current.end, next.start);
      const currentEligible =
        (current.value.length > 2 || /[+#.-]/u.test(current.value)) &&
        !stopWords.has(current.value);
      const nextEligible =
        (next.value.length > 2 || /[+#.-]/u.test(next.value)) && !stopWords.has(next.value);
      if (/^\s+$/u.test(separator) && currentEligible && nextEligible) {
        phrases.add(`${current.value} ${next.value}`);
      }
    }
  }
  return [...found, ...phrases];
}

/** Literal token and adjacent-phrase overlap; this does not infer skills or ATS compatibility. */
export function compareResumeKeywords(jobDescription: string, resumeText: string | string[]) {
  const resumeTerms = new Set(terms(Array.isArray(resumeText) ? resumeText : [resumeText]));
  const matched: string[] = [];
  const missing: string[] = [];
  for (const term of terms([jobDescription])) {
    (resumeTerms.has(term) ? matched : missing).push(term);
  }
  return { matched, missing };
}
