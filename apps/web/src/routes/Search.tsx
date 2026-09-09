/**
 * Starting a search, and watching it run.
 *
 * One screen with two states rather than two routes: the form collapses and the
 * live progress panel takes over in place. A separate `/runs/:id` page would mean
 * a navigation between "I pressed go" and "here is what's happening", and the
 * back button would land the user on a form they've already submitted.
 *
 * ## An already-running run wins
 *
 * `useActiveRun()` polls for a run started elsewhere — another tab, a previous
 * session, the MCP server driving the same API. Finding one, this screen attaches
 * to it instead of offering a second search, because two concurrent runs would
 * fight over the same rate-limited providers and neither would finish faster.
 *
 * ## Capabilities are read, not guessed
 *
 * The semantic-rerank toggle is disabled unless `capabilities.llmRerank` is on.
 * Otherwise it looks available, the user ticks it, and the refusal arrives as a
 * 422 after the whole form is filled in.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  DEFAULT_MATCH_THRESHOLD,
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_DAYS,
  formatScore,
  type SearchRequest,
  type SourceId,
  type SourceInfo,
} from '@job-radar/shared';
import {
  useActiveRun,
  useCancelRun,
  useLastSearchRequest,
  useProfileStatus,
  useSources,
  useStartSearch,
} from '../lib/queries';
import { RunProgress } from '../components/RunProgress';
import { SourcePicker } from '../components/SourcePicker';
import { PortalSearchLinks } from '../components/PortalSearchLinks';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Field,
  Select,
  Skeleton,
  Slider,
  buttonClass,
} from '../components/ui';

const POSTED_OPTIONS = [
  { value: 1, label: 'Last 24 hours' },
  { value: 3, label: 'Last 3 days' },
  { value: 7, label: 'Last week' },
  { value: 14, label: 'Last 2 weeks' },
  { value: 30, label: 'Last 30 days' },
  { value: 60, label: 'Last 2 months' },
];

const MAX_RESULT_OPTIONS = [50, 100, 200, 400, 800, 1000];

/** Ticked by default: keyless, full descriptions, no configuration needed. */
function defaultSources(sources: SourceInfo[]): SourceId[] {
  return sources
    .filter((source) => source.enabled && (source.kind === 'ats' || source.kind === 'remote'))
    .map((source) => source.id);
}

/**
 * Waits for everything the form needs to be seeded correctly, then mounts it.
 *
 * `SearchScreen` reads its props once, in `useState` initializers, and never
 * re-reads them. That is deliberate: a background refetch of the source
 * catalogue must not silently retick the boxes the user just changed. Holding
 * the mount until all three queries have settled is what makes reading them once
 * sufficient.
 */
export function Search() {
  const catalog = useSources();
  const profile = useProfileStatus();
  const previous = useLastSearchRequest();

  if (catalog.isLoading || profile.isLoading || previous.isLoading) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (catalog.isError) {
    return (
      <Alert
        tone="bad"
        title="Couldn’t reach the API"
        action={
          <Button size="sm" variant="secondary" onClick={() => void catalog.refetch()}>
            Retry
          </Button>
        }
      >
        {catalog.error.message}
      </Alert>
    );
  }

  // Searching without a resume would score every job against nothing. Say so
  // here rather than letting the run start and return an empty list.
  if (profile.data && !profile.data.exists) {
    return (
      <div className="mx-auto max-w-2xl">
        <Alert
          tone="warn"
          title="Set up your profile first"
          action={
            <Link to="/" className={buttonClass('primary', 'sm')}>
              Set up profile
            </Link>
          }
        >
          Every job is scored against your resume and preferences. There is nothing to score against
          yet.
        </Alert>
      </div>
    );
  }

  return (
    <SearchScreen
      sources={catalog.data?.sources ?? []}
      llmRerank={catalog.data?.capabilities.llmRerank ?? false}
      hasResume={profile.data?.hasResume ?? false}
      last={previous.data ?? null}
    />
  );
}

/**
 * The last run's request, reconciled against what this install can still do.
 *
 * A source that was enabled when the last search ran may have lost its API key
 * since, and reranking may have been turned off — carrying either forward
 * unchecked would submit a request the server refuses.
 */
function initialRequest(
  sources: SourceInfo[],
  last: SearchRequest | null,
  llmRerank: boolean,
): SearchRequest {
  const fresh = defaultSources(sources);
  if (!last) {
    return {
      sources: fresh,
      minScore: DEFAULT_MATCH_THRESHOLD,
      maxResults: DEFAULT_MAX_RESULTS,
      postedWithinDays: DEFAULT_SEARCH_DAYS,
      useLlmRerank: false,
    };
  }

  const runnable = new Set(sources.filter((source) => source.enabled).map((source) => source.id));
  const kept = last.sources.filter((id) => runnable.has(id));
  return {
    ...last,
    sources: kept.length > 0 ? kept : fresh,
    useLlmRerank: last.useLlmRerank && llmRerank,
  };
}

