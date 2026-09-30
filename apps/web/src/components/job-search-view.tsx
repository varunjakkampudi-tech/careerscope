'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  Download,
  ExternalLink,
  LoaderCircle,
  MapPin,
  RefreshCw,
  Search,
  Square,
} from 'lucide-react';
import type { CollectedJob, CreateSearch, SourceOutcome } from '@careerscope/core';
import { api, SESSION_EXPIRED_EVENT } from '@/lib/api';
import { ownerKey, useSession } from '@/lib/session';
import { SaveJob } from '@/components/saved-leads';
import MatchEvidence from '@/components/match-evidence';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui-states';

const sourceNames = {
  remoteok: 'Remote OK',
  himalayas: 'Himalayas',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  workable: 'Workable',
};
type Run = { id: string; status: string; createdAt: string; request: { query: string } };
type Job = { id: string; data: CollectedJob };
type Detail = {
  runId: string;
  status: string;
  request: CreateSearch;
  sourceOutcomes: SourceOutcome[] | null;
  jobs: Job[];
  events: { cursor: string; type: string; createdAt: string }[];
};

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

// The search/discovery workspace, mechanically extracted from the former
// monolithic page.tsx onto its own real route (CS-6). The visual/behavioural
// redesign this ticket's sibling tickets call for (CS-16 actionable results,
// CS-17 job detail view, CS-18 explainable match score, CS-19 coherent
// save/shortlist flow) is deliberately NOT done here — this move only gives
// each a real, independent route to be rewritten on, rather than bundling a
// large visual change into the routing/auth-boundary change.
function JobSearchWorkspace() {
  const cache = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const session = useSession();
  // CS-61: present exactly when authenticated.
  const owner = session.data?.owner;
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sources, setSources] = useState<CreateSearch['sources']>(['remoteok']);
  const [useProfileTitles, setUseProfileTitles] = useState(false);

  const runs = useQuery({
    queryKey: ownerKey(owner, 'searches'),
    queryFn: ({ signal }) => api<{ items: Run[] }>('/searches', { signal }),
    enabled: !!owner && session.data?.authenticated === true,
    refetchInterval: 5000,
    retry: 1,
  });
  // The run being viewed is addressable (CS forensic audit F-3): a link to a
  // specific discovery run must open THAT run, not whichever one happens to be
  // newest. The URL wins when it carries `?run=`, so back/forward and a shared
  // or bookmarked link are all authoritative; without the parameter the
  // previous behaviour — local selection, else the most recent run — is
  // unchanged. An unknown, foreign-owner or malformed id is simply a run the
  // API refuses (404/400) and surfaces in this view's existing error state;
  // it is never trusted client-side.
  const runParam = params.get('run');
  const selectedId = runParam ?? selected ?? runs.data?.items[0]?.id;
  // Keeps the address bar in step with the selection so the view stays
  // linkable. `push` for a deliberate pick (back returns to the previous run),
  // `replace` for a run this view just created on the owner's behalf — that
  // was never a navigation the owner made.
  function showRun(runId: string, history: 'push' | 'replace' = 'push') {
    setSelected(runId);
    const next = new URLSearchParams(params.toString());
    next.set('run', runId);
    const target = `${pathname}?${next.toString()}`;
    if (history === 'replace') router.replace(target, { scroll: false });
    else router.push(target, { scroll: false });
  }
  const detail = useQuery({
    queryKey: ownerKey(owner, 'searches', selectedId),
    enabled: !!owner && !!selectedId && session.data?.authenticated === true,
    queryFn: ({ signal }) => api<Detail>(`/searches/${selectedId}`, { signal }),
    retry: 1,
    refetchInterval: (query) =>
      ['completed', 'partial', 'failed', 'cancelled'].includes(query.state.data?.status ?? '')
        ? false
        : 10000,
  });
  const search = useMutation({
    mutationFn: (request: CreateSearch) =>
      api<{ runId: string }>('/searches', {
        method: 'POST',
        headers: {
          'x-csrf-token': session.data?.csrf ?? '',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify(request),
      }),
    onSuccess: (result) => {
      showRun(result.runId, 'replace');
      setFilter('');
      exportSearch.reset();
      void cache.invalidateQueries({ queryKey: ['searches'] });
    },
  });
  const cancel = useMutation({
    mutationFn: (runId: string) =>
      api(`/searches/${runId}/cancel`, {
        method: 'POST',
        headers: { 'x-csrf-token': session.data?.csrf ?? '' },
      }),
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: ['searches'] });
    },
  });
  const exportSearch = useMutation({
    mutationFn: async (runId: string) => {
      const result = await api<unknown>(`/searches/${runId}/export`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = `careerscope-search-${runId}.json`;
        document.body.append(link);
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    },
  });

  const streamActive =
    session.data?.authenticated === true &&
    ['queued', 'running'].includes(detail.data?.status ?? '');
  useEffect(() => {
    if (!streamActive || !selectedId) return;
    const source = new EventSource(`/api/searches/${selectedId}/events`);
    const refresh = () => {
      void cache.invalidateQueries({ queryKey: ['searches'] });
    };
    source.addEventListener('progress', refresh);
    source.addEventListener('reset', () => {
      cache.removeQueries({ queryKey: ['searches', selectedId] });
      refresh();
    });
    source.addEventListener('settled', () => {
      source.close();
      refresh();
    });
    source.addEventListener('session-expired', () => {
      source.close();
      // Single centralized handler now (AuthenticatedShell listens for
      // SESSION_EXPIRED_EVENT) — Independent Reviewer finding 3, 2026-09-23:
      // this used to also call router.replace('/?expired=1') itself while
      // AuthenticatedShell separately replaced to plain '/' on the same
      // tick, a last-write-wins race that could silently drop the query
      // param. One dispatch, one listener, one redirect target.
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
      cache.removeQueries({ queryKey: ['searches'] });
      cache.removeQueries({ queryKey: ['profile'] });
      cache.removeQueries({ queryKey: ['leads'] });
    });
    return () => source.close();
  }, [cache, selectedId, streamActive]);

  function startSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (sources.length)
      search.mutate({
        query: useProfileTitles ? 'Saved target roles' : String(data.get('query')),
        sources,
        origin: 'manual',
        ...(useProfileTitles ? { useProfileTitles: true } : {}),
      });
  }

  const filtered = filter.toLowerCase();
  const jobs = (
    detail.data?.jobs.filter(({ data }) =>
      `${data.title} ${data.company} ${data.location}`.toLowerCase().includes(filtered),
    ) ?? []
  ).sort((a, b) => (b.data.match?.score ?? -1) - (a.data.match?.score ?? -1));

  return (
    <div className="workspace">
      <aside className="history">
        <h2>Search History</h2>
        {runs.isPending && <LoadingState message="Loading searches…" />}
        {runs.error && (
          <ErrorState
            title="Could not load your search history"
            message={runs.error.message}
            onRetry={() => runs.refetch()}
          />
        )}
        {runs.data?.items.length === 0 && (
          // The history has no filter control, so this is always the
          // "nothing yet" case (AC3), unlike the results list further down.
          <EmptyState variant="inline" reason="nothing-yet" message="No searches yet." />
        )}
        <nav aria-label="Search history">
          {runs.data?.items.map((run) => (
            <button
              key={run.id}
              aria-current={selectedId === run.id ? 'true' : undefined}
              onClick={() => {
                showRun(run.id);
                setFilter('');
                cancel.reset();
                exportSearch.reset();
              }}
            >
              <strong>{run.request.query}</strong>
              <span>
                {run.status} &middot; {new Date(run.createdAt).toLocaleDateString()}
              </span>
            </button>
          ))}
        </nav>
      </aside>
      <section className="results">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Search Workspace</p>
            <h1>Find Your Next Role</h1>
          </div>
        </div>
        <fieldset className="source-options" disabled={search.isPending}>
          <legend>Sources</legend>
          {(['remoteok', 'himalayas', 'greenhouse', 'lever', 'workable'] as const).map((source) => (
            <label key={source}>
              <input
                type="checkbox"
                checked={sources.includes(source)}
                onChange={(event) =>
                  setSources((current) =>
                    event.target.checked
                      ? [...current, source]
                      : current.filter((selectedSource) => selectedSource !== source),
                  )
                }
              />
              {sourceNames[source]}
            </label>
          ))}
        </fieldset>
        <form className="search-form" onSubmit={startSearch}>
          <label className="discovery-mode">
            <span className="sr-only">Discovery mode</span>
            <select
              aria-label="Discovery mode"
              value={useProfileTitles ? 'profile' : 'query'}
              disabled={search.isPending}
              onChange={(event) => setUseProfileTitles(event.target.value === 'profile')}
            >
              <option value="query">Role or technology</option>
              <option value="profile">Saved target roles</option>
            </select>
          </label>
          <label className="search-input">
            <Search size={19} aria-hidden="true" />
            <span className="sr-only">Role or technology</span>
            <input
              name="query"
              placeholder="Role or technology"
              minLength={2}
              maxLength={160}
              required={!useProfileTitles}
              disabled={useProfileTitles || search.isPending}
            />
          </label>
          <button className="primary" disabled={search.isPending || sources.length === 0}>
            {search.isPending ? <LoaderCircle className="spin" size={18} /> : <Search size={18} />}
            Search
          </button>
        </form>
        {(search.error || cancel.error) && (
          <ErrorState
            title={search.error ? 'Could not start that search' : 'Could not cancel that search'}
            message={search.error?.message ?? cancel.error?.message ?? ''}
          />
        )}
        {detail.error && (
          <ErrorState
            title="Could not load these results"
            message={detail.error.message}
            onRetry={() => detail.refetch()}
          />
        )}
        {!selectedId ? (
          <EmptyState
            icon={Search}
            reason="awaiting-input"
            title="No search selected"
            description="Start a search above, or pick a previous one from Search History."
          />
        ) : detail.isPending ? (
          <LoadingState message="Loading results…" />
        ) : (
          detail.data && (
            <>
              <p className="source-label" aria-label="Search sources">
                {detail.data.request.sources.map((source) => sourceNames[source]).join(' + ')}
              </p>
              <div className="result-toolbar">
                <h2>
                  {detail.data.request.query}
                  <span className="count">{detail.data.jobs.length}</span>
                </h2>
                <span className={`status ${detail.data.status}`} role="status">
                  {detail.data.status}
                </span>
                {['completed', 'partial'].includes(detail.data.status) && (
                  <button
                    className="icon-button"
                    type="button"
                    title="Download all results as JSON"
                    aria-label="Download all results as JSON"
                    disabled={exportSearch.isPending}
                    onClick={() => exportSearch.mutate(detail.data!.runId)}
                  >
                    {exportSearch.isPending ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <Download size={18} />
                    )}
                  </button>
                )}
                {['queued', 'running'].includes(detail.data.status) && (
                  <button
                    className="icon-button"
                    type="button"
                    title="Cancel search"
                    aria-label="Cancel search"
                    disabled={cancel.isPending}
                    onClick={() => {
                      if (window.confirm('Cancel this search?')) cancel.mutate(detail.data!.runId);
                    }}
                  >
                    {cancel.isPending ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <Square size={18} />
                    )}
                  </button>
                )}
              </div>
              {exportSearch.variables === detail.data.runId && exportSearch.error && (
                <ErrorState
                  variant="inline"
                  what="Could not export this search."
                  detail={exportSearch.error.message}
                />
              )}
              {exportSearch.variables === detail.data.runId && exportSearch.isSuccess && (
                <p role="status">Download started.</p>
              )}
              {['queued', 'running'].includes(detail.data.status) && (
                <p className="progress" role="status">
                  <LoaderCircle className="spin" size={16} />
                  Search in progress
                </p>
              )}
              {detail.data.status === 'failed' && (
                <ErrorState
                  variant="inline"
                  what="This search failed."
                  detail="Start a new search to try again."
                />
              )}
              {detail.data.status === 'partial' && (
                <p role="status">Partial results. Some sources did not finish.</p>
              )}
              {detail.data.sourceOutcomes && (
                <ul className="source-outcomes" aria-label="Source outcomes">
                  {detail.data.sourceOutcomes.map((outcome) => (
                    <li key={outcome.source}>
                      <strong>{sourceNames[outcome.source]}</strong>: {outcome.accepted} accepted
                      {'; '}
                      {outcome.status === 'completed'
                        ? 'complete'
                        : outcome.status === 'empty'
                          ? 'no results'
                          : outcome.errorCode === 'source_timeout'
                            ? 'timed out'
                            : outcome.errorCode === 'invalid_response'
                              ? 'invalid response'
                              : 'source failed'}
                      {outcome.limited ? '; collection limit reached' : ''}
                    </li>
                  ))}
                </ul>
              )}
              {detail.data.sourceOutcomes?.some((outcome) => outcome.status === 'failed') && (
                <button
                  type="button"
                  disabled={search.isPending}
                  onClick={() =>
                    search.mutate({
                      query: detail.data!.request.query,
                      origin: 'manual',
                      ...(detail.data!.request.useProfileTitles ? { useProfileTitles: true } : {}),
                      sources: detail
                        .data!.sourceOutcomes!.filter((outcome) => outcome.status === 'failed')
                        .map((outcome) => outcome.source),
                    })
                  }
                >
                  <RefreshCw size={16} />
                  Retry failed sources
                </button>
              )}
              {detail.data.jobs.length > 0 && (
                <label className="filter">
                  <span className="sr-only">Filter results</span>
                  <input
                    placeholder="Filter results"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                </label>
              )}
              {jobs.length === 0 && ['completed', 'partial'].includes(detail.data.status) && (
                <EmptyState
                  icon={Search}
                  // Derived from the SAME condition as the copy below, not
                  // chosen independently: if the two ever disagreed, the
                  // machine-readable reason would contradict the words.
                  reason={detail.data.jobs.length === 0 ? 'nothing-yet' : 'filtered'}
                  title={detail.data.jobs.length === 0 ? 'No jobs found' : 'No matching jobs'}
                  description={
                    detail.data.jobs.length === 0
                      ? 'This search returned no results. Try different keywords or sources.'
                      : 'Nothing in this search matches your filter. Try clearing it.'
                  }
                  action={
                    detail.data.jobs.length > 0 && filter
                      ? { label: 'Clear filter', onClick: () => setFilter('') }
                      : undefined
                  }
                />
              )}
              <div className="job-list">
                {jobs.map(({ id, data }) => (
                  <details className="job" key={id}>
                    <summary>
                      <div>
                        <p className="company">{data.company}</p>
                        <h3>{data.title}</h3>
                        <p className="location">
                          <MapPin size={14} />
                          {data.location}
                          {relativeTime(data.postedAt) && (
                            <span className="job-posted">
                              {' '}
                              &middot; {relativeTime(data.postedAt)}
                            </span>
                          )}
                        </p>
                        {data.match && data.match.matchedSkills.length > 0 && (
                          <div className="job-skill-chips">
                            {data.match.matchedSkills.slice(0, 5).map((skill) => (
                              <span key={skill}>{skill}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="job-match">
                        <span>
                          {data.match
                            ? `${Math.round(data.match.score * 100)}% match`
                            : 'Not scored'}
                        </span>
                        <ChevronDown size={20} aria-hidden="true" />
                      </div>
                    </summary>
                    <div className="job-body">
                      <SaveJob
                        jobId={id}
                        csrf={session.data?.csrf ?? ''}
                        // The lead id this control already knows must reach
                        // /saved, or "Open Saved Lead" opens nothing (F-1a).
                        onOpen={(leadId) =>
                          router.push(`/saved?lead=${encodeURIComponent(leadId)}`)
                        }
                      />
                      {data.match && <MatchEvidence match={data.match} />}
                      <div className="job-links">
                        {(data.sourceLinks?.length
                          ? data.sourceLinks
                          : [{ source: data.source, url: data.sourceUrl }]
                        ).map((link) => (
                          <a
                            key={`${link.source}:${link.url}`}
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {sourceNames[link.source]} <ExternalLink size={14} />
                          </a>
                        ))}
                        <a href={data.applyUrl} target="_blank" rel="noopener noreferrer">
                          Open Posting <ExternalLink size={14} />
                        </a>
                      </div>
                      <p className="description">
                        {data.description || 'Description not available.'}
                      </p>
                    </div>
                  </details>
                ))}
              </div>
            </>
          )
        )}
      </section>
    </div>
  );
}

// `useSearchParams()` requires a Suspense boundary in the App Router (same
// pattern as app/page.tsx).
export default function JobSearchView() {
  return (
    <Suspense fallback={null}>
      <JobSearchWorkspace />
    </Suspense>
  );
}
