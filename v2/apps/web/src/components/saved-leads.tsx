'use client';

import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowLeft,
  Bookmark,
  ExternalLink,
  FileText,
  History as HistoryIcon,
  LoaderCircle,
  RefreshCw,
  Save,
  Sparkles,
  Undo2,
} from 'lucide-react';
import type { LeadRecord, LeadHistoryRecord } from '@careerscope/core';
import { api, offersDiscardAndReload } from '../lib/api';
import { useOwner, ownerKey } from '../lib/session';
import MatchEvidence from './match-evidence';
import { EmptyState, ErrorState, LoadingState } from './ui-states';
import styles from './application-details.module.css';

type Lead = Omit<LeadRecord, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string };
type History = Omit<LeadHistoryRecord, 'createdAt'> & { createdAt: string };
type ResumeItem = { id: string; createdAt: string; status: string; filename?: string };

// The real, complete backend status pipeline (packages/core/src/leads.ts:
// leadStatusSchema) — every one of these six must stay reachable in the UI.
// Collapsing them down to just "Saved"/"Archived" (as an earlier version of
// this page did) hides four real states a lead can genuinely be in.
function statusLabel(status: Lead['status']): string {
  return (
    {
      saved: 'Saved',
      applied: 'Applied',
      interviewing: 'Interviewing',
      offer: 'Offer',
      rejected: 'Rejected',
      archived: 'Archived',
    } satisfies Record<Lead['status'], string>
  )[status];
}

const SOURCE_NAMES: Record<string, string> = {
  remoteok: 'Remote OK',
  himalayas: 'Himalayas',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  workable: 'Workable',
};

// Real-file-type label only — CareerScope has no stored filename, so a
// fabricated one is never shown (Visual Designer spec, 2026-09-23).
function resumeKind(contentType: string | undefined): string {
  if (!contentType) return 'Resume';
  if (contentType.includes('pdf')) return 'Resume (PDF)';
  if (contentType.includes('word') || contentType.includes('officedocument'))
    return 'Resume (DOCX)';
  return 'Resume';
}

function absoluteDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// The two real screens this component now serves (CS-19's shortlist and
// CS-50's honest Applications v1) each show a different, non-overlapping
// subset of the same six real statuses - never all six in both places,
// which would make "Applications" just a relabelled copy of "Saved".
const SCOPE_STATUSES = {
  saved: ['saved', 'archived'],
  applications: ['applied', 'interviewing', 'offer', 'rejected'],
} satisfies Record<'saved' | 'applications', Lead['status'][]>;

