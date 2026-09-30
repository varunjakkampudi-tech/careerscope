'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, LoaderCircle, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import type { ResumeParseOutcome } from '@careerscope/core';
import { api } from '../lib/api';
import { useOwner, ownerKey } from '../lib/session';
import { EmptyState, ErrorState, LoadingState } from './ui-states';

export type ResumeProposal = Extract<ResumeParseOutcome, { status: 'parsed' }>['parsed']['derived'];
type ResumeRow = { id: string; bytes: number; createdAt: string; status: string };

export default function ResumePanel({
  csrf,
  onReview,
}: {
  csrf: string;
  onReview: (proposal: ResumeProposal) => void;
}) {
  const cache = useQueryClient();
  // CS-61: owner-scoped query keys. Present exactly when authenticated.
  const owner = useOwner();
  const input = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<{ value: File; key: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const resumes = useQuery({
    queryKey: ownerKey(owner, 'resumes'),
    // CS-61: MANDATORY. Without this the query can run before the session
    // resolves, building `[name, undefined, ...]` - which merges every owner
    // back into one bucket and looks owner-scoped in the source.
    enabled: !!owner,
    queryFn: ({ signal }) =>
      api<{ enabled: boolean; cancellationEnabled?: boolean; items: ResumeRow[] }>('/resumes', {
        signal,
      }),
    retry: 1,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => ['queued', 'uploading'].includes(item.status))
        ? 3000
        : false,
  });
  const detail = useQuery({
    queryKey: ownerKey(owner, 'resume', selected),
    enabled: !!owner && !!selected,
    queryFn: ({ signal }) =>
      api<{ id: string; status: string; result: ResumeParseOutcome | null }>(
        `/resumes/${selected}`,
        { signal },
      ),
    retry: 1,
    refetchInterval: (query) =>
      query.state.data && ['queued', 'uploading'].includes(query.state.data.status) ? 3000 : false,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/resumes/${id}`, { method: 'DELETE', headers: { 'x-csrf-token': csrf } }),
    onSuccess: (_result, id) => {
      setSelected(null);
      cache.removeQueries({ queryKey: ['resume', id] });
      void cache.invalidateQueries({ queryKey: ['resumes'] });
    },
  });
  const recover = useMutation({
    mutationFn: (id: string) =>
      api<{ id: string; status: string }>(`/resumes/${id}/recover`, {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
      }),
    onSuccess: (result) => {
      setSelected(result.id);
      setError('');
      void cache.invalidateQueries({ queryKey: ['resumes'] });
      void cache.invalidateQueries({ queryKey: ['resume', result.id] });
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api<{ id: string; status: string }>(`/resumes/${id}/cancel`, {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
      }),
    onSuccess: () => {
      setFile(null);
      if (input.current) input.current.value = '';
      setError('');
    },
    onSettled: (_result, _error, id) => {
      void cache.invalidateQueries({ queryKey: ['resumes'] });
      void cache.invalidateQueries({ queryKey: ['resume', id] });
    },
  });
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || pending) return;
    if (file.value.size < 1 || file.value.size > 5 * 1024 * 1024) {
      setError('Choose a PDF or DOCX file up to 5 MiB.');
      return;
    }
    setPending(true);
    setError('');
    try {
      const result = await api<{ id: string }>('/resumes', {
        method: 'POST',
        body: file.value,
        headers: {
          'content-type': 'application/octet-stream',
          'x-csrf-token': csrf,
          'idempotency-key': file.key,
        },
      });
      setSelected(result.id);
      setFile(null);
      if (input.current) input.current.value = '';
      await cache.invalidateQueries({ queryKey: ['resumes'] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Upload failed.');
      await cache.invalidateQueries({ queryKey: ['resumes'] });
    } finally {
      setPending(false);
    }
  }
  const result = detail.data?.result;
  return (
    <section className="resume-section" aria-labelledby="resume-heading">
      <h2 id="resume-heading">
        <FileText size={19} aria-hidden="true" /> Resume
      </h2>
      {resumes.isPending ? (
        <LoadingState variant="inline" message="Loading resumes..." />
      ) : resumes.isError ? (
        <div role="alert">
          <p>Could not load your resumes. {resumes.error.message}</p>
          <button type="button" onClick={() => resumes.refetch()}>
            <RefreshCw size={16} />
            Retry
          </button>
        </div>
      ) : !resumes.data.enabled ? (
        <p>Resume uploads unavailable.</p>
      ) : (
        <>
          <form onSubmit={upload} className="resume-upload">
            <label>
              Resume file (PDF or DOCX, up to 5 MiB)
              <input
                ref={input}
                type="file"
                accept=".pdf,.docx"
                disabled={pending}
                onChange={(event) => {
                  const value = event.target.files?.[0];
                  setFile(value ? { value, key: crypto.randomUUID() } : null);
                  setError('');
                }}
              />
            </label>
            <button type="submit" disabled={!file || pending}>
              {pending ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />}Upload
              resume
            </button>
          </form>
          {error && <p role="alert">{error}</p>}
          {resumes.data.items.length === 0 && (
            // This list has no filter — its only empty is "nothing yet".
            <EmptyState variant="inline" reason="nothing-yet" message="No resumes uploaded." />
          )}
          <ul className="resume-list">
            {resumes.data.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-pressed={selected === item.id}
                  onClick={() => {
                    setSelected(item.id);
                    remove.reset();
                    recover.reset();
                    cancel.reset();
                  }}
                >
                  <FileText size={17} aria-hidden="true" />
                  {new Date(item.createdAt).toLocaleDateString()}
                  <span>{item.status}</span>
                </button>
                {item.status === 'uploading' && (
                  <button
                    type="button"
                    title="Recover upload"
                    aria-label="Recover upload"
                    disabled={recover.isPending || cancel.isPending || pending}
                    onClick={() => recover.mutate(item.id)}
                  >
                    <RefreshCw className={recover.isPending ? 'spin' : undefined} size={17} />
                  </button>
                )}
                {resumes.data.cancellationEnabled &&
                  ['uploading', 'cancelling'].includes(item.status) && (
                    <button
                      type="button"
                      title={
                        item.status === 'cancelling' ? 'Retry upload cleanup' : 'Cancel upload'
                      }
                      aria-label={
                        item.status === 'cancelling' ? 'Retry upload cleanup' : 'Cancel upload'
                      }
                      disabled={cancel.isPending || recover.isPending || pending}
                      onClick={() => {
                        if (
                          window.confirm(
                            'Cancel this unfinished upload and remove its file? This upload cannot be recovered afterward.',
                          )
                        )
                          cancel.mutate(item.id);
                      }}
                    >
                      <X size={17} />
                    </button>
                  )}
                <button
                  type="button"
                  title="Delete resume"
                  aria-label="Delete resume"
                  disabled={remove.isPending || !['parsed', 'rejected'].includes(item.status)}
                  onClick={() => {
                    if (
                      window.confirm(
                        'Delete this resume and its extracted text? Saved profile fields will remain.',
                      )
                    )
                      remove.mutate(item.id);
                  }}
                >
                  <Trash2 size={17} />
                </button>
              </li>
            ))}
          </ul>
          {remove.error && (
            <ErrorState
              variant="inline"
              what="Could not delete that resume."
              detail={remove.error.message}
            />
          )}
          {recover.isPending && <p role="status">Recovering upload...</p>}
          {recover.error && (
            <ErrorState
              variant="inline"
              what="Could not recover that upload."
              detail={recover.error.message}
            />
          )}
          {cancel.isPending && <p role="status">Cancelling upload...</p>}
          {cancel.error && (
            <ErrorState
              variant="inline"
              what="Could not cancel that upload."
              detail={cancel.error.message}
            />
          )}
          {recover.data?.status === 'uploading' && (
            <p role="status">No complete file was found. Upload the document again.</p>
          )}
          {selected &&
            (detail.isPending ? (
              <LoadingState variant="inline" message="Loading resume..." />
            ) : detail.error ? (
              <ErrorState
                variant="inline"
                what="Could not load that resume."
                detail={`${detail.error.message} Reload the page to try again.`}
              />
            ) : (
              <div className="resume-review">
                {!result && <p role="status">Resume processing: {detail.data?.status}</p>}
                {result?.status === 'rejected' && (
                  <p role="alert">
                    {result.errorCode === 'invalid_document'
                      ? 'This document could not be read safely. Choose another PDF or DOCX.'
                      : 'Resume processing failed. Please retry with a new upload.'}
                  </p>
                )}
                {result?.status === 'parsed' && (
                  <>
                    <p role="status">Resume ready for review.</p>
                    <button type="button" onClick={() => onReview(result.parsed.derived)}>
                      <FileText size={17} />
                      Review profile draft
                    </button>
                    <details>
                      <summary>Extracted text</summary>
                      <pre>{result.parsed.text}</pre>
                    </details>
                  </>
                )}
              </div>
            ))}
        </>
      )}
    </section>
  );
}
