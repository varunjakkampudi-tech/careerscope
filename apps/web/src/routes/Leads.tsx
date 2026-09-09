/**
 * The leads screen — the one the whole app exists to show.
 *
 * Filter rail, virtualized table, detail drawer. Three panes on a desktop, one at
 * a time on a phone.
 *
 * ## Filters live in the URL
 *
 * Every filter round-trips through the query string, which makes the state
 * shareable, bookmarkable and survivable across a reload — and, less obviously,
 * makes the back button work: opening a lead pushes `?lead=…`, so Back closes the
 * drawer instead of leaving the screen.
 *
 * `useSearchParams` is therefore the single source of truth. There is no second
 * copy of the filters in component state to fall out of sync with it.
 *
 * ## Selection is not in the URL
 *
 * A `Set<string>` in state, deliberately. It is transient — you tick rows, do
 * something to them, and it's gone. Serialising fifty ids into the address bar
 * would make a shared link mean something different to whoever opened it.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bookmark, Clock3 } from 'lucide-react';
import {
  DEFAULT_MATCH_THRESHOLD,
  LEAD_STATUSES,
  formatScore,
  type LeadStatus,
  type SourceId,
} from '@job-radar/shared';
import {
  useBulkUpdateLeads,
  useExportLeads,
  useLeadCounts,
  useLeads,
  useSkillGap,
  useSources,
  type LeadFilters,
} from '../lib/queries';
import { FilterRail } from '../components/FilterRail';
import { LeadTable } from '../components/LeadTable';
import { LeadDrawer } from '../components/LeadDrawer';
import { SkillGapPanel, SkillGapPanelSkeleton } from '../components/SkillGapPanel';
import { Alert, Button, EmptyState, Select, Skeleton, buttonClass } from '../components/ui';

const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New',
  saved: 'Saved',
  applied: 'Applied',
  interviewing: 'Interviewing',
  rejected: 'Rejected',
  dismissed: 'Dismissed',
};

/* -------------------------------------------------------------------------- */
/* URL <-> filters                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Read the filters out of the query string.
 *
 * Anything unparseable is dropped rather than defaulted loudly — a hand-edited
 * or truncated URL should degrade to a broader list, never to an error page.
 *
 * `sourceIds` is the live catalogue rather than the compiled-in `ALL_SOURCES`,
 * because the job is to reject a stale bookmark naming a source this install no
 * longer has, and only the server knows the current list. Before the catalogue
 * has loaded it is empty, which drops the source filter for one render — the
 * `useMemo` re-runs when it arrives.
 */
export function filtersFromParams(
  params: URLSearchParams,
  sourceIds: readonly SourceId[],
  defaultThreshold = 0,
): LeadFilters {
  const number = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === null || raw === '') return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const list = <T extends string>(key: string, allowed: readonly T[]): T[] | undefined => {
    const raw = params.get(key);
    if (!raw) return undefined;
    const values = raw
      .split(',')
      .filter((value): value is T => (allowed as readonly string[]).includes(value));
    return values.length > 0 ? values : undefined;
  };
  const text = (key: string): string | undefined => params.get(key)?.trim() || undefined;

  const sort = params.get('sort');
  const order = params.get('order');

  return {
    minScore: number('minScore') ?? defaultThreshold,
    sources: list<SourceId>('sources', sourceIds),
    statuses: list<LeadStatus>('statuses', LEAD_STATUSES),
    location: text('location'),
    company: text('company'),
    search: text('q'),
    remoteOnly: params.get('remote') === '1' ? true : undefined,
    postedWithinDays: number('posted'),
    minSalary: number('minSalary'),
    runId: text('run'),
    sort: isSort(sort) ? sort : 'score',
    order: order === 'asc' ? 'asc' : 'desc',
  };
}

/** Only writes what differs from the default, so a plain `/leads` stays plain. */
export function paramsFromFilters(filters: LeadFilters, leadId: string | null): URLSearchParams {
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | undefined | null) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  };

  set('minScore', filters.minScore);
  if (filters.sources?.length) set('sources', filters.sources.join(','));
  if (filters.statuses?.length) set('statuses', filters.statuses.join(','));
  set('location', filters.location);
  set('company', filters.company);
  set('q', filters.search);
  if (filters.remoteOnly) set('remote', '1');
  set('posted', filters.postedWithinDays);
  set('minSalary', filters.minSalary);
  set('run', filters.runId);
  if (filters.sort !== 'score') set('sort', filters.sort);
  if (filters.order !== 'desc') set('order', filters.order);
  set('lead', leadId);

  return params;
}