function SearchScreen({
  sources,
  llmRerank,
  hasResume,
  last,
}: {
  sources: SourceInfo[];
  llmRerank: boolean;
  hasResume: boolean;
  last: SearchRequest | null;
}) {
  const navigate = useNavigate();
  const active = useActiveRun();
  const start = useStartSearch();
  const cancel = useCancelRun();

  /** Set once the user presses go, so this screen keeps showing that run. */
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const [request, setRequest] = useState<SearchRequest>(() =>
    initialRequest(sources, last, llmRerank),
  );

  // A run this screen started, or one already going when we arrived.
  const runId = startedRunId ?? active.data?.id ?? null;
  const attached = startedRunId === null && active.data != null;

  if (runId) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {attached ? (
          <Alert tone="info" title="A search is already running">
            Started from another tab or session. Watching it here rather than starting a second one
            — two runs would compete for the same rate limits.
          </Alert>
        ) : null}

        {/* Keyed: a second run gets a clean panel rather than inheriting the
            first one's log lines, counters and streamed leads. */}
        <RunProgress
          key={runId}
          runId={runId}
          initialRun={active.data ?? start.data ?? null}
          cancelling={cancel.isPending}
          onCancel={() => cancel.mutate(runId)}
          onFinished={() => {
            void active.refetch();
          }}
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => navigate('/leads')}>
            View leads
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setStartedRunId(null);
              void active.refetch();
            }}
          >
            Back to search
          </Button>
        </div>
      </div>
    );
  }

  const noSources = request.sources.length === 0;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-16">
      <header>
        <h1 className="text-xl font-semibold text-ink">Search for leads</h1>
        <p className="mt-1 text-sm text-muted">
          Listings are scored against your resume. Non-excluded jobs are retained; your threshold
          controls the matched-leads view.
        </p>
      </header>

      {!hasResume ? (
        <Alert
          tone="warn"
          title="No resume attached"
          action={
            <Link to="/" className={buttonClass('secondary', 'sm')}>
              Upload one
            </Link>
          }
        >
          Matching will fall back to the skills you typed in. Uploading the resume itself gives the
          engine far more to work with.
        </Alert>
      ) : null}

      <PortalSearchLinks />

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-ink">Where to search</h2>
        <p className="mt-0.5 mb-4 text-xs text-muted">
          {sources.filter((source) => source.enabled).length} of {sources.length} sources are
          available on this install.
        </p>
        <SourcePicker
          sources={sources}
          value={request.sources}
          onChange={(next) => setRequest((current) => ({ ...current, sources: next }))}
          disabled={start.isPending}
        />
      </Card>

      <Card className="p-5">
        <h2 className="mb-4 text-sm font-semibold text-ink">How strict to be</h2>

        <Slider
          id="search-threshold"
          label="Match threshold"
          value={Math.round(request.minScore * 100)}
          onChange={(value) => setRequest((current) => ({ ...current, minScore: value / 100 }))}
          min={50}
          max={100}
          step={1}
          display={formatScore(request.minScore)}
          hint={thresholdHint(request.minScore)}
        />

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field
            label="Posted within"
            htmlFor="search-posted"
            hint="Older postings are usually filled."
          >
            <Select
              id="search-posted"
              value={String(request.postedWithinDays)}
              onChange={(event) =>
                setRequest((current) => ({
                  ...current,
                  postedWithinDays: Number(event.target.value),
                }))
              }
            >
              {!POSTED_OPTIONS.some((option) => option.value === request.postedWithinDays) ? (
                <option value={request.postedWithinDays}>
                  Last {request.postedWithinDays} days
                </option>
              ) : null}
              {POSTED_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Listings to fetch"
            htmlFor="search-max"
            hint="Across all sources, before scoring. More takes longer."
          >
            <Select
              id="search-max"
              value={String(request.maxResults)}
              onChange={(event) =>
                setRequest((current) => ({ ...current, maxResults: Number(event.target.value) }))
              }
            >
              {!MAX_RESULT_OPTIONS.includes(request.maxResults) ? (
                <option value={request.maxResults}>{request.maxResults.toLocaleString()}</option>
              ) : null}
              {MAX_RESULT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option.toLocaleString()}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="mt-5 border-t border-border pt-4">
          <Checkbox
            checked={request.useLlmRerank}
            disabled={!llmRerank}
            onChange={(useLlmRerank) => setRequest((current) => ({ ...current, useLlmRerank }))}
            label="Semantic rerank with Claude"
            hint={
              llmRerank
                ? 'Sends the top candidates to Claude for a second opinion, blended 60/40 with the keyword score. Slower, and it costs API tokens.'
                : 'Unavailable — the server was started without ENABLE_LLM_RERANK and an Anthropic API key. The keyword engine runs either way.'
            }
          />
        </div>
      </Card>

      {start.isError ? (
        <Alert tone="bad" title="Couldn’t start the search">
          {start.error.message}
        </Alert>
      ) : null}

      {noSources ? (
        <Alert tone="warn" title="Pick at least one source">
          Nothing is selected, so there is nowhere to search.
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={noSources}
          loading={start.isPending}
          onClick={() => start.mutate(request, { onSuccess: (run) => setStartedRunId(run.id) })}
        >
          Start search
        </Button>
        <p className="text-xs text-muted">
          Searching {request.sources.length} source{request.sources.length === 1 ? '' : 's'}. This
          usually takes a few minutes — you can leave the page and come back.
        </p>
      </div>
    </div>
  );
}

/**
 * The slider's own consequence, in words.
 *
 * 85% is the product's default and the number the user asked for, so it gets
 * said out loud. Above it, the honest warning is that the ceiling is real: a
 * source that returns only a snippet is capped at 80%, so a 95% threshold
 * silently excludes every aggregator result no matter how good the job is.
 */
function thresholdHint(minScore: number): string {
  if (minScore >= 0.9) {
    return 'Very strict. Jobs whose full description couldn’t be fetched are capped at 80%, so this bar excludes them all.';
  }
  if (minScore === DEFAULT_MATCH_THRESHOLD) {
    return 'The default. Clearing 85% means the full description was read and most of what it asks for is on your resume.';
  }
  if (minScore >= 0.8) return 'Strict — close to the 85% default.';
  if (minScore >= 0.7) return 'Relaxed. Expect more leads and more that need a second look.';
  return 'Very relaxed. You will see nearly everything the sources returned.';
}
