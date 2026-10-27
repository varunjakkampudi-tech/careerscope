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
import {
  JOB_SOURCE_PERMISSION_PENDING_MESSAGE,
  LAUNCH_JOB_SOURCE_CANDIDATES,
  SOURCE_LABELS,
  jobFeedbackReasons,
  type JobFeedbackReason,
} from '@careerscope/shared';
import { ApiError, api, SESSION_EXPIRED_EVENT } from '@/lib/api';
import { localizedText, useInterfaceLocale } from '@/lib/locale';
import { ownerKey, useSession } from '@/lib/session';
import { SaveJob } from '@/components/saved-leads';
import MatchEvidence from '@/components/match-evidence';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui-states';
import styles from './job-search-view.module.css';

const sourceNames = {
  remoteok: 'Remote OK',
  himalayas: 'Himalayas',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
};
type LaunchSource = (typeof LAUNCH_JOB_SOURCE_CANDIDATES)[number];
type JobSourceCatalog = {
  items: {
    id: LaunchSource;
    label: string;
    available: boolean;
    unavailableReason: string | null;
  }[];
};
type Run = { id: string; status: string; createdAt: string; request: { query: string } };
type Job = { id: string; data: CollectedJob; feedbackReason: JobFeedbackReason | null };
const feedbackLabelKeys = {
  irrelevant: 'feedbackIrrelevant',
  duplicate: 'feedbackDuplicate',
  incorrect: 'feedbackIncorrect',
  unavailable: 'feedbackUnavailable',
  suspicious: 'feedbackSuspicious',
} as const satisfies Record<JobFeedbackReason, Parameters<typeof localizedText>[1]>;
type Detail = {
  runId: string;
  status: string;
  request: CreateSearch;
  sourceOutcomes: SourceOutcome[] | null;
  jobs: Job[];
  events: { cursor: string; type: string; createdAt: string }[];
};