export function SaveJob({
  jobId,
  csrf,
  onOpen,
  iconOnly = false,
}: {
  jobId: string;
  csrf: string;
  onOpen: (id: string) => void;
  // CS-38/Lovable visual parity: a compact icon-only presentation for a
  // small card corner (Dashboard's recommended-job cards), reusing the exact
  // same real save/undo mutations below rather than a second, fake local
  // bookmark state. The full labelled button remains the default (Jobs page
  // detail panel) — this is a presentation change, not new domain behavior.
  iconOnly?: boolean;
}) {
  const cache = useQueryClient();
  const save = useMutation({
    mutationFn: () =>
      api<Lead>('/leads', {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ jobId }),
      }),
    onSuccess: (lead) => {
      cache.setQueryData(['lead', lead.id], lead);
      void cache.invalidateQueries({ queryKey: ['leads'] });
    },
  });
  // A real, immediate undo for a save just made in this same interaction —
  // not a fake "Saved!" toast with nothing behind it. Uses the same status
  // endpoint the lead editor uses; there is no separate delete endpoint, and
  // archiving is the correct real equivalent of "never mind" for a lead the
  // owner never opened. CS-19: "immediate confirmation and an undo".
  const undo = useMutation({
    mutationFn: (lead: Lead) =>
      api<Lead>(`/leads/${lead.id}`, {
        method: 'PUT',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ revision: lead.revision, notes: lead.notes, status: 'archived' }),
      }),
    onSuccess: (lead) => {
      cache.setQueryData(['lead', lead.id], lead);
      void cache.invalidateQueries({ queryKey: ['leads'] });
    },
  });
  const justSaved = save.data && !undo.data && save.data.status === 'saved';
  const currentStatus = save.data ? (undo.data ?? save.data).status : null;
  if (iconOnly) {
    // Compact variant: a single toggle-styled icon button. Undo is still a
    // real action (not omitted) - once saved, the same control becomes an
    // "unsave" (archive) button rather than opening a separate confirmation,
    // since a small card corner has no room for a second control.
    const label = save.isPending
      ? 'Saving…'
      : !save.data
        ? 'Save job'
        : currentStatus === 'archived'
          ? 'Removed from saved — open archived lead'
          : 'Saved — remove from saved';
    return (
      <button
        type="button"
        className="save-job-icon"
        aria-label={label}
        title={label}
        aria-pressed={currentStatus === 'saved'}
        disabled={save.isPending || undo.isPending}
        onClick={() => {
          if (!save.data) save.mutate();
          else if (currentStatus === 'saved') undo.mutate(save.data);
          else onOpen(save.data.id);
        }}
      >
        {save.isPending || undo.isPending ? (
          <LoaderCircle size={16} className="spin" />
        ) : (
          <Bookmark size={16} fill={currentStatus === 'saved' ? 'currentColor' : 'none'} />
        )}
      </button>
    );
  }
  return (
    <div className="save-job">
      <button
        type="button"
        onClick={() => (save.data ? onOpen(save.data.id) : save.mutate())}
        disabled={save.isPending}
      >
        {save.isPending ? <LoaderCircle size={16} className="spin" /> : <Bookmark size={16} />}
        {save.data
          ? (undo.data ?? save.data).status === 'archived'
            ? 'Open Archived Lead'
            : 'Open Saved Lead'
          : 'Save Job'}
      </button>
      {justSaved && (
        <button
          type="button"
          className="save-undo"
          disabled={undo.isPending}
          onClick={() => undo.mutate(save.data!)}
        >
          Saved. Undo?
        </button>
      )}
      {undo.data?.status === 'archived' && <span role="status">Undone — moved to Archived.</span>}
      {save.error && (
        <ErrorState variant="inline" what="Could not save this job." detail={save.error.message} />
      )}
      {undo.error && (
        <ErrorState variant="inline" what="Could not undo that save." detail={undo.error.message} />
      )}
    </div>
  );
}

