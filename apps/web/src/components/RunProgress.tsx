/**
 * Watching a search run.
 *
 * A run takes minutes across a dozen boards, so the only honest thing to show is
 * what is happening right now — per source, as it happens. This component owns
 * the SSE subscription and accumulates three streams: pipeline counts, a capped
 * log, and leads as they are scored.
 *
 * ## Why the numbers are stat tiles and not a chart
 *
 * Fetched → deduped → enriched → scored → matched is five numbers on wildly
 * different scales (thousands down to single digits). A funnel or bar chart of
 * those would render the last three stages as invisible slivers, and the reader
 * wants to *read* each number, not compare their areas. Five labelled figures is
 * the right form; the only bar on the screen is the run's own progress, which is
 * a genuine 0–100% meter.
 *
 * ## Reconnection
 *
 * `openRunStream` resumes from the last event id, so a laptop that slept catches
 * up rather than restarting. Until it reconnects the panel says so instead of
 * quietly showing stale counts as if they were live.
 *
 * ## Mount this with `key={runId}`
 *
 * Every piece of state here belongs to one run — the log, the streamed leads,
 * the counters, the connection status. Rather than reset seven of them whenever
 * `runId` changes, the call site keys the component so a new run gets a new
 * instance and the initial values are already right.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  formatRelativeDate,
  SOURCE_LABELS,
  type Lead,
  type RunEvent,
  type SearchRun,
  type SourceStat,
} from '@job-radar/shared';
import { openRunStream } from '../lib/sse';
import { Alert, Badge, Button, Card, Spinner, cx } from './ui';

/** Enough to see what happened; bounded so a long run cannot grow without limit. */
const MAX_LOG_LINES = 250;
/** The stream preview is a reassurance, not the leads table. */
const MAX_STREAMED_LEADS = 12;

const STAGE_LABELS: Record<string, string> = {
  queued: 'Waiting to start',
  fetching: 'Fetching listings',
  deduping: 'Removing duplicates',
  enriching: 'Looking up companies',
  scoring: 'Scoring against your resume',
  saving: 'Saving leads',
  done: 'Finished',
};

interface LogLine {
  key: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  source: string | null;
}

export interface RunProgressProps {
  runId: string;
  /** Shown until the first event lands, so the panel is never blank. */
  initialRun?: SearchRun | null | undefined;
  /** Fired once when the run reaches a terminal state, so the page can refetch. */
  onFinished?: ((run: SearchRun | null) => void) | undefined;
  onCancel?: (() => void) | undefined;
  cancelling?: boolean | undefined;
  className?: string;
}

