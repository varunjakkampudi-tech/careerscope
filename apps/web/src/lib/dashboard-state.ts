/** Pure decisions for dashboard and saved-leads display state, kept out of components so tests need no DOM. */

// `data` matters: a background refetch that fails keeps the last good data, and
// that data should stay on screen rather than being replaced by an error.
type StatQuery = { isPending: boolean; isError: boolean; data?: unknown };

const STAT_ERROR_HINT = 'Could not load';

// A failed stat shows the same "—" as an empty one, so it also carries a
// visible hint; a bare "?" told the reader nothing.
export function statDisplay(
  query: StatQuery,
  label: string | null,
): { value: string; hint: string | null } {
  if (query.isError && query.data === undefined) return { value: '—', hint: STAT_ERROR_HINT };
  if (query.isPending && query.data === undefined) return { value: '—', hint: null };
  return { value: label ?? '—', hint: null };
}

type PanelQuery = { isSuccess: boolean; isError: boolean; data?: unknown };

const hasUsableData = (query: PanelQuery) => query.isSuccess || query.data !== undefined;

// One failed query with nothing to show is enough to make a panel unusable, and
// it must win over "still loading" so the panel never waits forever.
export function panelState(queries: readonly PanelQuery[]): 'error' | 'loading' | 'ready' {
  if (queries.some((query) => query.isError && query.data === undefined)) return 'error';
  if (queries.every(hasUsableData)) return 'ready';
  return 'loading';
}

// The selected lead is local state seeded from the `?lead=` param. When the
// param itself changes (a link followed while already on the screen) the
// selection has to follow it; an unchanged param must never overwrite a
// selection the user made in the list.
export function shouldSyncSelection(
  previousInitialId: string | null,
  initialId: string | null,
  selected: string | null,
): boolean {
  return previousInitialId !== initialId && selected !== initialId;
}
