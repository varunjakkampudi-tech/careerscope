'use client';

import { useState, type FormEvent } from 'react';
import { ArrowLeft, KeyRound, LoaderCircle, LogOut } from 'lucide-react';
import { api } from '../lib/api';
import { ErrorState } from './ui-states';

export default function AccountSecurity({
  csrf,
  onChanged,
  onBack,
}: {
  csrf: string;
  onChanged: () => void;
  onBack: () => void;
}) {
  const [pending, setPending] = useState(false);
  // CS-13 re-review: this component makes two real network calls but imports
  // no react-query hook, so the F-4 census — which proxied "async-bearing" as
  // "imports useQuery/useMutation/useInfiniteQuery" — excluded it by the
  // stated rule while it was async-bearing in substance. The proxy and the
  // property came apart here, and exactly here.
  //
  // `error` carries two different kinds of thing: CLIENT VALIDATION, which is
  // correctly out of scope for the page-level state contract, and the API
  // failure from the `catch` below, which is not. They are distinguished by
  // whether `what` is present rather than by a separate state, because both
  // render into the one element that `aria-describedby` points at and two
  // states could both be set.
  const [error, setError] = useState<{ what?: string; detail: string } | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [notice, setNotice] = useState('');
  const busy = pending || revoking;

  async function revokeOthers() {
    if (busy || !window.confirm('Sign out all other sessions? This session will stay signed in.'))
      return;
    setSessionError('');
    setNotice('');
    setRevoking(true);
    try {
      await api('/account/sessions/revoke-others', {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({}),
      });
      setNotice('Other sessions signed out. This session remains signed in.');
    } catch (failure) {
      // The fallback no longer repeats the operation name — `what` carries it.
      setSessionError(failure instanceof Error ? failure.message : 'Please try again.');
    } finally {
      setRevoking(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get('currentPassword'));
    const newPassword = String(data.get('newPassword'));
    setError(null);
    if (newPassword !== data.get('confirmation')) {
      // Client validation: deliberately left as a bare detail. It is a
      // field-level message, not a page-level error state, and it already
      // names its own problem.
      setError({ detail: 'Passwords do not match.' });
      form.querySelector<HTMLInputElement>('[name="confirmation"]')?.focus();
      return;
    }
    if (currentPassword === newPassword) {
      setError({ detail: 'Choose a different password.' });
      return;
    }
    if (!window.confirm('Change password and sign out all sessions?')) return;
    setPending(true);
    try {
      await api('/account/password', {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      onChanged();
    } catch (failure) {
      // The API failure, unlike the validation branches above, is a real
      // operation failing and must name what failed.
      setError({
        what: 'Could not change your password.',
        detail: failure instanceof Error ? failure.message : 'Please try again.',
      });
    } finally {
      form.reset();
      setPending(false);
    }
  }

  return (
    <section className="login" aria-labelledby="security-heading">
      <button type="button" onClick={onBack} disabled={busy}>
        <ArrowLeft size={18} aria-hidden="true" />
        Back to search
      </button>
      <h1 id="security-heading">Account security</h1>
      <button type="button" onClick={revokeOthers} disabled={busy}>
        {revoking ? (
          <LoaderCircle className="spin" size={18} aria-hidden="true" />
        ) : (
          <LogOut size={18} aria-hidden="true" />
        )}
        {revoking ? 'Signing out other sessions' : 'Sign out other sessions'}
      </button>
      {sessionError && (
        <ErrorState
          variant="inline"
          what="Could not sign out other sessions."
          detail={sessionError}
        />
      )}
      {notice && <p role="status">{notice}</p>}
      <form onSubmit={submit} aria-busy={pending}>
        <label>
          Current password
          <input
            name="currentPassword"
            aria-describedby={error ? 'security-error' : undefined}
            type="password"
            autoComplete="current-password"
            required
            minLength={12}
            maxLength={256}
            disabled={busy}
          />
        </label>
        <label>
          New password
          <input
            name="newPassword"
            aria-describedby={error ? 'security-error' : undefined}
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={256}
            disabled={busy}
          />
        </label>
        <label>
          Confirm new password
          <input
            name="confirmation"
            aria-describedby={error ? 'security-error' : undefined}
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={256}
            disabled={busy}
          />
        </label>
        {error &&
          (error.what ? (
            <ErrorState
              variant="inline"
              id="security-error"
              what={error.what}
              detail={error.detail}
            />
          ) : (
            <p id="security-error" role="alert">
              {error.detail}
            </p>
          ))}
        <button className="primary" disabled={busy}>
          {pending ? (
            <LoaderCircle className="spin" size={18} aria-hidden="true" />
          ) : (
            <KeyRound size={18} aria-hidden="true" />
          )}
          {pending ? 'Changing password' : 'Change password'}
        </button>
      </form>
    </section>
  );
}