export function RunProgress({
  runId,
  initialRun,
  onFinished,
  onCancel,
  cancelling = false,
  className,
}: RunProgressProps) {
  const [run, setRun] = useState<SearchRun | null>(initialRun ?? null);
  const [stage, setStage] = useState<string>(initialRun?.stage ?? 'queued');
  const [progress, setProgress] = useState<number>(initialRun?.progress ?? 0);
  const [stats, setStats] = useState<SearchRun['stats'] | null>(initialRun?.stats ?? null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [connection, setConnection] = useState<'connecting' | 'open' | 'lost'>('connecting');
  const [failure, setFailure] = useState<string | null>(initialRun?.error ?? null);

  // Callbacks live in a ref so the effect depends only on `runId`. Putting
  // `onFinished` in the dependency array would tear down and re-open the stream
  // every time the parent re-rendered with a new closure.
  //
  // Written in an effect, not during render: a render that React throws away
  // must not leave the ref holding a callback from it.
  const handlers = useRef({ onFinished });
  useEffect(() => {
    handlers.current = { onFinished };
  });

  const logKey = useRef(0);
  const finished = useRef(false);

  const pushLog = useCallback((level: LogLine['level'], message: string, source: string | null) => {
    logKey.current += 1;
    const line: LogLine = { key: logKey.current, level, message, source };
    setLogs((previous) => {
      const next = [...previous, line];
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    });
  }, []);

  useEffect(() => {
    const close = openRunStream(runId, {
      onOpen: () => setConnection('open'),
      onError: (error) => {
        setConnection('lost');
        pushLog('warn', `Live updates interrupted: ${error.message}`, null);
      },
      onEvent: (event: RunEvent) => {
        setConnection('open');
        switch (event.type) {
          case 'progress':
            setStage(event.stage);
            setProgress(event.progress);
            setStats(event.stats);
            break;
          case 'log':
            pushLog(event.level, event.message, event.source);
            break;
          case 'lead':
            setLeads((previous) => [event.lead, ...previous].slice(0, MAX_STREAMED_LEADS));
            break;
          case 'done':
            setRun(event.run);
            setStage(event.run.stage);
            setProgress(event.run.progress);
            setStats(event.run.stats);
            setFailure(event.run.error);
            if (!finished.current) {
              finished.current = true;
              handlers.current.onFinished?.(event.run);
            }
            break;
          case 'error':
            setFailure(event.message);
            if (!finished.current) {
              finished.current = true;
              handlers.current.onFinished?.(null);
            }
            break;
        }
      },
    });

    return close;
  }, [runId, pushLog]);

  const terminal = run != null && run.status !== 'running' && run.status !== 'queued';
  const bySource = stats?.bySource ?? [];

  return (
    <div className={cx('flex flex-col gap-4', className)}>
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {!terminal ? <Spinner size={16} /> : null}
              <h2 className="text-base font-semibold text-ink">
                {terminal ? terminalHeadline(run) : (STAGE_LABELS[stage] ?? stage)}
              </h2>
              <StatusBadge run={run} connection={connection} terminal={terminal} />
            </div>
            <p className="mt-1 text-xs text-muted">
              Run {runId.slice(0, 8)}
              {run?.startedAt ? ` · started ${formatRelativeDate(run.startedAt)}` : ''}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold text-ink">{Math.round(progress * 100)}%</span>
            {!terminal && onCancel ? (
              <Button variant="danger" size="sm" onClick={onCancel} loading={cancelling}>
                Cancel run
              </Button>
            ) : null}
          </div>
        </div>

        {/* A determinate progress meter — accent, not the match ramp. This is
            "how far through", not "how good", and borrowing the match hue would
            imply a relationship that isn't there. */}
        <div className="mt-4 h-2 w-full overflow-hidden rounded-[4px] bg-canvas">
          <div
            className={cx(
              'motion-safe-only h-full rounded-r-[4px] transition-[width] duration-500',
              terminal && run?.status === 'failed' ? 'bg-bad' : 'bg-accent',
            )}
            style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
            role="progressbar"
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Search progress"
          />
        </div>

        <Pipeline stats={stats} />
      </Card>

      {failure ? (
        <Alert tone="bad" title="The run did not finish">
          {failure}
        </Alert>
      ) : null}

      {connection === 'lost' && !terminal ? (
        <Alert tone="warn" title="Reconnecting">
          Live updates dropped out. The run is still going on the server — this panel will catch up
          from where it left off.
        </Alert>
      ) : null}

      {bySource.length > 0 ? <SourceTable stats={bySource} /> : null}

      {leads.length > 0 ? <StreamedLeads leads={leads} /> : null}

      {logs.length > 0 ? <LogPanel logs={logs} /> : null}
    </div>
  );
}

function terminalHeadline(run: SearchRun | null): string {
  switch (run?.status) {
    case 'completed':
      return 'Search finished';
    case 'failed':
      return 'Search failed';
    case 'cancelled':
      return 'Search cancelled';
    default:
      return 'Search finished';
  }
}

function StatusBadge({
  run,
  connection,
  terminal,
}: {
  run: SearchRun | null;
  connection: 'connecting' | 'open' | 'lost';
  terminal: boolean;
}) {
  if (terminal) {
    const tone =
      run?.status === 'completed' ? 'good' : run?.status === 'failed' ? 'bad' : 'neutral';
    return <Badge tone={tone}>{run?.status ?? 'done'}</Badge>;
  }
  if (connection === 'lost') return <Badge tone="warn">Reconnecting</Badge>;
  if (connection === 'connecting') return <Badge tone="neutral">Connecting</Badge>;
  return <Badge tone="accent">Live</Badge>;
}

/* -------------------------------------------------------------------------- */
/* Pipeline counts                                                            */
/* -------------------------------------------------------------------------- */

const PIPELINE: { key: keyof Omit<SearchRun['stats'], 'bySource'>; label: string; hint: string }[] =
  [
    { key: 'fetched', label: 'Fetched', hint: 'Listings returned by the sources' },
    { key: 'deduped', label: 'Unique', hint: 'After removing the same job posted twice' },
    { key: 'enriched', label: 'Enriched', hint: 'Companies looked up for site, portal and email' },
    { key: 'scored', label: 'Scored', hint: 'Compared against your resume' },
    { key: 'matched', label: 'Matched', hint: 'Cleared your threshold and became leads' },
  ];

function Pipeline({ stats }: { stats: SearchRun['stats'] | null }) {
  return (
    <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
      {PIPELINE.map((step) => (
        <div key={step.key}>
          <dt className="text-xs text-muted" title={step.hint}>
            {step.label}
          </dt>
          {/* Proportional figures: these are stat-tile values, not a column. */}
          <dd
            className={cx(
              'text-xl font-semibold',
              step.key === 'matched' ? 'text-accent' : 'text-ink',
            )}
          >
            {stats ? stats[step.key].toLocaleString() : '—'}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* -------------------------------------------------------------------------- */
/* Per-source table                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The audit trail. If a source returned nothing, this is where the user finds
 * out whether it was searched and came back empty or fell over — a distinction
 * that decides whether "no leads" means "try a lower threshold" or "retry".
 */
function SourceTable({ stats }: { stats: SourceStat[] }) {
  return (
    <Card className="overflow-hidden">
      <h3 className="border-b border-border px-4 py-3 text-sm font-semibold text-ink">By source</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-faint">
              <th className="px-4 py-2 font-medium">Source</th>
              <th className="px-4 py-2 text-right font-medium">Fetched</th>
              <th className="px-4 py-2 text-right font-medium">Kept</th>
              <th className="px-4 py-2 text-right font-medium">Errors</th>
              <th className="px-4 py-2 text-right font-medium">Time</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((stat) => (
              <tr key={stat.source} className="border-t border-border align-top">
                <th scope="row" className="px-4 py-2 text-left font-medium text-ink">
                  {SOURCE_LABELS[stat.source]}
                  {stat.message ? (
                    <p className="mt-0.5 text-xs font-normal text-muted text-wrap-anywhere">
                      {stat.message}
                    </p>
                  ) : null}
                </th>
                <td className="px-4 py-2 text-right text-muted tabular-nums">{stat.fetched}</td>
                <td className="px-4 py-2 text-right text-ink tabular-nums">{stat.kept}</td>
                <td
                  className={cx(
                    'px-4 py-2 text-right tabular-nums',
                    stat.errors > 0 ? 'text-bad' : 'text-faint',
                  )}
                >
                  {stat.errors}
                </td>
                <td className="px-4 py-2 text-right text-faint tabular-nums">
                  {stat.durationMs == null ? '—' : `${(stat.durationMs / 1000).toFixed(1)}s`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Streamed leads                                                             */
/* -------------------------------------------------------------------------- */

function StreamedLeads({ leads }: { leads: Lead[] }) {
  return (
    <Card className="p-4">
      <h3 className="mb-2 text-sm font-semibold text-ink">
        Landing now
        <span className="ml-2 text-xs font-normal text-faint">
          newest first — the full list is on the Leads screen
        </span>
      </h3>
      <ul className="flex flex-col divide-y divide-border">
        {leads.map((lead) => (
          <li key={lead.id} className="flex items-baseline gap-3 py-1.5 text-sm">
            <span className="w-11 shrink-0 font-semibold text-ink tabular-nums">
              {Math.round(lead.match.score * 100)}%
            </span>
            <span className="min-w-0 flex-1 truncate text-ink">{lead.job.title}</span>
            <span className="hidden shrink-0 text-muted sm:block">{lead.job.company.name}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Log                                                                        */
/* -------------------------------------------------------------------------- */

const LOG_TONE: Record<LogLine['level'], string> = {
  info: 'text-muted',
  warn: 'text-warn',
  error: 'text-bad',
};

/**
 * A log line's `source` is a free string, not a `SourceId` — the worker also
 * tags lines with things like `enrichment`. So look the label up loosely and
 * fall back to whatever the server said.
 */
function sourceLabel(source: string): string {
  return (SOURCE_LABELS as Record<string, string | undefined>)[source] ?? source;
}

function LogPanel({ logs }: { logs: LogLine[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Follow the tail, but stop the moment the user scrolls up to read something —
  // a log that yanks itself back to the bottom mid-sentence is unusable.
  useEffect(() => {
    if (!pinned) return;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [logs, pinned]);

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h3 className="text-sm font-semibold text-ink">Activity</h3>
        <span className="text-xs text-faint">
          {pinned ? 'Following' : 'Paused — scroll down to resume'}
        </span>
      </div>
      <div
        ref={scroller}
        className="max-h-56 overflow-y-auto px-4 py-2"
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          setPinned(atBottom);
        }}
      >
        <ul className="flex flex-col gap-1 font-mono text-xs">
          {logs.map((line) => (
            <li key={line.key} className={cx('text-wrap-anywhere', LOG_TONE[line.level])}>
              {line.source ? (
                <span className="text-faint">[{sourceLabel(line.source)}] </span>
              ) : null}
              {line.message}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
