import { Navigate, Outlet } from 'react-router-dom';
import { useSession } from '../lib/session';
import { Alert, Button } from './ui';

export function RequireLogin() {
  const session = useSession();
  if (session.isPending)
    return (
      <p role="status" className="p-8 text-center text-sm text-muted">
        Checking your session...
      </p>
    );
  if (session.error)
    return (
      <div className="mx-auto max-w-md p-6">
        <Alert tone="bad" title="Could not check your session">
          {session.error.message}
        </Alert>
        <Button className="mt-4" onClick={() => void session.refetch()}>
          Try again
        </Button>
      </div>
    );
  if (session.data.enabled && !session.data.authenticated) return <Navigate to="/login" replace />;
  return <Outlet />;
}
