const stopWords = new Set(
  'about after again all also and any are because been before being between both but can candidate could did does doing down each few from further had has have having here how into itself just more most other our out over own same should some such than that the their them then there these they this those through too under until very was were what when where which while who why will with would your'.split(
    ' ',
  ),
);

function canonicalToken(token: string): string {
  if (token.endsWith('ies') && token.length > 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith('s') && !token.endsWith('ss') && token.length > 3) return token.slice(0, -1);
  return token;
}

function terms(value: string): string[] {
  const tokens = (value.toLocaleLowerCase().match(/[\p{L}][\p{L}\p{N}+#.-]{1,}/gu) ?? [])
    .map(canonicalToken)
    .filter((token) => token.length > 2 && !stopWords.has(token));
  const found = new Set(tokens);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    found.add(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return [...found];
}

/** Literal token and adjacent-phrase overlap; this does not infer skills or ATS compatibility. */
export function compareResumeKeywords(jobDescription: string, resumeText: string) {
  const resumeTerms = new Set(terms(resumeText));
  const matched: string[] = [];
  const missing: string[] = [];
  for (const term of terms(jobDescription)) {
    (resumeTerms.has(term) ? matched : missing).push(term);
  }
  return { matched, missing };
}
