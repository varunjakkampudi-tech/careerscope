import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, RefreshCw, UserRound } from 'lucide-react';
import type { PreparationReport } from '@careerscope/core';
import { api, ApiError } from '../lib/api';

export default function PreparationPanel({ onProfile }: { onProfile: () => void }) {
  const cache = useQueryClient();
  const report = useQuery({
    queryKey: ['preparation'],
    queryFn: ({ signal }) => api<PreparationReport>('/preparation', { signal }),
    retry: false,
    gcTime: 0,
  });
  const expired = report.error instanceof ApiError && report.error.status === 401;
  useEffect(() => {
    if (expired) {
      cache.clear();
      cache.setQueryData(['session'], { authenticated: false });
    }
  }, [cache, expired]);
  return (
    <section className="workspace-overview preparation" aria-labelledby="preparation-heading">
      <p className="eyebrow">Career preparation</p>
      <h1 id="preparation-heading">Resume &amp; Interview Prep</h1>
      <div className="overview-actions">
        <button type="button" onClick={onProfile}>
          <UserRound size={17} />
          Edit profile
        </button>
        <button type="button" onClick={() => void report.refetch()} disabled={report.isFetching}>
          <RefreshCw size={17} className={report.isFetching ? 'spin' : undefined} />
          Refresh
        </button>
      </div>
      {report.isPending ? (
        <p role="status">
          <LoaderCircle size={18} className="spin" /> Preparing review...
        </p>
      ) : report.isError ? (
        <p role="alert">{report.error.message}</p>
      ) : (
        report.data && (
          <>
            <p className="muted">
              Rules-based review | AI inference off | Saved profile revision{' '}
              {report.data.profileRevision}
            </p>
            {report.data.status === 'profile-required' ? (
              <p role="status">Save a profile to prepare your review and practice questions.</p>
            ) : (
              <>
                <h2>Review Checklist</h2>
                <ul className="preparation-list">
                  {report.data.checks.map((check) => (
                    <li key={check.id}>
                      <h3>{check.title}</h3>
                      <span className="muted">
                        {check.state === 'not-assessed' ? 'Not assessed' : 'Needs your review'}
                      </span>
                      <p>{check.detail}</p>
                      <Evidence items={check.evidence} />
                    </li>
                  ))}
                </ul>
                <h2>Clarify Your Profile</h2>
                <Questions
                  items={report.data.questions.filter(
                    (question) => question.kind === 'clarification',
                  )}
                />
                <h2>Interview Practice</h2>
                <Questions
                  items={report.data.questions.filter((question) => question.kind === 'practice')}
                />
              </>
            )}
            <aside aria-label="Assessment limits" className="preparation-limits">
              <h2>Assessment Limits</h2>
              <ul>
                {report.data.limitations.map((limit) => (
                  <li key={limit}>{limit}</li>
                ))}
              </ul>
            </aside>
          </>
        )
      )}
    </section>
  );
}

function Evidence({ items }: { items: PreparationReport['questions'][number]['evidence'] }) {
  if (!items.length) return null;
  return (
    <ul className="preparation-evidence" aria-label="Saved profile evidence">
      {items.map((item, index) => (
        <li key={`${item.field}-${index}`}>
          <span>{item.field}</span>: <q>{item.value}</q>
        </li>
      ))}
    </ul>
  );
}

function Questions({ items }: { items: PreparationReport['questions'] }) {
  return (
    <ol className="preparation-list">
      {items.map((item) => (
        <li key={item.id}>
          <p>{item.question}</p>
          <Evidence items={item.evidence} />
        </li>
      ))}
    </ol>
  );
}
