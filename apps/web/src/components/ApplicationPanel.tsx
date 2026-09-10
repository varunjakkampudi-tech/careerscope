import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, RefreshCw, Send, Square } from 'lucide-react';
import { Link } from 'react-router-dom';
import { request } from '../lib/api';
import { browserApplicationRequest, type ApplicationDestination } from '../lib/browserApplication';
import {
  applicationLabels,
  isApplicationActive,
  useApplications,
  type ApplicationRun,
} from '../lib/applications';
import { Alert, Button, Checkbox, CopyButton, ExternalLink, Field, Select, Textarea } from './ui';

export function ApplicationPanel({ leadId }: { leadId: string }) {
  const [method, setMethod] = useState<'shared' | 'local'>('shared');
  const [destination, setDestination] = useState<ApplicationDestination>('source-first');
  const handoffId = useId();
  const [consent, setConsent] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(false);
  const [retryOf, setRetryOf] = useState<string | undefined>();
  const client = useQueryClient();
  const applications = useApplications(leadId);
  const capability = useQuery({
    queryKey: ['application-capability'],
    queryFn: () =>
      request<{
        available: boolean;
        reason: string | null;
        emailVerificationAvailable?: boolean;
      }>('/applications/capability'),
    retry: false,
    staleTime: 60000,
    enabled: method === 'local',
  });
  const start = useMutation({
    mutationFn: () =>
      request<{ run: ApplicationRun }>('/applications', {
        method: 'POST',
        body: { leadId, consent, autoSubmit, ...(retryOf ? { retryOf } : {}) },
      }),
    onSuccess: () => {
      setRetryOf(undefined);
      return client.invalidateQueries({ queryKey: ['applications'] });
    },
  });
  const latest = applications.data?.runs[0];
  const active = applications.data?.active;
  return (
    <section className="min-w-0 border-t border-border pt-3" aria-label="Application agent">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Bot size={16} aria-hidden="true" /> AI application
        </h3>
        <Link to="/applications" className="text-sm text-accent hover:underline">
          Applications
        </Link>
      </div>
      {applications.isError ? (
        <p role="alert" className="mt-3 text-sm text-bad">
          {applications.error.message}
        </p>
      ) : null}
      {latest ? <ApplicationProgress key={latest.id} run={latest} /> : null}
      <fieldset className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-b border-border pb-3 text-sm">
        <legend className="sr-only">Application method</legend>
        {(
          [
            ['shared', 'Shared browser'],
            ['local', 'Local agent'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name={`${handoffId}-method`}
              value={value}
              checked={method === value}
              disabled={start.isPending}
              onChange={() => {
                setMethod(value);
                setConsent(false);
                setAutoSubmit(false);
              }}
              className="accent-accent"
            />
            {label}
          </label>
        ))}
      </fieldset>
      {method === 'shared' ? (
        <div className="mt-3 min-w-0 space-y-3">
          {applications.isPending ? (
            <p role="status" className="text-sm text-muted">
              Checking application history...
            </p>
          ) : applications.isError ? null : active ? (
            <Alert tone="warn" title="An application is already active">
              <Link to="/applications">Review the active application.</Link>
            </Alert>
          ) : latest?.status === 'submitted' ? (
            <p role="status" className="text-sm text-muted">
              Application already submitted.
            </p>
          ) : latest?.outcomeUnknown ? (
            <p role="status" className="text-sm text-muted">
              Check the employer portal before another attempt.
            </p>
          ) : (
            <>
              <Field label="Apply via" htmlFor={`${handoffId}-destination`}>
                <Select
                  id={`${handoffId}-destination`}
                  value={destination}
                  onChange={(event) => setDestination(event.target.value as ApplicationDestination)}
                >
                  <option value="source-first">Source first, careers fallback</option>
                  <option value="source">Source portal</option>
                  <option value="careers">Employer careers page</option>
                </Select>
              </Field>
              <Field label="Copilot chat request" htmlFor={handoffId}>
                <Textarea
                  id={handoffId}
                  readOnly
                  rows={8}
                  value={browserApplicationRequest(leadId, destination)}
                  className="text-xs"
                />
              </Field>
              <CopyButton
                key={`${leadId}:${destination}`}
                value={browserApplicationRequest(leadId, destination)}
                label="Copy browser request"
              />
              <p role="status" className="text-xs text-muted">
                No application started. Account creation and final submission require approval in
                Copilot chat.
              </p>
            </>
          )}
        </div>
      ) : null}
      {method === 'local' &&
      !isApplicationActiveOrMissing(latest) &&
      latest?.status !== 'submitted' ? (
        <div className="mt-4 flex flex-col gap-3">
          {capability.isPending ? (
            <p role="status" className="text-sm text-muted">
              Checking Copilot runtime...
            </p>
          ) : null}
          {capability.error || capability.data?.reason ? (
            <Alert tone="warn" title="Agent setup required">
              {capability.error?.message ?? capability.data?.reason}
            </Alert>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            disabled={capability.isFetching}
            onClick={() => void capability.refetch()}
          >
            <RefreshCw size={14} aria-hidden="true" /> Refresh agent status
          </Button>
          {active && active.leadId !== leadId ? (
            <Alert tone="warn" title="Another application is active">
              <Link to="/applications">Review or cancel it in Applications.</Link>
            </Alert>
          ) : null}
          <Checkbox
            checked={consent}
            onChange={setConsent}
            label="Share my saved profile and attached resume with Copilot and this employer. Copilot usage may count toward my plan allowance."
          />
          {latest?.outcomeUnknown ? (
            <Checkbox
              checked={retryOf === latest.id}
              onChange={(checked) => setRetryOf(checked ? latest.id : undefined)}
              label="I checked the employer portal and confirmed this application was not received. Retry this job."
            />
          ) : null}
          <Checkbox
            checked={autoSubmit}
            onChange={setAutoSubmit}
            label="Authorize automatic submission for this job once the details are complete. Otherwise, pause for final review."
          />
          <p className="text-xs text-muted">
            The application browser opens on the computer running CareerScope, not this phone.
            Account creation and terms require separate approval. Enter passwords and CAPTCHA only
            in that application browser. Never paste verification codes into a reply.
          </p>
          {capability.data?.available ? (
            <p role="status" className="text-xs text-muted">
              {capability.data.emailVerificationAvailable
                ? 'Gmail verification: configured. Approval required for each code; final submission stays review-first.'
                : 'Gmail verification: not connected. Complete email verification in the application browser.'}
            </p>
          ) : null}
          <Button
            variant="primary"
            disabled={
              !consent ||
              (!!latest?.outcomeUnknown && retryOf !== latest.id) ||
              !capability.data?.available ||
              !!active ||
              start.isPending ||
              applications.isPending ||
              applications.isError
            }
            onClick={() => start.mutate()}
          >
            <Bot size={16} aria-hidden="true" />{' '}
            {start.isPending ? 'Starting...' : 'Apply with Copilot'}
          </Button>
          {start.error ? (
            <p role="alert" className="text-sm text-bad">
              {start.error.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function isApplicationActiveOrMissing(run: ApplicationRun | undefined): boolean {
  return run ? isApplicationActive(run) : false;
}

export function ApplicationProgress({ run }: { run: ApplicationRun }) {
  const client = useQueryClient();
  useEffect(() => {
    if (run.status === 'submitted') void client.invalidateQueries({ queryKey: ['leads'] });
  }, [client, run.id, run.status]);
  const [answer, setAnswer] = useState('');
  const answerId = useId();
  const action = useMutation({
    mutationFn: ({ cancel, requestId }: { cancel: boolean; requestId: string | null }) =>
      request(`/applications/${run.id}/${cancel ? 'cancel' : 'respond'}`, {
        method: 'POST',
        body: cancel ? {} : { requestId, answer: answer.trim() || 'Approved', approved: true },
      }),
    onSuccess: async () => {
      setAnswer('');
      await client.invalidateQueries({ queryKey: ['applications'] });
      await client.invalidateQueries({ queryKey: ['leads'] });
    },
  });
  const active = isApplicationActive(run);
  const waiting = run.status === 'needs_input' || run.status === 'ready';
  const approval = run.status === 'ready' || !!run.question?.startsWith('Approve');
  return (
    <section className="mt-4 min-w-0 space-y-3" aria-label="Application progress">
      <p role="status" className="text-sm font-semibold text-ink">
        {run.outcomeUnknown ? 'Submission outcome unknown' : applicationLabels[run.status]}
      </p>
      {run.outcomeUnknown ? (
        <Alert tone="warn" title="Check the employer portal">
          The employer may have received this application. Verify its status before retrying to
          avoid a duplicate submission.
        </Alert>
      ) : null}
      {run.currentUrl ? (
        <ExternalLink href={run.currentUrl} className="block break-all text-xs">
          {run.currentUrl}
        </ExternalLink>
      ) : null}
      {waiting ? (
        <div className="space-y-3 border-l-2 border-accent pl-3">
          <p className="whitespace-pre-wrap break-words text-sm text-ink">{run.question}</p>
          {!approval ? (
            <Field label="Reply (no passwords or verification codes)" htmlFor={answerId}>
              <Textarea
                id={answerId}
                value={answer}
                maxLength={10000}
                onChange={(event) => setAnswer(event.target.value)}
              />
            </Field>
          ) : null}
          <Button
            variant="primary"
            disabled={action.isPending || !run.requestId || (!approval && !answer.trim())}
            onClick={() => action.mutate({ cancel: false, requestId: run.requestId })}
          >
            {run.status === 'ready' ? (
              <Send size={16} aria-hidden="true" />
            ) : (
              <Check size={16} aria-hidden="true" />
            )}
            {run.status === 'ready'
              ? 'Approve submission'
              : approval
                ? 'Approve action'
                : 'Send reply'}
          </Button>
        </div>
      ) : null}
      {run.confirmation ? (
        <Alert tone="good" title="Employer confirmation">
          {run.confirmation}
        </Alert>
      ) : null}
      <ol
        className="max-h-56 space-y-2 overflow-y-auto text-xs text-muted"
        aria-label="Application events"
      >
        {run.events.map((event, index) => (
          <li key={`${event.at}-${index}`} className="flex items-start gap-3">
            <time className="shrink-0 tabular-nums" dateTime={event.at}>
              {new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
            <span className="min-w-0 break-words">{event.message}</span>
          </li>
        ))}
      </ol>
      {active ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={action.isPending}
          onClick={() => action.mutate({ cancel: true, requestId: null })}
        >
          <Square size={14} aria-hidden="true" />{' '}
          {run.status === 'submitting' ? 'Stop (outcome may be unknown)' : 'Cancel application'}
        </Button>
      ) : null}
      {action.error ? (
        <p role="alert" className="text-sm text-bad">
          {action.error.message}
        </p>
      ) : null}
    </section>
  );
}
