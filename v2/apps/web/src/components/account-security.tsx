'use client';

import { useState, type FormEvent } from 'react';
import { ArrowLeft, KeyRound, LoaderCircle, LogOut } from 'lucide-react';
import { api } from '../lib/api';

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
  const [error, setError] = useState('');
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
      setSessionError(failure instanceof Error ? failure.message : 'Session revocation failed.');
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
    setError('');
    if (newPassword !== data.get('confirmation')) {
      setError('Passwords do not match.');
      form.querySelector<HTMLInputElement>('[name="confirmation"]')?.focus();
      return;
    }
    if (currentPassword === newPassword) {
      setError('Choose a different password.');
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
      setError(failure instanceof Error ? failure.message : 'Password change failed.');
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
      {sessionError && <p role="alert">{sessionError}</p>}
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
        {error && (
          <p id="security-error" role="alert">
            {error}
          </p>
        )}
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