const SORTS = ['score', 'postedAt', 'company', 'title', 'salary'] as const;
export function freshMatchFilters(): LeadFilters {
  return {
    minScore: DEFAULT_MATCH_THRESHOLD,
    postedWithinDays: 1,
    statuses: ['new', 'saved'],
    sort: 'postedAt',
    order: 'desc',
  };
}

export function savedShortlistFilters(): LeadFilters {
  return { minScore: 0, statuses: ['saved'], sort: 'score', order: 'desc' };
}

function isSort(value: string | null): value is LeadFilters['sort'] {
  return value !== null && (SORTS as readonly string[]).includes(value);
}

/**
 * `SourceId` values, for validating what came out of the URL.
 *
 * Read off the live catalogue rather than importing `ALL_SOURCES`: the point is
 * to reject a stale bookmark naming a source this build no longer has, and only
 * the server knows the current list.
 */
export function Leads() {
  const [params, setParams] = useSearchParams();
  const catalog = useSources();
  const bulk = useBulkUpdateLeads();
  const exportLeads = useExportLeads();

  const sourceIds = useMemo(
    () => (catalog.data?.sources ?? []).map((source) => source.id),
    [catalog.data],
  );

  const filters = useMemo(() => filtersFromParams(params, sourceIds), [params, sourceIds]);
  const activeId = params.get('lead');

  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkStatus, setBulkStatus] = useState<LeadStatus>('saved');

  const leads = useLeads(filters);

  // Keyed on the threshold the user is actually looking at, so the panel and
  // the table are always answering the same question.
  const skillGap = useSkillGap(filters.minScore || DEFAULT_MATCH_THRESHOLD);

  // `replace` keeps a filter tweak out of the history stack — otherwise nudging
  // the threshold slider ten times means ten presses of Back to leave the page.
  // Opening a lead does push, because Back closing the drawer is the point.
  const write = useCallback(
    (next: LeadFilters, leadId: string | null, push = false) => {
      setParams(paramsFromFilters(next, leadId), { replace: !push });
    },
    [setParams],
  );

  const rows = useMemo(() => leads.data?.pages.flatMap((page) => page.items) ?? [], [leads.data]);
  const first = leads.data?.pages[0];
  const total = first?.total ?? 0;
  const facets = first?.facets;

  // The count of every lead stored, ignoring the filters entirely. `total` above
  // is the *filtered* count, so on its own it cannot tell "you have not searched
  // yet" from "your threshold excluded all 162 of them" — and those two need
  // opposite advice. Already in cache: the nav badge in `Layout` asks for it.
  const storedTotal = useLeadCounts().data?.total ?? 0;

  // Everything the *other* filters allow, with the threshold taken back out.
  // The API computes its facets that way on purpose — `leads.ts` calls it
  // "412 leads · 87 at ≥85%" rather than "87 leads · 87 at ≥85%" — because a
  // headline that already had the threshold applied makes the slider illegible:
  // it can only ever say "0 leads · 0 at or above 85%", which states the effect
  // twice and the cause never.
  const beforeThreshold = useMemo(
    () => (facets ? Object.values(facets.byStatus).reduce((sum, n) => sum + n, 0) : total),
    [facets, total],
  );

  const activeLead = activeId ? rows.find((lead) => lead.id === activeId) : undefined;

  const toggleSelect = useCallback((id: string) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelection((current) =>
      current.size === rows.length ? new Set() : new Set(rows.map((lead) => lead.id)),
    );
  }, [rows]);

  const onSort = useCallback(
    (field: LeadFilters['sort']) => {
      // Same column again flips the direction; a new column starts descending,
      // which is what you want for every column here except perhaps title.
      const order = filters.sort === field && filters.order === 'desc' ? 'asc' : 'desc';
      write({ ...filters, sort: field, order }, activeId);
    },
    [filters, activeId, write],
  );

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col gap-4 lg:flex-row">
      {/* Filters. A drawer-height column on desktop; above the table on mobile,
          collapsed into a details element so it doesn't push the list off. */}
      <aside className="lg:w-64 lg:shrink-0">
        <details className="lg:hidden" open={false}>
          <summary className="cursor-pointer rounded-lg border border-border bg-surface px-4 py-3 text-sm font-medium text-ink">
            Filters
          </summary>
          <div className="mt-3">
            <FilterRail
              filters={filters}
              onChange={(next) => write(next, activeId)}
              onReset={() => write(emptyFilters(), activeId)}
              sources={catalog.data?.sources ?? []}
              facets={facets}
            />
          </div>
        </details>
        {/* Sticks below the app header, not at the top of the viewport: that bar
            is translucent with a backdrop blur, so a rail pinned at `top-6` does
            not hide behind it, it smears through it. */}
        <div
          role="region"
          aria-label="Lead filters"
          className="hidden lg:sticky lg:top-[calc(var(--spacing-app-header)+1.5rem)] lg:block lg:max-h-[calc(100dvh-var(--spacing-app-header)-3rem)] lg:overflow-y-auto lg:overscroll-contain lg:pr-3 [scrollbar-gutter:stable]"
        >
          <FilterRail
            filters={filters}
            onChange={(next) => write(next, activeId)}
            onReset={() => write(emptyFilters(), activeId)}
            sources={catalog.data?.sources ?? []}
            facets={facets}
          />
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div>
            <h1 className="text-lg font-semibold text-ink">
              {leads.isLoading ? 'Leads' : `${beforeThreshold.toLocaleString()} leads`}
            </h1>
            <p className="text-xs text-muted">
              {facets
                ? `${facets.aboveThreshold.toLocaleString()} at or above ${formatScore(filters.minScore)}`
                : 'Matched against your resume'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              title="New or saved jobs posted in the last 24 hours with at least 85% match"
              onClick={() => {
                setSelection(new Set());
                write(freshMatchFilters(), null);
              }}
            >
              <Clock3 size={16} aria-hidden="true" />
              Fresh matches
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setSelection(new Set());
                write(savedShortlistFilters(), null);
              }}
            >
              <Bookmark size={16} aria-hidden="true" />
              Saved shortlist
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={exportLeads.isPending}
              onClick={() => exportLeads.mutate({ format: 'xlsx', filters })}
            >
              Export XLSX
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={exportLeads.isPending}
              onClick={() => exportLeads.mutate({ format: 'csv', filters })}
            >
              CSV
            </Button>
          </div>
        </header>

        {exportLeads.isError ? (
          <Alert tone="bad" title="Export failed" className="mb-3">
            {exportLeads.error.message}
          </Alert>
        ) : null}

        {/* The bulk bar only exists when there is something selected — a row of
            permanently-disabled controls is just noise above the table. */}
        {selection.size > 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2">
            <span className="text-sm font-medium text-ink">{selection.size} selected</span>
            <Select
              value={bulkStatus}
              aria-label="Status to apply"
              className="h-8 w-40 text-xs"
              onChange={(event) => setBulkStatus(event.target.value as LeadStatus)}
            >
              {LEAD_STATUSES.map((status) => (
                <option key={status} value={status}>
                  Mark as {STATUS_LABEL[status].toLowerCase()}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="primary"
              loading={bulk.isPending}
              onClick={() =>
                bulk.mutate(
                  { ids: [...selection], status: bulkStatus },
                  { onSuccess: () => setSelection(new Set()) },
                )
              }
            >
              Apply
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelection(new Set())}>
              Clear
            </Button>
            {bulk.isError ? <span className="text-xs text-bad">{bulk.error.message}</span> : null}
          </div>
        ) : null}

        {/* Between the header and the table on purpose: it summarises the set
            below it, and it collapses to one line so it never becomes a wall
            the user has to scroll past to reach the leads.

            Its space is held while the query is in flight. This block sits above
            the table, so a panel that mounts late does not appear — it shoves
            the whole list down, which measured as the entirety of this page's
            layout shift. The placeholder is dropped once the query settles, so a
            profile with no gaps to report still costs nothing. */}
        {skillGap.data ? (
          <SkillGapPanel
            data={skillGap.data}
            className="mb-3"
            onPickSkill={(skill) => write({ ...filters, search: skill }, activeId)}
          />
        ) : skillGap.isPending ? (
          <SkillGapPanelSkeleton className="mb-3" />
        ) : null}

        <div className="flex flex-1 gap-4">
          <div className="flex min-w-0 flex-1 flex-col rounded-card border border-border bg-surface">
            <Body
              isLoading={leads.isLoading}
              isError={leads.isError}
              error={leads.error}
              onRetry={() => void leads.refetch()}
              count={rows.length}
              storedTotal={storedTotal}
              filters={filters}
              onRelax={() => write({ ...filters, minScore: 0.6 }, activeId)}
              onReset={() => write(emptyFilters(), activeId)}
            >
              <LeadTable
                leads={rows}
                threshold={filters.minScore}
                activeId={activeId}
                selection={selection}
                onOpen={(id) => write(filters, id, true)}
                onToggleSelect={toggleSelect}
                onToggleSelectAll={toggleSelectAll}
                sort={filters.sort}
                order={filters.order}
                onSort={onSort}
                hasNextPage={leads.hasNextPage}
                isFetchingNextPage={leads.isFetchingNextPage}
                onLoadMore={() => void leads.fetchNextPage()}
                isRefetching={leads.isRefetching && !leads.isFetchingNextPage}
                className="flex-1"
              />
            </Body>
          </div>

          {activeId ? (
            <LeadDrawer
              leadId={activeId}
              fallback={activeLead}
              threshold={filters.minScore}
              onClose={() => write(filters, null, true)}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function emptyFilters(): LeadFilters {
  return { minScore: DEFAULT_MATCH_THRESHOLD, sort: 'score', order: 'desc' };
}

/* -------------------------------------------------------------------------- */
/* Loading / error / empty                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The three states that aren't "here is the table".
 *
 * The empty state distinguishes *no leads at all* from *no leads matching these
 * filters*, because the fix is completely different — run a search versus loosen
 * the threshold — and a single "No results" message sends half the users to the
 * wrong one.
 *
 * That question is answered by `storedTotal`, the unfiltered count, and not by
 * whether the filters differ from their defaults. The default *is* a filter: the
 * server applies the 85% threshold whether or not the user touched the slider,
 * and a run whose best honest match is 76% then lands every lead outside it. Ask
 * "did they deviate from the defaults" and you tell someone who just completed a
 * 162-lead search to go and run a search — while the skill-gap panel directly
 * above says "4 leads scoring 70%–85%". The two disagreed on screen; this is the
 * side that was wrong.
 */
function Body({
  isLoading,
  isError,
  error,
  onRetry,
  count,
  storedTotal,
  filters,
  onRelax,
  onReset,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onRetry: () => void;
  count: number;
  /** Every lead stored, ignoring filters. Zero here means nothing was searched. */
  storedTotal: number;
  filters: LeadFilters;
  onRelax: () => void;
  onReset: () => void;
  children: ReactNode;
}) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-4">
        <Alert
          tone="bad"
          title="Couldn’t load leads"
          action={
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          }
        >
          {error?.message ?? 'The API did not respond.'}
        </Alert>
      </div>
    );
  }

  if (count === 0) {
    // Leads exist, this view just excludes them all. Say which knob did it and
    // offer the knob, rather than sending them back to a search they already ran.
    return storedTotal > 0 ? (
      <EmptyState
        title="No leads match these filters"
        description={
          filters.minScore > 0.7
            ? `None of your ${storedTotal.toLocaleString()} leads cleared ${formatScore(filters.minScore)}. Jobs whose full description couldn’t be fetched are capped at 80%, so a high bar excludes them entirely.`
            : 'Try widening the filters, or run another search to bring in more listings.'
        }
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {filters.minScore > 0.6 ? (
              <Button size="sm" variant="secondary" onClick={onRelax}>
                Lower the threshold to 60%
              </Button>
            ) : null}
            {/* Only when there is something to reset — otherwise this button
                rewrites the filters it already has and nothing on screen moves,
                which reads as the app ignoring the click. */}
            {hasActiveFilters(filters) ? (
              <Button size="sm" variant="ghost" onClick={onReset}>
                Reset filters
              </Button>
            ) : null}
          </div>
        }
      />
    ) : (
      <EmptyState
        title="No leads yet"
        description="Run a search and every listing found will be scored against your resume. The ones that clear your threshold land here."
        action={
          <Link to="/search" className={buttonClass('primary', 'md')}>
            Start a search
          </Link>
        }
      />
    );
  }

  return <>{children}</>;
}

function hasActiveFilters(filters: LeadFilters): boolean {
  return Boolean(
    filters.minScore !== DEFAULT_MATCH_THRESHOLD ||
    filters.sources?.length ||
    filters.statuses?.length ||
    filters.location ||
    filters.company ||
    filters.search ||
    filters.remoteOnly ||
    filters.postedWithinDays ||
    filters.minSalary ||
    filters.runId,
  );
}