function relativeTime(iso: string | null, locale: 'en' | 'te' | 'hi'): string | null {
  if (!iso) return null;
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const ms = Date.now() - timestamp;
  const days = Math.floor(ms / 86_400_000);
  if (locale === 'en') {
    if (days <= 0) return 'Today';
    if (days === 1) return '1 day ago';
    if (days < 30) return `${days} days ago`;
  } else {
    const languageTag = locale === 'te' ? 'te-IN' : 'hi-IN';
    const formatter = new Intl.RelativeTimeFormat(languageTag, { numeric: 'auto' });
    if (days <= 0) return formatter.format(0, 'day');
    if (days < 30) return formatter.format(-days, 'day');
  }
  const months = Math.floor(days / 30);
  if (locale !== 'en') {
    const languageTag = locale === 'te' ? 'te-IN' : 'hi-IN';
    return new Intl.RelativeTimeFormat(languageTag, { numeric: 'auto' }).format(-months, 'month');
  }
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

function JobFeedback({
  jobId,
  csrf,
  reason: initialReason,
  onSaved,
}: {
  jobId: string;
  csrf: string;
  reason: JobFeedbackReason | null;
  onSaved: (reason: JobFeedbackReason) => void;
}) {
  const locale = useInterfaceLocale();
  const t = (key: Parameters<typeof localizedText>[1]) => localizedText(locale, key);
  const [reason, setReason] = useState<JobFeedbackReason | ''>(initialReason ?? '');
  const feedback = useMutation({
    mutationFn: (nextReason: JobFeedbackReason) =>
      api<{ reason: JobFeedbackReason }>(`/search-jobs/${jobId}/feedback`, {
        method: 'PUT',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ reason: nextReason }),
      }),
    onSuccess: (result) => {
      onSaved(result.reason);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reason) feedback.mutate(reason);
  }

  return (
    <form className="job-feedback" onSubmit={submit} lang={locale}>
      <label>
        <span>{t('reportPostingIssue')}</span>
        <select
          value={reason}
          onChange={(event) => setReason(event.target.value as JobFeedbackReason | '')}
          disabled={feedback.isPending}
        >
          <option value="">{t('chooseFeedbackReason')}</option>
          {jobFeedbackReasons.map((value) => (
            <option key={value} value={value}>
              {t(feedbackLabelKeys[value])}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={!reason || feedback.isPending || reason === initialReason}>
        {feedback.isPending
          ? t('savingFeedback')
          : initialReason
            ? t('updateFeedback')
            : t('sendFeedback')}
      </button>
      {feedback.error && <p role="alert">{t('feedbackSaveError')}</p>}
      {initialReason && !feedback.error && <p role="status">{t('feedbackRecorded')}</p>}
    </form>
  );
}

// The search/discovery workspace, mechanically extracted from the former
// monolithic page.tsx onto its own real route (CS-6). The visual/behavioural
// redesign this ticket's sibling tickets call for (CS-16 actionable results,
// CS-17 job detail view, CS-18 explainable match score, CS-19 coherent
// save/shortlist flow) is deliberately NOT done here — this move only gives
// each a real, independent route to be rewritten on, rather than bundling a
// large visual change into the routing/auth-boundary change.
function JobSearchWorkspace() {
  const locale = useInterfaceLocale();
  const t = (key: Parameters<typeof localizedText>[1]) => localizedText(locale, key);
  const cache = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const session = useSession();
  // CS-61: present exactly when authenticated.
  const owner = session.data?.owner;
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sourceSelection, setSourceSelection] = useState<CreateSearch['sources'] | null>(null);
  const [useProfileTitles, setUseProfileTitles] = useState(false);

  const sourceCatalog = useQuery({
    queryKey: ownerKey(owner, 'job-sources'),
    queryFn: ({ signal }) => api<JobSourceCatalog>('/job-sources', { signal }),
    enabled: !!owner && session.data?.authenticated === true,
    retry: 1,
  });
  const firstAvailableSource = sourceCatalog.data?.items.find((source) => source.available)?.id;
  const sources =
    sourceSelection ?? (firstAvailableSource ? [firstAvailableSource] : ([] as LaunchSource[]));

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
  const availableSources = new Set(
    sourceCatalog.data?.items.filter((source) => source.available).map((source) => source.id) ?? [],
  );
  const permissionReviewPending =
    sourceCatalog.data?.items.some(
      (source) => source.unavailableReason === JOB_SOURCE_PERMISSION_PENDING_MESSAGE,
    ) ?? false;
  const hasAvailableSelection = sources.some((source) =>
    availableSources.has(source as LaunchSource),
  );
  const jobs = (
    detail.data?.jobs.filter(({ data }) =>
      `${data.title} ${data.company} ${data.location}`.toLowerCase().includes(filtered),
    ) ?? []
  ).sort((a, b) => (b.data.match?.score ?? -1) - (a.data.match?.score ?? -1));

  return (
    <div className="workspace">
      <aside className="history" lang={locale}>
        <h2 className={styles.historyHeading}>{t('searchHistoryHeading')}</h2>
        {runs.isPending && <LoadingState message={t('loadingSearchHistory')} />}
        {runs.error && (
          <ErrorState
            title={t('searchHistoryErrorTitle')}
            message={
              locale === 'en' && runs.error instanceof ApiError
                ? runs.error.message
                : t('searchHistoryErrorDetail')
            }
            onRetry={() => runs.refetch()}
            retryLabel={t('retry')}
          />
        )}
        {runs.data?.items.length === 0 && (
          // The history has no filter control, so this is always the
          // "nothing yet" case (AC3), unlike the results list further down.
          <EmptyState variant="inline" reason="nothing-yet" message={t('noSearchHistory')} />
        )}
        <nav aria-label={t('searchHistoryLabel')}>
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
              <strong lang="und">{run.request.query}</strong>
              <span>
                <span lang="en">{run.status}</span> &middot;{' '}
                {new Date(run.createdAt).toLocaleDateString(
                  locale === 'en' ? 'en-IN' : locale === 'te' ? 'te-IN' : 'hi-IN',
                )}
              </span>
            </button>
          ))}
        </nav>
      </aside>
      <section className="results">
        <div className="section-heading" lang={locale}>
          <div>
            <p className="eyebrow">{t('searchWorkspaceEyebrow')}</p>
            <h1>{t('findYourNextRole')}</h1>
          </div>
        </div>
        <fieldset
          className={styles.sourceOptions}
          lang={locale}
          disabled={search.isPending || sourceCatalog.isPending || !!sourceCatalog.error}
          aria-describedby="source-availability"
        >
          <legend>{t('searchSourcesLegend')}</legend>
          {LAUNCH_JOB_SOURCE_CANDIDATES.map((source) => {
            const entry = sourceCatalog.data?.items.find((item) => item.id === source);
            const reasonId = `job-source-${source}-reason`;
            const hasPermissionBlock =
              entry?.unavailableReason === JOB_SOURCE_PERMISSION_PENDING_MESSAGE;
            return (
              <label key={source} className={!entry?.available ? styles.disabledSource : undefined}>
                <input
                  type="checkbox"
                  aria-label={sourceNames[source] ?? SOURCE_LABELS[source]}
                  checked={sources.includes(source as CreateSearch['sources'][number])}
                  disabled={!entry?.available || search.isPending || sourceCatalog.isPending}
                  aria-describedby={
                    !entry?.available
                      ? hasPermissionBlock
                        ? 'source-availability'
                        : reasonId
                      : undefined
                  }
                  onChange={(event) =>
                    setSourceSelection((current) => {
                      const currentSelection =
                        current ?? (firstAvailableSource ? [firstAvailableSource] : []);
                      return event.target.checked
                        ? [...currentSelection, source as CreateSearch['sources'][number]]
                        : currentSelection.filter((selectedSource) => selectedSource !== source);
                    })
                  }
                />
                <span className="source-option-copy">
                  <span>{sourceNames[source] ?? SOURCE_LABELS[source]}</span>
                  {entry && !entry.available && !hasPermissionBlock && (
                    <span id={reasonId} className="source-unavailable-reason">
                      {t('sourceUnavailable')}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
        <p id="source-availability" role="status" aria-live="polite" lang={locale}>
          {sourceCatalog.isPending
            ? t('checkingApprovedSources')
            : sourceCatalog.error
              ? t('sourceAvailabilityError')
              : permissionReviewPending
                ? t('sourcePermissionPending')
                : availableSources.size === 0
                  ? t('noApprovedSources')
                  : undefined}
        </p>
        {sourceCatalog.error && (
          <div lang={locale}>
            <ErrorState
              variant="inline"
              what={t('jobSourcesErrorTitle')}
              detail={
                locale === 'en' && sourceCatalog.error instanceof ApiError
                  ? sourceCatalog.error.message
                  : t('searchConnectionError')
              }
              action={
                <button type="button" onClick={() => void sourceCatalog.refetch()}>
                  {t('retry')}
                </button>
              }
            />
          </div>
        )}
        <form className="search-form" onSubmit={startSearch} lang={locale}>
          <label className="discovery-mode">
            <span className="sr-only">{t('discoveryMode')}</span>
            <select
              className={styles.discoverySelect}
              aria-label={t('discoveryMode')}
              value={useProfileTitles ? 'profile' : 'query'}
              disabled={search.isPending}
              onChange={(event) => setUseProfileTitles(event.target.value === 'profile')}
            >
              <option value="query">{t('roleOrTechnology')}</option>
              <option value="profile">{t('savedTargetRoles')}</option>
            </select>
          </label>
          <label className="search-input">
            <Search size={19} aria-hidden="true" />
            <span className="sr-only">{t('roleOrTechnology')}</span>
            <input
              name="query"
              placeholder={t('roleOrTechnology')}
              minLength={2}
              maxLength={160}
              required={!useProfileTitles}
              disabled={useProfileTitles || search.isPending}
            />
          </label>
          <button className="primary" disabled={search.isPending || !hasAvailableSelection}>
            {search.isPending ? <LoaderCircle className="spin" size={18} /> : <Search size={18} />}
            {search.isPending ? t('searchStarting') : t('searchButton')}
          </button>
        </form>
        {(search.error || cancel.error) && (
          <div lang={locale}>
            <ErrorState
              title={search.error ? t('searchStartError') : t('searchCancelError')}
              message={
                locale === 'en' && (search.error ?? cancel.error) instanceof ApiError
                  ? (search.error ?? cancel.error)!.message
                  : t('searchConnectionError')
              }
              retryLabel={t('retry')}
            />
          </div>
        )}
        {detail.error && (
          <div lang={locale}>
            <ErrorState
              title={t('searchResultsError')}
              message={
                locale === 'en' && detail.error instanceof ApiError
                  ? detail.error.message
                  : t('searchConnectionError')
              }
              onRetry={() => detail.refetch()}
              retryLabel={t('retry')}
            />
          </div>
        )}
        {!selectedId ? (
          <div lang={locale}>
            <EmptyState
              icon={Search}
              reason="awaiting-input"
              title={t('noSearchSelected')}
              description={t('startOrChooseSearch')}
            />
          </div>
        ) : detail.isPending ? (
          <div lang={locale}>
            <LoadingState message={t('loadingSearchResults')} />
          </div>
        ) : (
          detail.data && (
            <>
              <p className="source-label" aria-label="Search sources" lang="en">
                {detail.data.request.sources.map((source) => sourceNames[source]).join(' + ')}
              </p>
              <div className="result-toolbar" lang="en">
                <h2>
                  <span lang="und">{detail.data.request.query}</span>
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
                <ul className="source-outcomes" aria-label="Source outcomes" lang="en">
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
                              : outcome.errorCode === 'source_permission_pending'
                                ? 'permission review pending'
                                : 'source failed'}
                      {outcome.limited ? '; collection limit reached' : ''}
                    </li>
                  ))}
                </ul>
              )}
              {detail.data.sourceOutcomes?.some(
                (outcome) =>
                  outcome.status === 'failed' &&
                  availableSources.has(outcome.source as LaunchSource),
              ) && (
                <button
                  type="button"
                  disabled={search.isPending}
                  onClick={() =>
                    search.mutate({
                      query: detail.data!.request.query,
                      origin: 'manual',
                      ...(detail.data!.request.useProfileTitles ? { useProfileTitles: true } : {}),
                      sources: detail
                        .data!.sourceOutcomes!.filter(
                          (outcome) =>
                            outcome.status === 'failed' &&
                            availableSources.has(outcome.source as LaunchSource),
                        )
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
                <div lang={locale}>
                  <EmptyState
                    icon={Search}
                    // Derived from the SAME condition as the copy below, not
                    // chosen independently: if the two ever disagreed, the
                    // machine-readable reason would contradict the words.
                    reason={detail.data.jobs.length === 0 ? 'nothing-yet' : 'filtered'}
                    title={detail.data.jobs.length === 0 ? t('noJobsFound') : t('noMatchingJobs')}
                    description={
                      detail.data.jobs.length === 0
                        ? t('searchReturnedNoResults')
                        : t('noResultsMatchFilter')
                    }
                    action={
                      detail.data.jobs.length > 0 && filter
                        ? { label: t('clearSearchFilter'), onClick: () => setFilter('') }
                        : undefined
                    }
                  />
                </div>
              )}
              <div className="job-list">
                {jobs.map(({ id, data, feedbackReason }) => (
                  <details className="job" key={id}>
                    <summary>
                      <div>
                        <p className="company" lang="und">
                          {data.company}
                        </p>
                        <h3 lang="und">{data.title}</h3>
                        <p className="location" lang="und">
                          <MapPin size={14} />
                          {data.location}
                          {relativeTime(data.postedAt, locale) && (
                            <span className="job-posted" lang={locale}>
                              {' '}
                              &middot; {relativeTime(data.postedAt, locale)}
                            </span>
                          )}
                        </p>
                        {data.match && data.match.matchedSkills.length > 0 && (
                          <div className="job-skill-chips" lang="und">
                            {data.match.matchedSkills.slice(0, 5).map((skill) => (
                              <span key={skill}>{skill}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="job-match" lang="en">
                        <span>
                          {data.match
                            ? `${Math.round(data.match.score * 100)}% match`
                            : 'Not scored'}
                        </span>
                        <ChevronDown size={20} aria-hidden="true" />
                      </div>
                    </summary>
                    <div className="job-body">
                      <div lang="en">
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
                      </div>
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
                      <p className="description" lang={data.description ? 'und' : locale}>
                        {data.description || t('jobDescriptionUnavailable')}
                      </p>
                      <JobFeedback
                        key={`${id}:${feedbackReason ?? 'none'}`}
                        jobId={id}
                        csrf={session.data?.csrf ?? ''}
                        reason={feedbackReason}
                        onSaved={(reason) => {
                          cache.setQueryData<Detail>(
                            ownerKey(owner, 'searches', selectedId),
                            (current) =>
                              current
                                ? {
                                    ...current,
                                    jobs: current.jobs.map((job) =>
                                      job.id === id ? { ...job, feedbackReason: reason } : job,
                                    ),
                                  }
                                : current,
                          );
                        }}
                      />
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
