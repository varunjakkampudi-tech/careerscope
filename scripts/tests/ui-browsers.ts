/** Select the requested Playwright engines without silently widening a run. */
export function selectUiBrowsers<T>(
  browserTypes: Record<string, T>,
  requested: string | undefined,
): [string, T][] {
  const selection = requested ?? 'all';
  const entries = Object.entries(browserTypes);

  if (selection === 'all') return entries;
  if (!entries.some(([name]) => name === selection)) {
    throw new Error(`Unsupported CAREERSCOPE_UI_BROWSER value: ${selection}`);
  }

  return entries.filter(([name]) => name === selection);
}
