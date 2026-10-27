import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, RefreshCw, UserRound } from 'lucide-react';
import type { PreparationReport } from '@careerscope/core';
import { api, ApiError } from '../lib/api';
import { ownerKey, useSession } from '../lib/session';
import { EmptyState, ErrorState, LoadingState } from './ui-states';

export default function PreparationPanel({ onProfile }: { onProfile: () => void }) {
  const cache = useQueryClient();
  const session = useSession();
  // CS-61: present exactly when authenticated.
  const owner = session.data?.owner;
  const report = useQuery({
    queryKey: ownerKey(owner, 'preparation'),
    // CS-61: MANDATORY. Without this the query can run before the session
    // resolves, building `[name, undefined, ...]` - which merges every owner
    // back into one bucket and looks owner-scoped in the source.
    enabled: !!owner,
    queryFn: ({ signal }) => api<PreparationReport>('/preparation', { signal }),
    retry: false,
    gcTime: 0,
  });
  const expired = report.error instanceof ApiError && report.error.status === 401;
  useEffect(() => {
    // api() already dispatches SESSION_EXPIRED_EVENT on every 401, which
    // AuthenticatedShell is the single listener for (Independent Reviewer
    // finding 2, 2026-09-23) - this effect only needs to exist because a
    // query with retry:false surfaces the 401 as report.error rather than
    // rethrowing somewhere already observed.
    if (expired) cache.removeQueries({ queryKey: ['preparation'] });
  }, [cache, expired]);
  return (
    <section className="workspace-overview preparation" aria-labelledby="preparation-heading">
      <p className="eyebrow">Career preparation</p>
      <h1 id="preparation-heading" className="preparation-heading">
        Resume &amp; Interview Prep
      </h1>
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
        <LoadingState
          variant="inline"
          message="Preparing review..."
          icon={<LoaderCircle size={18} className="spin" />}
        />
      ) : report.isError ? (
        <ErrorState
          variant="inline"
          what="Could not prepare your review."
          detail={`${report.error.message} Use Refresh above to try again.`}
        />
      ) : (
        report.data && (
          <>
            <p className="muted">
              Rules-based review | Saved profile revision {report.data.profileRevision}
            </p>
            {report.data.status === 'profile-required' ? (
              // Not a filtered empty: this report has no filter at all, so
              // this is the "nothing yet" case and names the one action that
              // fills it (the Edit profile control above).
              <EmptyState
                variant="inline"
                announce
                reason="awaiting-input"
                message="Save a profile to prepare your review and practice questions."
              />
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
