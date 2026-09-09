import { beforeEach, expect, it, vi } from 'vitest';
import { Login } from './Login';
import { renderApp, screen, userEvent } from '../test/utils';
import { request } from '../lib/api';

const state = vi.hoisted(() => ({ configured: true }));
vi.mock('../lib/session', () => ({
  useSession: () => ({
    data: { enabled: true, authenticated: false, configured: state.configured, canSetup: true },
    isPending: false,
  }),
  sessionQuery: {},
}));
vi.mock('../lib/api', () => ({
  request: vi.fn().mockRejectedValue(new Error('Invalid email or password.')),
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.configured = true;
});

it('masks passwords and shows login errors', async () => {
  renderApp(<Login />);
  expect(screen.getByLabelText(/^Password/)).toHaveAttribute('type', 'password');
  await userEvent.type(screen.getByLabelText(/Email/), 'test@example.com');
  await userEvent.type(screen.getByLabelText(/^Password/), 'synthetic password');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
  expect(request).toHaveBeenCalledWith('/auth/login', {
    method: 'POST',
    body: { email: 'test@example.com', password: 'synthetic password' },
  });
  expect(screen.getByLabelText(/^Password/)).toHaveValue('');
});

it('requires matching passwords for local first-time setup', async () => {
  state.configured = false;
  renderApp(<Login />);
  await userEvent.type(screen.getByLabelText(/Email/), 'test@example.com');
  await userEvent.type(screen.getByLabelText(/^Password/), 'synthetic password');
  await userEvent.type(screen.getByLabelText(/^Confirm password/), 'different password');
  await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Passwords do not match.');
  expect(request).not.toHaveBeenCalled();
});
