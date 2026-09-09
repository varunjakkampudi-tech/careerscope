import { useMutation, useQueryClient } from '@tanstack/react-query';
import { NavLink, useNavigate } from 'react-router-dom';
import { LogOut, UserRound } from 'lucide-react';
import { request } from '../lib/api';
import { clearApiKey } from '../lib/auth';
import { useSession } from '../lib/session';
import { Button, buttonClass } from './ui';

export function AccountControls() {
  const session = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => request('/auth/logout', { method: 'POST', body: {} }),
    onSuccess: async () => {
      clearApiKey();
      await client.cancelQueries();
      client.clear();
      navigate('/login', { replace: true });
    },
  });
  return (
    <div className="relative flex shrink-0 items-center gap-1">
      <NavLink
        to="/profile"
        className={({ isActive }) =>
          buttonClass(
            'ghost',
            'sm',
            `size-10 min-h-10 min-w-10 p-0 ${isActive ? 'bg-accent-soft text-accent' : ''}`,
          )
        }
        aria-label="Profile"
        title={session.data?.email ? `Your profile (${session.data.email})` : 'Your profile'}
      >
        <UserRound size={18} aria-hidden="true" />
      </NavLink>
      {session.data?.authenticated ? (
        <Button
          variant="ghost"
          size="sm"
          className="size-10 min-h-10 min-w-10 p-0"
          aria-label="Sign out"
          title="Sign out"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
        >
          <LogOut size={17} aria-hidden="true" />
        </Button>
      ) : null}
      {logout.error ? (
        <span
          role="alert"
          className="absolute top-full right-0 mt-2 w-52 rounded-lg border border-border bg-surface p-3 text-xs text-bad shadow-lg"
        >
          Could not sign out. Try again.
        </span>
      ) : null}
    </div>
  );
}
