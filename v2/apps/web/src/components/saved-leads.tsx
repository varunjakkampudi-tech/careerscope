'use client';

import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowLeft,
  Bookmark,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Save,
  Undo2,
} from 'lucide-react';
import type { LeadRecord, LeadHistoryRecord } from '@careerscope/core';
import { api, ApiError } from '../lib/api';
import MatchEvidence from './match-evidence';

type Lead = Omit<LeadRecord, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string };
type History = Omit<LeadHistoryRecord, 'createdAt'> & { createdAt: string };

export function SaveJob({
  jobId,
  csrf,
  onOpen,
}: {
  jobId: string;
  csrf: string;
  onOpen: (id: string) => void;
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
  return (
    <div>
      <button
        type="button"
        onClick={() => (save.data ? onOpen(save.data.id) : save.mutate())}
        disabled={save.isPending}
      >
        {save.isPending ? <LoaderCircle size={16} className="spin" /> : <Bookmark size={16} />}
        {save.data
          ? save.data.status === 'archived'
            ? 'Open Archived Lead'
            : 'Open Saved Lead'
          : 'Save Job'}
      </button>
      {save.error && <p role="alert">{save.error.message}</p>}
    </div>
  );
}

function LeadEditor({
  record,
  csrf,
  onDirty,
  onStatus,
}: {
  record: Lead;
  csrf: string;
  onDirty: (dirty: boolean) => void;
  onStatus: (status: Lead['status']) => void;
}) {
  const cache = useQueryClient();
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
    queryKey: ['lead-history', record.id],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam, signal }) =>
      api<{ items: History[]; nextCursor: number | null }>(
        `/leads/${record.id}/history${pageParam ? `?before=${pageParam}` : ''}`,
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor,
    retry: 1,
  });
  const pending = save.isPending || reload.isPending;
  return (
    <article className="lead-detail" aria-label="Lead details">
      <p className="company">{record.data.company}</p>
      <h2>{record.data.title}</h2>
      <p>{record.data.location}</p>
      <p role="status">
        {record.status === 'archived' ? 'Archived' : 'Saved'} &middot; Revision {record.revision}
      </p>
      <div className="job-links">
        {(record.data.sourceLinks?.length
          ? record.data.sourceLinks
          : [{ source: record.data.source, url: record.data.sourceUrl }]
        ).map((link) => (
          <a
            key={`${link.source}:${link.url}`}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {
              {
                remoteok: 'Remote OK',
                himalayas: 'Himalayas',
                greenhouse: 'Greenhouse',
                lever: 'Lever',
                workable: 'Workable',
              }[link.source]
            }{' '}
            <ExternalLink size={14} />
          </a>
        ))}
        <a href={record.data.applyUrl} target="_blank" rel="noopener noreferrer">
          Open Posting <ExternalLink size={14} />
        </a>
      </div>
      {record.data.match && <MatchEvidence match={record.data.match} />}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(record.status);
        }}
      >
        <label className="lead-notes">
          Notes
          <textarea
            name="notes"
            maxLength={10000}
            value={notes}
            disabled={pending}
            onChange={(event) => {
              setNotes(event.target.value);
              onDirty(event.target.value !== record.notes);
            }}
          />
        </label>
        <div className="lead-actions">
          <button type="submit" disabled={pending || notes === record.notes}>
            <Save size={16} />
            Save Notes
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const status = record.status === 'saved' ? 'archived' : 'saved';
              if (
                window.confirm(
                  status === 'archived'
                    ? 'Archive this lead and save current notes?'
                    : 'Restore this lead and save current notes?',
                )
              )
                save.mutate(status);
            }}
          >
            {record.status === 'saved' ? <Archive size={16} /> : <Undo2 size={16} />}
            {record.status === 'saved' ? 'Archive Lead' : 'Restore Lead'}
          </button>
        </div>
        {pending && <p role="status">Saving...</p>}
        {(save.error || reload.error) && (
          <p role="alert">{save.error?.message ?? reload.error?.message}</p>
        )}
        {save.error instanceof ApiError && save.error.status === 409 && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (window.confirm('Discard unsaved notes and reload this lead?')) reload.mutate();
            }}
          >
            <RefreshCw size={16} />
            Discard Edits and Reload
          </button>
        )}
      </form>
      <details className="lead-description">
        <summary>Job Description</summary>
        <p className="description">{record.data.description}</p>
      </details>
      <section aria-label="Lead history">
        <h3>History</h3>
        {history.isPending && <p role="status">Loading history...</p>}
        {history.error && (
          <p role="alert">
            {history.error.message}
            <button onClick={() => history.refetch()}>
              <RefreshCw size={16} />
              Retry History
            </button>
          </p>
        )}
        <ol className="lead-history">
          {history.data?.pages
            .flatMap((page) => page.items)
            .map((entry) => (
              <li key={entry.revision}>
                <strong>
                  Revision {entry.revision}: {entry.status}
                </strong>
                {entry.notesChanged ? ' - Notes updated' : ''}
                <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
              </li>
            ))}
        </ol>
        {history.hasNextPage && (
          <button disabled={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>
            Older History
          </button>
        )}
      </section>
    </article>
  );
}