function LeadEditor({
  record,
  csrf,
  onDirty,
  onStatus,
  allowedStatuses,
}: {
  record: Lead;
  csrf: string;
  onDirty: (dirty: boolean) => void;
  onStatus: (status: Lead['status']) => void;
  // CS-50 / Independent Reviewer finding 1, 2026-09-23: the status editor
  // must not be able to move a lead into the *other* screen's status space
  // out from under the scope the owner is currently looking at - it always
  // included the record's own current status too, so a lead already outside
  // `allowedStatuses` (reached some other way) never becomes an unselectable
  // value.
  allowedStatuses: readonly Lead['status'][];
}) {
  const cache = useQueryClient();
  // CS-61: owner-scoped query keys. Present exactly when authenticated.
  const owner = useOwner();
  const [notes, setNotes] = useState(record.notes);
  const save = useMutation({
    mutationFn: (status: Lead['status']) =>
      api<Lead>(`/leads/${record.id}`, {
        method: 'PUT',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ revision: record.revision, notes, status }),
      }),
    onSuccess: (lead) => {
      onDirty(false);
      onStatus(lead.status);
      cache.setQueryData(['lead', record.id], lead);
      void cache.invalidateQueries({ queryKey: ['leads'] });
      void cache.invalidateQueries({ queryKey: ['lead-history', record.id] });
    },
  });
  const reload = useMutation({
    mutationFn: () => api<Lead>(`/leads/${record.id}`),
    onSuccess: (lead) => {
      onDirty(false);
      setNotes(lead.notes);
      save.reset();
      cache.setQueryData(['lead', record.id], lead);
    },
  });
  const history = useInfiniteQuery({
    queryKey: ownerKey(owner, 'lead-history', record.id),
    // CS-61: MANDATORY. Without this the query can run before the session
    // resolves, building `[name, undefined, ...]` - which merges every owner
    // back into one bucket and looks owner-scoped in the source.
    enabled: !!owner,
    initialPageParam: null as number | null,
    queryFn: ({ pageParam, signal }) =>
      api<{ items: History[]; nextCursor: number | null }>(
        `/leads/${record.id}/history${pageParam ? `?before=${pageParam}` : ''}`,
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor,
    retry: 1,
  });
  // A real resume, if one exists — never a fabricated "Resume v3" or a
  // cover-letter/portfolio placeholder (Visual Designer spec, 2026-09-23).
  const resumes = useQuery({
    queryKey: ownerKey(owner, 'resumes'),
    // CS-61: MANDATORY. Without this the query can run before the session
    // resolves, building `[name, undefined, ...]` - which merges every owner
    // back into one bucket and looks owner-scoped in the source.
    enabled: !!owner,
    queryFn: ({ signal }) => api<{ enabled: boolean; items: ResumeItem[] }>('/resumes', { signal }),
    retry: 1,
  });
  const latestResume = resumes.data?.items.find((item) => item.status === 'completed');
  const historyEntries = history.data?.pages.flatMap((page) => page.items) ?? [];
  const [showAllHistory, setShowAllHistory] = useState(false);
  const visibleHistory = showAllHistory ? historyEntries : historyEntries.slice(0, 6);
  const pending = save.isPending || reload.isPending;
  const links = record.data.sourceLinks?.length
    ? record.data.sourceLinks
    : [{ source: record.data.source, url: record.data.sourceUrl }];
  const postingHref = links[0]?.url ?? record.data.applyUrl;
  return (
    <article aria-label="Lead details">
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <span className={styles.companyTile} aria-hidden="true">
            {record.data.company.charAt(0).toUpperCase()}
          </span>
          <div className={styles.headerText}>
            <h1>{record.data.title}</h1>
            <p className={styles.company}>{record.data.company}</p>
            <div className={styles.metaRow}>
              <span>{record.data.location || 'Location not provided'}</span>
              <span>{SOURCE_NAMES[record.data.source] ?? record.data.source}</span>
              {record.data.postedAt && <span>Posted {absoluteDate(record.data.postedAt)}</span>}
            </div>
            {historyEntries[0] && (
              <p className={styles.latestChange}>
                Latest recorded status change: {absoluteDate(historyEntries[0].createdAt)}
              </p>
            )}
          </div>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.statusBadge} data-status={record.status}>
            <span className={styles.statusDot} aria-hidden="true" />
            {statusLabel(record.status)}
          </span>
          <div className={styles.headerButtons}>
            {postingHref ? (
              <a
                className={styles.btnPrimary}
                href={postingHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open job posting <ExternalLink size={16} aria-hidden="true" />
              </a>
            ) : (
              <span className={styles.btnSecondary} aria-disabled="true">
                Posting link not available
              </span>
            )}
            <a href="#lead-notes" className={styles.btnSecondary}>
              {record.notes ? 'Edit notes' : 'Add note'}
            </a>
          </div>
        </div>
      </header>

      <div className={styles.grid}>
        <section className={styles.card} aria-label="Job details">
          <h2>Job Details</h2>
          <dl className={styles.detailList}>
            <dt>Job title</dt>
            <dd>{record.data.title}</dd>
            <dt>Company</dt>
            <dd>{record.data.company}</dd>
            <dt>Location</dt>
            <dd>{record.data.location || 'Not provided'}</dd>
            <dt>Posted</dt>
            <dd>{record.data.postedAt ? absoluteDate(record.data.postedAt) : 'Not provided'}</dd>
            <dt>Source</dt>
            <dd>{SOURCE_NAMES[record.data.source] ?? record.data.source}</dd>
          </dl>
        </section>

        <section className={styles.card} aria-label="Application timeline">
          <h2>Application Timeline</h2>
          <p className={styles.cardSubtitle}>Recorded changes only.</p>
          {history.isPending && <LoadingState variant="inline" message="Loading history…" />}
          {history.error && (
            <ErrorState
              variant="inline"
              what="Could not load this lead's timeline."
              detail={history.error.message}
              action={
                <button onClick={() => history.refetch()}>
                  <RefreshCw size={16} aria-hidden="true" />
                  Retry
                </button>
              }
            />
          )}
          {history.isSuccess && historyEntries.length === 0 && (
            // No filter exists on this timeline — every empty here is a
            // genuine "nothing yet", so it says exactly that.
            <EmptyState
              variant="inline"
              reason="nothing-yet"
              message="No status changes recorded yet."
            />
          )}
          <ol className={styles.timelineList}>
            {visibleHistory.map((entry, index) => (
              <li key={entry.revision} className={styles.timelineEntry}>
                <span
                  className={styles.timelineMarker}
                  style={{
                    background: `var(--dash-status-${entry.status}-bg)`,
                    color: `var(--dash-status-${entry.status}-fg)`,
                  }}
                  aria-hidden="true"
                >
                  <HistoryIcon size={13} />
                </span>
                <div
                  className={
                    index === 0
                      ? `${styles.timelineContent} ${styles.timelineLatest}`
                      : styles.timelineContent
                  }
                >
                  {index === 0 && (
                    <span className={styles.timelineLatestLabel}>Latest recorded</span>
                  )}
                  <p className={styles.timelineTitle}>
                    {entry.revision === 1
                      ? `Status recorded: ${statusLabel(entry.status)}`
                      : `Changed to ${statusLabel(entry.status)}`}
                  </p>
                  <p className={styles.timelineTime}>{absoluteDate(entry.createdAt)}</p>
                  <p className={styles.timelineMeta}>
                    Revision {entry.revision}
                    {entry.notesChanged ? ' — Notes also changed' : ''}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          {historyEntries.length > 6 && !showAllHistory && (
            <button type="button" onClick={() => setShowAllHistory(true)}>
              Show older changes
            </button>
          )}
          {history.hasNextPage && showAllHistory && (
            <button disabled={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>
              Older History
            </button>
          )}
          <p className={styles.tzNote}>Times shown in your local timezone.</p>
        </section>

        <section
          className={`${styles.card} ${styles.actionsCard}`}
          aria-label="Application actions"
        >
          <h2>Application Actions</h2>
          <div className={styles.actionsList}>
            {postingHref && (
              <a
                className={styles.btnPrimary}
                href={postingHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open job posting <ExternalLink size={16} aria-hidden="true" />
              </a>
            )}
            <label className={styles.statusSelect}>
              Status
              <select
                value={record.status}
                disabled={pending}
                onChange={(event) => {
                  const next = event.target.value as Lead['status'];
                  if (next === record.status) return;
                  if (
                    window.confirm(
                      `Change status to "${statusLabel(next)}" and save current notes?`,
                    )
                  )
                    save.mutate(next);
                }}
              >
                {(allowedStatuses.includes(record.status)
                  ? allowedStatuses
                  : [...allowedStatuses, record.status]
                ).map((value) => (
                  <option key={value} value={value}>
                    {statusLabel(value)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={styles.btnSecondary}
              disabled={pending || record.status === 'archived'}
              onClick={() => {
                if (window.confirm('Archive this lead in CareerScope and save current notes?'))
                  save.mutate('archived');
              }}
            >
              <Archive size={16} aria-hidden="true" />
              Archive in CareerScope
            </button>
            {record.status === 'archived' && (
              <button
                type="button"
                className={styles.btnSecondary}
                disabled={pending}
                onClick={() => {
                  if (window.confirm('Restore this lead to Saved and save current notes?'))
                    save.mutate('saved');
                }}
              >
                <Undo2 size={16} aria-hidden="true" />
                Restore Lead
              </button>
            )}
            {pending && <p role="status">Saving…</p>}
            {(save.error || reload.error) && (
              <ErrorState
                variant="inline"
                what="Could not save this lead."
                detail={save.error?.message ?? reload.error?.message ?? ''}
              />
            )}
            {/* CS-35: a reload only repairs a stale record, so it is offered
                for a revision conflict (or an unrecognised one) and not for a
                conflict the unsaved notes would survive. */}
            {offersDiscardAndReload(save.error) && (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (window.confirm('Discard unsaved notes and reload this lead?'))
                    reload.mutate();
                }}
              >
                <RefreshCw size={16} aria-hidden="true" />
                Discard Edits and Reload
              </button>
            )}
          </div>
        </section>
      </div>

      {record.data.match && (
        <section className={styles.card} aria-label="Match evidence" style={{ marginBottom: 24 }}>
          <MatchEvidence match={record.data.match} />
        </section>
      )}

      <section className={styles.descriptionCard} aria-label="Job description">
        <h2>Job Description</h2>
        <p className={styles.descriptionBody}>
          {record.data.description || 'Description not available.'}
        </p>
      </section>

      <div className={styles.lowerGrid}>
        <section className={styles.card} aria-label="Documents">
          <h2>Documents</h2>
          {resumes.isPending ? (
            <LoadingState variant="inline" message="Loading…" />
          ) : latestResume ? (
            <>
              <div className={styles.documentRow}>
                <FileText size={18} aria-hidden="true" />
                <span>
                  {resumeKind(undefined)} — uploaded {absoluteDate(latestResume.createdAt)}
                </span>
              </div>
              <p className={styles.documentClarification}>
                Account resume; not a record of what was submitted for this specific application.
              </p>
            </>
          ) : (
            <EmptyState variant="inline" reason="nothing-yet" message="No resume uploaded." />
          )}
        </section>

        <section className={styles.card} aria-label="Your notes" id="lead-notes">
          <h2>Your Notes</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(record.status);
            }}
          >
            <label className={styles.notesField}>
              <span className="sr-only">Notes</span>
              <textarea
                name="notes"
                maxLength={10000}
                value={notes}
                disabled={pending}
                placeholder="No notes added."
                onChange={(event) => {
                  setNotes(event.target.value);
                  onDirty(event.target.value !== record.notes);
                }}
              />
            </label>
            <button
              type="submit"
              className={styles.btnPrimary}
              disabled={pending || notes === record.notes}
            >
              <Save size={16} aria-hidden="true" />
              Save Notes
            </button>
          </form>
        </section>
      </div>

      <section className={styles.aiPanel} aria-label="AI insights">
        <div className={styles.aiPanelHeader}>
          <h2>
            <Sparkles size={16} aria-hidden="true" /> AI Insights &amp; Suggestions
          </h2>
          <span className={styles.aiBadge}>Not available yet</span>
        </div>
        <p className={styles.aiBody}>
          CareerScope&apos;s AI features are not enabled in this build.
        </p>
      </section>
    </article>
  );
}

export default function SavedLeads({
  csrf,
  initialId,
  onBack,
  onDirty,
  scope = 'saved',
}: {
  csrf: string;
  initialId: string | null;
  onBack: () => void;
  onDirty: (dirty: boolean) => void;
  // CS-50: an honest v1 for "Applications" reuses this exact real component
  // and real data instead of a separate screen with a fabricated
  // interview-stage timeline. 'saved' is the shortlist (saved/archived);
  // 'applications' is what you've actually applied to and what happened
  // since (applied/interviewing/offer/rejected) - the real, dated status
  // history below already IS the honest equivalent of a timeline.
  scope?: 'saved' | 'applications';
}) {
  const statuses: readonly Lead['status'][] = SCOPE_STATUSES[scope];
  const cache = useQueryClient();
  // CS-61: owner-scoped query keys. Present exactly when authenticated.
  const owner = useOwner();
  const [status, setStatus] = useState<Lead['status']>(() => {
    const current = cache.getQueryData<Lead>(['lead', initialId])?.status;
    return current && statuses.includes(current) ? current : statuses[0];
  });
  const [selected, setSelected] = useState(initialId);
  const [dirty, setDirty] = useState(false);
  function markDirty(value: boolean) {
    setDirty(value);
    onDirty(value);
  }
  function discard() {
    if (dirty && !window.confirm('Discard unsaved notes?')) return false;
    markDirty(false);
    return true;
  }
  // CS-36: clears the caller's dirty signal (and, via SavedPage/
  // ApplicationsPage, the shared unsaved-changes registry AuthenticatedShell
  // reads on session expiry) when this whole screen unmounts - e.g. the
  // sidebar's plain <Link> navigation away from /saved or /applications,
  // which (like every client-side route change today) does not itself run
  // discard()'s confirmation. Without this, a stale "true" from an earlier
  // visit would incorrectly still read as dirty on an unrelated later page.
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  const leads = useInfiniteQuery({
    queryKey: ownerKey(owner, 'leads', status),
    // CS-61: MANDATORY. Without this the query can run before the session
    // resolves, building `[name, undefined, ...]` - which merges every owner
    // back into one bucket and looks owner-scoped in the source.
    enabled: !!owner,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<{ items: Lead[]; nextCursor: string | null }>(
        `/leads?status=${status}${pageParam ? `&before=${pageParam}` : ''}`,
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor,
    retry: 1,
  });
  const detail = useQuery({
    queryKey: ownerKey(owner, 'lead', selected),
    enabled: !!owner && !!selected,
    queryFn: ({ signal }) => api<Lead>(`/leads/${selected}`, { signal }),
    refetchOnWindowFocus: false,
    retry: 1,
  });
  // Read-only: whichever *other* status tab on this same screen has already
  // been loaded and is known to contain leads. It issues no extra request and
  // invents nothing — an unvisited tab is simply unknown, and unknown is
  // treated as "nothing is known", not as "empty".
  const populatedSibling = statuses.find(
    (value) =>
      value !== status &&
      (cache
        .getQueryData<{ pages: { items: Lead[] }[] }>(['leads', value])
        ?.pages.some((page) => page.items.length > 0) ??
        false),
  );
  return (
    <section className="results saved-workspace">
      <div className={styles.workspaceActions}>
        <button
          className="icon-button"
          title="Back to search"
          aria-label="Back to search"
          onClick={() => {
            if (discard()) onBack();
          }}
        >
          <ArrowLeft size={18} />
        </button>
        <h1>{scope === 'applications' ? 'Applications' : 'Saved Leads'}</h1>
      </div>
      <div className={styles.tabsRow} role="group" aria-label="Lead status">
        {statuses.map((value) => (
          <button
            key={value}
            className={styles.tab}
            aria-pressed={status === value}
            onClick={() => {
              if (discard()) {
                setStatus(value);
                setSelected(null);
              }
            }}
          >
            {statusLabel(value)}
          </button>
        ))}
      </div>
      <div className={styles.layout}>
        <div>
          {leads.isPending && <LoadingState variant="inline" message="Loading leads..." />}
          {leads.error && (
            <ErrorState
              variant="inline"
              what={`Could not load your ${scope === 'applications' ? 'applications' : 'saved leads'}.`}
              detail={leads.error.message}
              action={
                <button onClick={() => leads.refetch()}>
                  <RefreshCw size={16} />
                  Retry Leads
                </button>
              }
            />
          )}
          {leads.data?.pages[0]?.items.length === 0 && (
            // CS-13 AC3: this list is ALWAYS filtered by the status tabs
            // above, so an empty result has two genuinely different meanings
            // and the owner has to be able to tell them apart. When another
            // status in this same screen is already known — from its own
            // loaded query, never a guess or an invented count — to hold
            // leads, this is "nothing matches the filter you picked" and the
            // message names the status that does have them. Otherwise
            // nothing is known beyond this status, so it stays the plain
            // "nothing here yet" message and points at the one action that
            // actually populates it.
            <EmptyState
              variant="inline"
              // Same condition as the copy: a populated sibling status means
              // data exists and only THIS filtered view is empty.
              reason={populatedSibling ? 'filtered' : 'nothing-yet'}
              message={
                populatedSibling
                  ? `No leads with status “${statusLabel(status)}”. That is this status filter only — “${statusLabel(populatedSibling)}” has leads; choose it above to see them.`
                  : `No leads with status “${statusLabel(status)}” yet. Save a job from Search to add one here.`
              }
            />
          )}
          <nav className={styles.list} aria-label="Saved lead list">
            {leads.data?.pages
              .flatMap((page) => page.items)
              .map((lead) => (
                <button
                  key={lead.id}
                  className={styles.leadCard}
                  aria-current={selected === lead.id ? 'true' : undefined}
                  onClick={() => {
                    if (selected !== lead.id && discard()) setSelected(lead.id);
                  }}
                >
                  <span className={styles.leadCardIdentity}>
                    <strong>{lead.data.title}</strong>
                    <span>{lead.data.company}</span>
                    {lead.data.location && <small>{lead.data.location}</small>}
                  </span>
                  <span className={styles.leadCardMeta}>
                    <span className={styles.statusBadge} data-status={lead.status}>
                      <span className={styles.statusDot} aria-hidden="true" />
                      {statusLabel(lead.status)}
                    </span>
                    {lead.data.match && (
                      <span className={styles.leadCardMatch}>
                        {Math.round(lead.data.match.score * 100)}% match
                      </span>
                    )}
                  </span>
                </button>
              ))}
          </nav>
          {leads.hasNextPage && (
            <button disabled={leads.isFetchingNextPage} onClick={() => leads.fetchNextPage()}>
              More Leads
            </button>
          )}
        </div>
        {!selected ? (
          <EmptyState variant="inline" reason="awaiting-input" message="Select a lead." />
        ) : detail.isPending ? (
          <LoadingState variant="inline" message="Loading lead..." />
        ) : detail.error ? (
          <ErrorState
            variant="inline"
            what="Could not open this lead."
            detail={detail.error.message}
            action={
              <button onClick={() => detail.refetch()}>
                <RefreshCw size={16} />
                Retry Lead
              </button>
            }
          />
        ) : (
          detail.data && (
            <LeadEditor
              key={`${detail.data.id}:${detail.data.revision}`}
              record={detail.data}
              csrf={csrf}
              onDirty={markDirty}
              allowedStatuses={statuses}
              onStatus={(next) => {
                // Independent Reviewer finding 1, 2026-09-23: a status change
                // that lands outside this screen's own scope (e.g. archiving
                // a lead from /applications) must not silently reassign the
                // visible tab filter to a status this screen doesn't show -
                // that left no tab highlighted and quietly listed the other
                // screen's leads. Deselect instead; the list itself already
                // refetches and the now out-of-scope lead simply drops out.
                if (statuses.includes(next)) setStatus(next);
                else setSelected(null);
              }}
            />
          )
        )}
      </div>
    </section>
  );
}
