import { expect, it, vi } from 'vitest';
import { AccountControls } from './AccountControls';
import { RequireLogin } from './RequireLogin';
import { Routes, Route } from 'react-router-dom';
import { renderApp, screen, userEvent } from '../test/utils';
import { request } from '../lib/api';

const state = vi.hoisted(() => ({ authenticated: true }));
vi.mock('../lib/session', () => ({
  useSession: () => ({
    data: { enabled: true, authenticated: state.authenticated, email: 'owner@example.com' },
    isPending: false,
  }),
}));
vi.mock('../lib/api', () => ({ request: vi.fn().mockResolvedValue({ authenticated: false }) }));

it('links the profile icon to the profile and clears private cache on logout', async () => {
  state.authenticated = true;
  const { queryClient } = renderApp(<AccountControls />);
  queryClient.setQueryData(['private-fixture'], { secret: 'synthetic data' });
  expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/profile');
  await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(request).toHaveBeenCalledWith('/auth/logout', { method: 'POST', body: {} });
  expect(queryClient.getQueryData(['private-fixture'])).toBeUndefined();
});

it('redirects anonymous visitors before rendering private content', () => {
  state.authenticated = false;
  renderApp(
    <Routes>
      <Route path="/login" element={<p>Login screen</p>} />
      <Route element={<RequireLogin />}>
        <Route path="/" element={<p>Private profile</p>} />
      </Route>
    </Routes>,
  );
  expect(screen.getByText('Login screen')).toBeInTheDocument();
  expect(screen.queryByText('Private profile')).not.toBeInTheDocument();
});
