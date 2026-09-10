import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, LogIn } from 'lucide-react';
import { Link } from 'react-router-dom';
import snapshotUrl from '../../../../mobile-site/jobs.json?url';
import { Brand } from '../components/Brand';
import { ThemeToggle } from '../components/Layout';
import { Alert, Badge, Button, EmptyState, Input, Select, buttonClass } from '../components/ui';
import { RouteLoading } from '../components/RouteLoading';

interface PublicJob {
  title: string;
  company: string;
  location: string;
  source: string;
  postedAt: string | null;
  url: string;
}

interface PublicSnapshot {
  updatedAt: string;
  jobs: PublicJob[];
}

export function PublicJobs() {
  const [search, setSearch] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  const [sort, setSort] = useState('posted');
  const [limit, setLimit] = useState(50);
  const snapshot = useQuery({
    queryKey: ['public-jobs'],
    queryFn: async (): Promise<PublicSnapshot> => {
      const response = await fetch(snapshotUrl, { credentials: 'omit' });
      if (!response.ok) throw new Error('The public job list is unavailable.');
      return response.json() as Promise<PublicSnapshot>;
    },
  });
  const jobs = snapshot.data?.jobs ?? [];
  const query = search.trim().toLowerCase();
  const matching = jobs.filter((job) =>
    `${job.title} ${job.company} ${job.location}`.toLowerCase().includes(query),
  );
  const sourceOptions = [...new Set(jobs.map((job) => job.source))].sort();
  const filtered = matching
    .filter((job) => sources.length === 0 || sources.includes(job.source))
    .sort((first, second) =>
      sort === 'company'
        ? first.company.localeCompare(second.company)
        : sort === 'title'
          ? first.title.localeCompare(second.title)
          : (second.postedAt ?? '').localeCompare(first.postedAt ?? ''),
    );

  return (
    <div className="app-shell flex min-h-dvh flex-col bg-canvas text-ink">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-border bg-surface">
        <div className="shell-gutter mx-auto flex min-h-16 w-full max-w-[1600px] flex-wrap items-center justify-between gap-2 py-2">
          <Link to="/jobs" aria-label="CareerScope">
            <Brand />
          </Link>
          <nav aria-label="Public navigation" className="flex items-center gap-2">
            <ThemeToggle />
            <Link to="/login" className={buttonClass('primary')}>
              <LogIn size={16} aria-hidden="true" />
              Owner login
            </Link>
          </nav>
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="shell-gutter mx-auto w-full min-w-0 max-w-[1600px] flex-1 py-6"
      >
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">
              Job leads <Badge>Public</Badge>
            </h1>
            <p className="mt-1 text-sm text-muted" role="status">
              {filtered.length.toLocaleString()} jobs
            </p>
          </div>
          {snapshot.data ? (
            <p className="text-xs text-muted">
              Updated {new Date(snapshot.data.updatedAt).toLocaleString()}
            </p>
          ) : null}
        </div>
        {snapshot.isPending ? (
          <RouteLoading />
        ) : snapshot.isError ? (
          <Alert
            tone="bad"
            title="Could not load jobs"
            action={<Button onClick={() => void snapshot.refetch()}>Try again</Button>}
          >
            {snapshot.error.message}
          </Alert>
        ) : (
          <div className="grid min-w-0 gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
            <aside
              aria-label="Job filters"
              className="min-w-0 space-y-5 lg:sticky lg:top-24 lg:self-start"
            >
              <div>
                <label htmlFor="public-search" className="mb-2 block text-sm font-medium">
                  Search jobs
                </label>
                <Input
                  id="public-search"
                  type="search"
                  placeholder="Role, company, location"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setLimit(50);
                  }}
                />
              </div>
              <fieldset>
                <legend className="mb-2 text-sm font-medium">Sources</legend>
                <div className="grid grid-cols-2 gap-x-3 lg:grid-cols-1">
                  {sourceOptions.map((source) => (
                    <label
                      key={source}
                      className="flex min-h-10 min-w-0 items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-accent"
                        checked={sources.includes(source)}
                        onChange={() => {
                          setSources((current) =>
                            current.includes(source)
                              ? current.filter((value) => value !== source)
                              : [...current, source],
                          );
                          setLimit(50);
                        }}
                      />
                      <span className="min-w-0 break-words capitalize">{source}</span>
                      <span className="ml-auto text-xs tabular-nums text-muted">
                        {matching.filter((job) => job.source === source).length}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Button
                variant="ghost"
                onClick={() => {
                  setSearch('');
                  setSources([]);
                  setLimit(50);
                }}
              >
                Clear filters
              </Button>
            </aside>
            <section aria-label="Public job results" className="min-w-0">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted">
                  Showing {Math.min(limit, filtered.length)} of {filtered.length.toLocaleString()}
                </p>
                <Select
                  aria-label="Sort jobs"
                  className="w-44"
                  value={sort}
                  onChange={(event) => {
                    setSort(event.target.value);
                    setLimit(50);
                  }}
                >
                  <option value="posted">Newest first</option>
                  <option value="company">Company</option>
                  <option value="title">Role</option>
                </Select>
              </div>
              {filtered.length === 0 ? (
                <EmptyState title="No matching jobs" description="No jobs match these filters." />
              ) : (
                <div
                  role="table"
                  aria-label="Job leads"
                  className="overflow-hidden rounded-lg border border-border bg-surface"
                >
                  <div role="rowgroup" className="hidden bg-canvas md:block">
                    <div
                      role="row"
                      className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_110px_90px] gap-4 px-4 py-3 text-xs font-medium text-muted"
                    >
                      {['Role', 'Company', 'Location', 'Source', 'Posted'].map((heading) => (
                        <span role="columnheader" key={heading}>
                          {heading}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div role="rowgroup" className="divide-y divide-border">
                    {filtered.slice(0, limit).map((job) => (
                      <div
                        role="row"
                        key={job.url}
                        className="grid min-w-0 gap-2 px-4 py-4 hover:bg-canvas md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_110px_90px] md:gap-4 md:py-3"
                      >
                        <div role="cell" className="min-w-0">
                          <a
                            href={job.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            referrerPolicy="no-referrer"
                            className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-accent hover:underline"
                          >
                            <span className="min-w-0 break-words">{job.title}</span>
                            <ExternalLink size={14} className="shrink-0" aria-hidden="true" />
                          </a>
                        </div>
                        <div role="cell" className="min-w-0 break-words text-sm">
                          {job.company}
                        </div>
                        <div role="cell" className="min-w-0 break-words text-sm text-muted">
                          {job.location || 'Not specified'}
                        </div>
                        <div
                          role="cell"
                          className="min-w-0 break-words text-xs capitalize text-muted"
                        >
                          {job.source}
                        </div>
                        <div role="cell" className="text-xs text-muted">
                          {job.postedAt
                            ? new Date(job.postedAt).toLocaleDateString()
                            : 'Not specified'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {filtered.length > limit ? (
                <div className="mt-4 flex justify-center">
                  <Button onClick={() => setLimit((current) => current + 50)}>Load more</Button>
                </div>
              ) : null}
            </section>
          </div>
        )}
      </main>
      <footer className="border-t border-border bg-surface">
        <div className="shell-gutter mx-auto flex max-w-[1600px] items-center justify-between py-3 text-xs text-muted">
          <span>CareerScope</span>
          <Link to="/login" className="inline-flex min-h-10 items-center hover:text-ink">
            My workspace
          </Link>
        </div>
      </footer>
    </div>
  );
}
