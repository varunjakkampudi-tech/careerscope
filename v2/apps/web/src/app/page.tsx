'use client';

import Link from 'next/link';
import AccountForm from '../components/account-form';
import SavedLeads, { SaveJob } from '../components/saved-leads';
import MatchEvidence from '../components/match-evidence';
import type { CollectedJob, CreateSearch, SourceOutcome } from '@careerscope/core';
import { api, ApiError } from '../lib/api';

import { lazy, Suspense, useDeferredValue, useEffect, useState, type FormEvent } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  BriefcaseBusiness,
  Bookmark,
  ChevronDown,
  ClipboardCheck,
  Download,
  ExternalLink,
  History,
  LayoutDashboard,
  Library,
  LoaderCircle,
  LogOut,
  MapPin,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  UserRound,
} from 'lucide-react';

const ProfileEditor = lazy(() => import('../components/profile-editor'));
const AccountSecurity = lazy(() => import('../components/account-security'));
const PreparationPanel = lazy(() => import('../components/preparation-panel'));
const careerResources = [
  { name: 'Remote OK', category: 'Job sources', url: 'https://remoteok.com/' },
  { name: 'Himalayas', category: 'Job sources', url: 'https://himalayas.app/jobs' },
  { name: 'Microsoft Careers', category: 'Company careers', url: 'https://careers.microsoft.com/' },
  {
    name: 'Google Careers',
    category: 'Company careers',
    url: 'https://www.google.com/about/careers/applications/',
  },
  { name: 'Amazon Jobs', category: 'Company careers', url: 'https://www.amazon.jobs/' },
  {
    name: 'Harvard Resume Resources',
    category: 'Preparation',
    url: 'https://careerservices.fas.harvard.edu/channels/create-a-resume-cv-or-cover-letter/',
  },
  { name: 'Microsoft Learn', category: 'Learning', url: 'https://learn.microsoft.com/training/' },
  { name: 'MDN Web Docs', category: 'Learning', url: 'https://developer.mozilla.org/' },
];
type Session = { authenticated: boolean; csrf?: string; registrationEnabled?: boolean };
const sourceNames = {
  remoteok: 'Remote OK',
  himalayas: 'Himalayas',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  workable: 'Workable',
};
type Run = { id: string; status: string; createdAt: string; request: { query: string } };
type Job = {
  id: string;
  data: CollectedJob;
};
type Detail = {
  runId: string;
  status: string;
  request: CreateSearch;
  sourceOutcomes: SourceOutcome[] | null;
  jobs: Job[];
  events: { cursor: string; type: string; createdAt: string }[];
};
function Workspace() {
  const cache = useQueryClient();
  const [view, setView] = useState<
    'search' | 'profile' | 'leads' | 'security' | 'dashboard' | 'links' | 'preparation'
  >('search');
  const [resourceFilter, setResourceFilter] = useState('');
  const [accountNotice, setAccountNotice] = useState('');
  const [leadId, setLeadId] = useState<string | null>(null);
  const [leadDirty, setLeadDirty] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  function changeView(next: typeof view) {
    if (next === view) return;
    if ((leadDirty || profileDirty) && !window.confirm('Discard unsaved changes?')) return;
    setLeadDirty(false);
    setProfileDirty(false);
    setView(next);
  }
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sources, setSources] = useState<CreateSearch['sources']>(['remoteok']);
  const [useProfileTitles, setUseProfileTitles] = useState(false);
  const filtered = useDeferredValue(filter).toLowerCase();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: ({ signal }) => api<Session>('/session', { signal }),
    retry: 1,
  });
  const runs = useQuery({
    queryKey: ['searches'],
    queryFn: ({ signal }) => api<{ items: Run[] }>('/searches', { signal }),
    enabled: session.data?.authenticated === true,
    refetchInterval: 5000,
    retry: 1,
  });
  const selectedId = selected ?? runs.data?.items[0]?.id;
  const detail = useQuery({
    queryKey: ['searches', selectedId],
    enabled: !!selectedId && session.data?.authenticated === true,
    queryFn: ({ signal }) => api<Detail>(`/searches/${selectedId}`, { signal }),
    retry: 1,
    refetchInterval: (query) =>
      ['completed', 'partial', 'failed', 'cancelled'].includes(query.state.data?.status ?? '')
        ? false
        : 10000,
  });
  const logout = useMutation({
    mutationFn: () =>
      api('/logout', { method: 'POST', headers: { 'x-csrf-token': session.data?.csrf ?? '' } }),
    onSuccess: () => {
      setSelected(null);
      setLeadDirty(false);
      setProfileDirty(false);
      setView('search');
      exportSearch.reset();
      cache.clear();
    },
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
      setSelected(result.runId);
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
  const expired = [runs.error, detail.error, cancel.error, exportSearch.error].some(
    (error) => error instanceof ApiError && error.status === 401,
  );
  const authenticated = session.data?.authenticated && !expired;
  const streamActive =
    authenticated && view === 'search' && ['queued', 'running'].includes(detail.data?.status ?? '');
  useEffect(() => {
    if (!streamActive || !selectedId) return;
    const source = new EventSource(`/api/searches/${selectedId}/events`);
    const refresh = () => {
      void cache.invalidateQueries({ queryKey: ['searches'] });
    };
    source.addEventListener('progress', refresh);
    // The server replayed from the start because our cursor aged out of retention.
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
      cache.setQueryData(['session'], { authenticated: false });
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
        ...(useProfileTitles ? { useProfileTitles: true } : {}),
      });
  }
  const jobs =
    detail.data?.jobs.filter(({ data }) =>
      `${data.title} ${data.company} ${data.location}`.toLowerCase().includes(filtered),
    ) ?? [];
  return (
    <>
      <a className="skip-link" href="#workspace-content">
        Skip to content
      </a>
      <header className="topbar">
        <Link
          className="brand"
          href="/"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            changeView('search');
          }}
        >
          <BriefcaseBusiness aria-hidden="true" />
          CareerScope<span>v2 alpha</span>
        </Link>
        {authenticated && (
          <div className="header-actions">
            <button
              className="icon-button"
              type="button"
              onClick={() => changeView('security')}
              title="Account security"
              aria-label="Account security"
            >
              <ShieldCheck size={19} />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={() => changeView('profile')}
              title="Candidate profile"
              aria-label="Candidate profile"
            >
              <UserRound size={19} />
            </button>
            <button
              className="icon-button"
              onClick={() => {
                if (
                  !(leadDirty || profileDirty) ||
                  window.confirm('Discard unsaved changes and sign out?')
                ) {
                  logout.mutate();
                }
              }}
              disabled={logout.isPending}
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={19} />
            </button>
          </div>
        )}
      </header>
      <main id="workspace-content" tabIndex={-1}>
        {authenticated && (
          <nav className="workspace-nav" aria-label="Career workspace">
            {(
              [
                ['dashboard', 'Dashboard', LayoutDashboard],
                ['search', 'Discovery', Search],
                ['leads', 'Leads', Bookmark],
                ['preparation', 'Preparation', ClipboardCheck],
                ['links', 'Career Links', Library],
                ['profile', 'Profile', UserRound],
              ] as const
            ).map(([target, label, Icon]) => (
              <button
                key={target}
                type="button"
                aria-current={view === target ? 'page' : undefined}
                onClick={() => changeView(target)}
              >
                <Icon size={17} aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>
        )}
        {session.isPending ? (
          <div className="state" role="status">
            <LoaderCircle className="spin" />
            Loading workspace
          </div>
        ) : session.isError ? (
          <div className="state">
            <h1>Workspace unavailable</h1>
            <p role="alert">Could not reach the local service.</p>
            <button onClick={() => session.refetch()}>
              <RefreshCw size={16} />
              Retry
            </button>
          </div>
        ) : !authenticated ? (
          <AccountForm
            registrationEnabled={session.data?.registrationEnabled === true}
            expired={expired}
            notice={accountNotice}
            onAuthenticated={() => {
              setSelected(null);
              setView('search');
              setAccountNotice('');
              exportSearch.reset();
              cache.clear();
            }}
          />
        ) : view === 'dashboard' ? (
          <section className="results career-overview">
            <p className="eyebrow">Your career workspace</p>
            <h1>Your Next Chapter</h1>
            <div className="overview-actions">
              <button className="primary" onClick={() => changeView('search')}>
                <Search size={18} />
                Discover roles
              </button>
              <button onClick={() => changeView('leads')}>
                <Bookmark size={18} />
                Review saved leads
              </button>
              <button onClick={() => changeView('profile')}>
                <UserRound size={18} />
                Update profile
              </button>
            </div>
            <div className="overview-band">
              <h2>Recent discovery</h2>
              {runs.isPending && <p role="status">Loading searches...</p>}
              {runs.error && (
                <p role="alert">
                  Could not load searches.{' '}
                  <button onClick={() => runs.refetch()}>
                    <RefreshCw size={16} />
                    Retry
                  </button>
                </p>
              )}
              {runs.data?.items.length === 0 && <p>No searches yet.</p>}
              <ul className="resource-list">
                {runs.data?.items.slice(0, 5).map((run) => (
                  <li key={run.id}>
                    <button
                      onClick={() => {
                        setSelected(run.id);
                        setFilter('');
                        changeView('search');
                      }}
                    >
                      <span>
                        <strong>{run.request.query}</strong>
                        <small>{new Date(run.createdAt).toLocaleDateString()}</small>
                      </span>
                      <span className="run-status">{run.status}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="overview-band">
              <h2>Career resources</h2>
              <div className="overview-actions">
                <button
                  onClick={() => {
                    setResourceFilter('Preparation');
                    changeView('links');
                  }}
                >
                  <Library size={18} />
                  Resume preparation
                </button>
                <button
                  onClick={() => {
                    setResourceFilter('Company careers');
                    changeView('links');
                  }}
                >
                  <BriefcaseBusiness size={18} />
                  Company careers
                </button>
              </div>
            </div>
          </section>
        ) : view === 'preparation' ? (
          <Suspense fallback={<p role="status">Loading preparation...</p>}>
            <PreparationPanel onProfile={() => changeView('profile')} />
          </Suspense>
        ) : view === 'links' ? (
          <section className="results career-overview">
            <p className="eyebrow">Resources</p>
            <h1>Career Links</h1>
            <label className="resource-filter">
              Find resources
              <input
                type="search"
                value={resourceFilter}
                onChange={(event) => setResourceFilter(event.target.value)}
                placeholder="Name or category"
              />
            </label>
            <ul className="resource-list">
              {careerResources
                .filter((resource) =>
                  `${resource.name} ${resource.category}`
                    .toLowerCase()
                    .includes(resourceFilter.toLowerCase()),
                )
                .map((resource) => (
                  <li key={resource.url}>
                    <a href={resource.url} target="_blank" rel="noopener noreferrer">
                      <span>
                        <strong>{resource.name}</strong>
                        <small>{resource.category}</small>
                      </span>
                      <ExternalLink size={18} aria-hidden="true" />
                    </a>
                  </li>
                ))}
            </ul>
            {!careerResources.some((resource) =>
              `${resource.name} ${resource.category}`
                .toLowerCase()
                .includes(resourceFilter.toLowerCase()),
            ) && <p role="status">No resources found.</p>}
          </section>
        ) : view === 'security' ? (
          <Suspense
            fallback={
              <div className="state" role="status">
                Loading account security
              </div>
            }
          >
            <AccountSecurity
              csrf={session.data?.csrf ?? ''}
              onBack={() => setView('search')}
              onChanged={() => {
                setSelected(null);
                setLeadId(null);
                setLeadDirty(false);
                setProfileDirty(false);
                setView('search');
                setAccountNotice('Password changed. All sessions signed out. Sign in again.');
                exportSearch.reset();
                cache.clear();
              }}
            />
          </Suspense>
        ) : view === 'profile' ? (
          <Suspense
            fallback={
              <div className="state" role="status">
                <LoaderCircle className="spin" aria-hidden="true" />
                Loading profile
              </div>
            }
          >
            <ProfileEditor
              csrf={session.data?.csrf ?? ''}
              onDirty={setProfileDirty}
              onBack={() => {
                setProfileDirty(false);
                setView('search');
              }}
            />
          </Suspense>
        ) : view === 'leads' ? (
          <SavedLeads
            csrf={session.data?.csrf ?? ''}
            initialId={leadId}
            onDirty={setLeadDirty}
            onBack={() => {
              setLeadDirty(false);
              setView('search');
            }}
          />
        ) : (
          <div className="workspace">
            <aside className="history">
              <h2>
                <History size={18} />
                Search History
              </h2>
              {runs.isPending && <p role="status">Loading searches...</p>}
              {runs.error && <p role="alert">{runs.error.message}</p>}
              {runs.data?.items.length === 0 && <p>No searches yet.</p>}
              <nav aria-label="Search history">
                {runs.data?.items.map((run) => (
                  <button
                    key={run.id}
                    aria-current={selectedId === run.id ? 'true' : undefined}
                    onClick={() => {
                      setSelected(run.id);
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
                <button
                  type="button"
                  onClick={() => {
                    setLeadId(null);
                    changeView('leads');
                  }}
                >
                  <Bookmark size={18} />
                  Saved Leads
                </button>
              </div>
              <fieldset className="source-options" disabled={search.isPending}>
                <legend>Sources</legend>
                {(['remoteok', 'himalayas', 'greenhouse', 'lever', 'workable'] as const).map(
                  (source) => (
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
                  ),
                )}
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
                  {search.isPending ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : (
                    <Search size={18} />
                  )}
                  Search
                </button>
              </form>
              {(search.error || logout.error || cancel.error) && (
                <p role="alert">
                  {search.error?.message ?? logout.error?.message ?? cancel.error?.message}
                </p>
              )}
              {detail.error && (
                <div role="alert">
                  <p>{detail.error.message}</p>
                  <button onClick={() => detail.refetch()}>
                    <RefreshCw size={16} />
                    Retry
                  </button>
                </div>
              )}
              {!selectedId ? (
                <div className="state">
                  <Search size={30} />
                  <h2>No Search Selected</h2>
                </div>
              ) : detail.isPending ? (
                <div className="state" role="status">
                  <LoaderCircle className="spin" />
                  Loading results
                </div>
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
                            if (window.confirm('Cancel this search?'))
                              cancel.mutate(detail.data!.runId);
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
                      <p role="alert">{exportSearch.error.message}</p>
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
                      <p role="alert">This search failed. Start a new search to try again.</p>
                    )}
                    {detail.data.status === 'partial' && (
                      <p role="status">Partial results. Some sources did not finish.</p>
                    )}
                    {detail.data.sourceOutcomes && (
                      <ul className="source-outcomes" aria-label="Source outcomes">
                        {detail.data.sourceOutcomes.map((outcome) => (
                          <li key={outcome.source}>
                            <strong>{sourceNames[outcome.source]}</strong>: {outcome.accepted}{' '}
                            accepted
                            {'; '}
                            {outcome.status === 'completed'
                              ? 'complete'
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
                            ...(detail.data!.request.useProfileTitles
                              ? { useProfileTitles: true }
                              : {}),
                            sources: detail
                              .data!.sourceOutcomes!.filter(
                                (outcome) => outcome.status === 'failed',
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
                      <div className="state">
                        <h2>No Matching Jobs</h2>
                      </div>
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
                              </p>
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
                              onOpen={(savedId) => {
                                setLeadId(savedId);
                                changeView('leads');
                              }}
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
        )}
      </main>
    </>
  );
}

export default function Home() {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 1000 } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <Workspace />
    </QueryClientProvider>
  );
}
