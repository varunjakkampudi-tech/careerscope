import { useId, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { request } from '../lib/api';
import { clearApiKey } from '../lib/auth';
import { sessionQuery, useSession } from '../lib/session';
import { Alert, Button, Field, Input } from '../components/ui';
import { APP_NAME } from '../lib/brand';
import { Brand } from '../components/Brand';

export function Login() {
  const session = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const emailId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [visible, setVisible] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const setup = session.data?.configured === false;
  const login = useMutation({
    mutationFn: () =>
      request(setup ? '/auth/setup' : '/auth/login', {
        method: 'POST',
        body: { email: email.trim(), password },
      }),
    onSuccess: async () => {
      setPassword('');
      setConfirmation('');
      clearApiKey();
      await client.cancelQueries();
      client.clear();
      await client.fetchQuery(sessionQuery);
      navigate('/leads', { replace: true });
    },
    onError: () => {
      setPassword('');
      setConfirmation('');
    },
  });
  if (session.data && (!session.data.enabled || session.data.authenticated))
    return <Navigate to="/leads" replace />;
  return (
    <main className="flex min-h-dvh flex-col bg-canvas px-5 py-8 text-ink">
      <Brand />
      <Link to="/jobs" className="mt-4 w-fit text-sm text-accent hover:underline">
        Public jobs
      </Link>
      <section className="mx-auto my-auto w-full max-w-sm py-12" aria-labelledby="login-title">
        <LockKeyhole size={28} className="mb-5 text-accent" aria-hidden="true" />
        <h1 id="login-title" className="text-2xl font-semibold">
          {setup ? 'Create your account' : 'Sign in'}
        </h1>
        <p className="mt-2 mb-7 text-sm text-muted">
          {setup ? `Set up the owner account for ${APP_NAME}.` : `Welcome back to ${APP_NAME}.`}
        </p>
        {session.isPending ? (
          <p role="status">Checking account...</p>
        ) : session.error ? (
          <Alert tone="bad" title="Unable to connect">
            {session.error.message}
            <Button className="mt-3" onClick={() => void session.refetch()}>
              Try again
            </Button>
          </Alert>
        ) : setup && !session.data?.canSetup ? (
          <Alert tone="warn" title="Local setup required">
            Open {APP_NAME} on the API machine to create the owner account before deploying.
          </Alert>
        ) : (
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              setFormError(null);
              if (setup && password !== confirmation) {
                setFormError('Passwords do not match.');
                return;
              }
              login.mutate();
            }}
          >
            <Field label="Email" htmlFor={emailId} required>
              <Input
                id={emailId}
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field
              label="Password"
              htmlFor={passwordId}
              hint={setup ? 'At least 12 characters.' : undefined}
              required
            >
              <div className="relative">
                <Input
                  id={passwordId}
                  name="password"
                  className="pr-12"
                  type={visible ? 'text' : 'password'}
                  autoComplete={setup ? 'new-password' : 'current-password'}
                  required
                  minLength={setup ? 12 : 1}
                  maxLength={256}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  className="absolute top-0 right-0 flex h-10 w-10 items-center justify-center text-muted"
                  aria-label={visible ? 'Hide password' : 'Show password'}
                  title={visible ? 'Hide password' : 'Show password'}
                  aria-pressed={visible}
                  onClick={() => setVisible((value) => !value)}
                >
                  {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </Field>
            {setup ? (
              <Field label="Confirm password" htmlFor={confirmId} required>
                <Input
                  id={confirmId}
                  name="confirmation"
                  type="password"
                  autoComplete="new-password"
                  required
                  maxLength={256}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </Field>
            ) : null}
            {formError || login.error ? (
              <p role="alert" className="text-sm text-bad">
                {formError ?? login.error?.message}
              </p>
            ) : null}
            <Button type="submit" variant="primary" className="w-full" loading={login.isPending}>
              {setup ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}
