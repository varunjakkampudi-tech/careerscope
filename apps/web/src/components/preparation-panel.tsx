import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, RefreshCw, Sparkles, UserRound } from 'lucide-react';
import type { PreparationReport } from '@careerscope/core';
import { api, ApiError } from '../lib/api';
import { ownerKey, useSession } from '../lib/session';
import { EmptyState, ErrorState, LoadingState } from './ui-states';

type ElaborateResponse = { checkId: string; text: string; source: 'ai'; model: string };

export default function PreparationPanel({
  onProfile,
  csrf,
}: {
  onProfile: () => void;
  csrf: string;
}) {
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
            {/* CS-48 F-1 / CS-39 AC2: this caption was the fixed string
                "Rules-based review | AI inference off | Saved profile revision
                N", rendered directly above per-item "Get AI coaching" buttons.
                It was FALSE on screen whenever AI_ENABLED was true — the one
                surface AI actually reaches told the owner the opposite. It now
                derives from the server's real capability flag. The
                rules-based half never changes, because scoring, exclusions and
                ranking stay deterministic whatever the AI setting is; only the
                optional coaching elaboration is affected, and the caption now
                says exactly that. */}
            <p className="muted">
              Rules-based review |{' '}
              {session.data?.aiEnabled === true
                ? 'optional AI coaching available'
                : 'AI inference off'}{' '}
              | Saved profile revision {report.data.profileRevision}
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
                      <AiElaborate id={check.id} csrf={csrf} />
                    </li>
                  ))}
                </ul>
                <h2>Clarify Your Profile</h2>
                <Questions
                  items={report.data.questions.filter(
                    (question) => question.kind === 'clarification',
                  )}
                  csrf={csrf}
                />
                <h2>Interview Practice</h2>
                <Questions
                  items={report.data.questions.filter((question) => question.kind === 'practice')}
                  csrf={csrf}
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

function Questions({ items, csrf }: { items: PreparationReport['questions']; csrf: string }) {
  return (
    <ol className="preparation-list">
      {items.map((item) => (
        <li key={item.id}>
          <p>{item.question}</p>
          <Evidence items={item.evidence} />
          <AiElaborate id={item.id} csrf={csrf} />
        </li>
      ))}
    </ol>
  );
}

/**
 * CS-48's only UI surface. A per-item, opt-in button rather than an always-on
 * panel: nothing is sent to OpenRouter unless the owner explicitly clicks it
 * for that specific item. Renders the returned text as a plain React child
 * (never dangerouslySetInnerHTML), so it is always HTML-escaped, and always
 * carries a visible "AI-generated" label distinct from the deterministic
 * rules-v1 text above it (Security review P2, CS-48).
 */
function AiElaborate({ id, csrf }: { id: string; csrf: string }) {
  const session = useSession();
  const elaborate = useMutation({
    mutationFn: () =>
      api<ElaborateResponse>(`/preparation/${id}/ai-elaborate`, {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
      }),
  });
  // CS-48 F-1: the trigger used to render unconditionally and 503 on click —
  // a control that names an action it cannot perform. The gate lives HERE
  // rather than at the two call sites deliberately: one of them sits in a
  // separate `Questions` component with no session in scope, so gating per
  // call site meant threading a prop and leaving two places that could drift
  // apart. One component owns the capability question.
  if (session.data?.aiEnabled !== true) return null;
  if (elaborate.data) {
    return (
      <p className="ai-elaboration">
        <span className="ai-elaboration-badge">
          <Sparkles size={13} aria-hidden="true" /> AI-generated coaching
        </span>
        {elaborate.data.text}
      </p>
    );
  }
  return (
    <div className="ai-elaboration-trigger">
      <button type="button" onClick={() => elaborate.mutate()} disabled={elaborate.isPending}>
        <Sparkles size={14} />
        {elaborate.isPending ? 'Asking AI coach...' : 'Get AI coaching'}
      </button>
      {elaborate.isError && (
        <span role="alert" className="muted">
          {elaborate.error instanceof ApiError
            ? elaborate.error.status === 503
              ? 'AI coaching is not enabled for this account.'
              : elaborate.error.message
            : 'AI coaching is unavailable right now.'}
        </span>
      )}
    </div>
  );
}
