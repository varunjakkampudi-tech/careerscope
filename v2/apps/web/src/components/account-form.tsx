'use client';

import { useState, type FormEvent } from 'react';
import { LoaderCircle, LogIn, UserPlus } from 'lucide-react';
import { api } from '../lib/api';

export default function AccountForm({
  registrationEnabled,
  expired,
  notice = '',
  onAuthenticated,
}: {
  registrationEnabled: boolean;
  expired: boolean;
  notice?: string;
  onAuthenticated: () => void;
}) {
  const [registering, setRegistering] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get('password'));
    setError('');
    setMessage('');
    if (registering && password !== data.get('confirmation')) {
      setError('Passwords do not match.');
      form.querySelector<HTMLInputElement>('[name="confirmation"]')?.focus();
      return;
    }
    setPending(true);
    try {
      await api(registering ? '/register' : '/login', {
        method: 'POST',
        body: JSON.stringify({ email: String(data.get('email')), password }),
      });
      form.reset();
      if (registering) {
        setRegistering(false);
        setMessage('You can now try signing in with your credentials.');
        form.querySelector<HTMLInputElement>('[name="email"]')?.focus();
      } else {
        onAuthenticated();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Request failed. Please try again.');
      for (const name of ['password', 'confirmation']) {
        const input = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
        if (input) input.value = '';
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="login" aria-labelledby="account-heading">
      <h1 id="account-heading">{registering ? 'Create account' : 'Sign in'}</h1>
      <form onSubmit={submit} aria-busy={pending}>
        <label>
          Email
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            maxLength={254}
            disabled={pending}
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete={registering ? 'new-password' : 'current-password'}
            required
            minLength={12}
            maxLength={256}
            disabled={pending}
          />
        </label>
        {registering && (
          <label>
            Confirm password
            <input
              name="confirmation"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={256}
              disabled={pending}
            />
          </label>
        )}
        {(error || (expired && !registering)) && (
          <p role="alert">{error || 'Your session has expired.'}</p>
        )}
        {(message || (!registering && notice)) && <p role="status">{message || notice}</p>}
        <button className="primary" disabled={pending}>
          {pending ? (
            <LoaderCircle className="spin" size={18} aria-hidden="true" />
          ) : registering ? (
            <UserPlus size={18} aria-hidden="true" />
          ) : (
            <LogIn size={18} aria-hidden="true" />
          )}
          {registering ? 'Create account' : 'Sign in'}
        </button>
        {registrationEnabled && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setRegistering(!registering);
              setError('');
              setMessage('');
            }}
          >
            {registering ? 'Back to sign in' : 'Create an account'}
          </button>
        )}
      </form>
    </section>
  );
}