export default function SavedLeads({
  csrf,
  initialId,
  onBack,
  onDirty,
}: {
  csrf: string;
  initialId: string | null;
  onBack: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const cache = useQueryClient();
  const [status, setStatus] = useState<Lead['status']>(
    () => cache.getQueryData<Lead>(['lead', initialId])?.status ?? 'saved',
  );
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
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  const leads = useInfiniteQuery({
    queryKey: ['leads', status],
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
    queryKey: ['lead', selected],
    enabled: !!selected,
    queryFn: ({ signal }) => api<Lead>(`/leads/${selected}`, { signal }),
    refetchOnWindowFocus: false,
    retry: 1,
  });
  return (
    <section className="results saved-workspace">
      <div className="lead-actions">
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
        <h1>Saved Leads</h1>
      </div>
      <div className="lead-tabs" role="group" aria-label="Lead status">
        {(['saved', 'archived'] as const).map((value) => (
          <button
            key={value}
            aria-pressed={status === value}
            onClick={() => {
              if (discard()) {
                setStatus(value);
                setSelected(null);
              }
            }}
          >
            {value === 'saved' ? 'Saved' : 'Archived'}
          </button>
        ))}
      </div>
      <div className="lead-layout">
        <div>
          {leads.isPending && <p role="status">Loading leads...</p>}
          {leads.error && (
            <p role="alert">
              {leads.error.message}
              <button onClick={() => leads.refetch()}>
                <RefreshCw size={16} />
                Retry Leads
              </button>
            </p>
          )}
          {leads.data?.pages[0]?.items.length === 0 && <p>No {status} leads.</p>}
          <nav className="lead-list" aria-label="Saved lead list">
            {leads.data?.pages
              .flatMap((page) => page.items)
              .map((lead) => (
                <button
                  key={lead.id}
                  aria-current={selected === lead.id ? 'true' : undefined}
                  onClick={() => {
                    if (selected !== lead.id && discard()) setSelected(lead.id);
                  }}
                >
                  <strong>{lead.data.title}</strong>
                  <span>{lead.data.company}</span>
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
          <p>Select a lead.</p>
        ) : detail.isPending ? (
          <p role="status">Loading lead...</p>
        ) : detail.error ? (
          <p role="alert">
            {detail.error.message}
            <button onClick={() => detail.refetch()}>
              <RefreshCw size={16} />
              Retry Lead
            </button>
          </p>
        ) : (
          detail.data && (
            <LeadEditor
              key={`${detail.data.id}:${detail.data.revision}`}
              record={detail.data}
              csrf={csrf}
              onDirty={markDirty}
              onStatus={setStatus}
            />
          )
        )}
      </div>
    </section>
  );
}
