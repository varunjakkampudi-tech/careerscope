/**
 * Routes.
 *
 * `basename` comes from `import.meta.env.BASE_URL`, which Vite sets from the
 * `base` option: `/` for the EC2 single-origin build, `/<repo>/` for GitHub
 * Pages. Without it every link on the Pages deploy would point at the domain
 * root and 404.
 *
 * Pages needs one more thing, which lives in the workflow rather than here: a
 * copy of `index.html` as `404.html`. A cold visit to `/<repo>/leads` has no
 * file behind it, so Pages serves the 404 document — which, being this app,
 * boots and routes to `/leads` correctly.
 */

import { lazy, Suspense } from 'react';
import { Link, Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { Button, buttonClass, EmptyState, Spinner } from './components/ui';
import { ApiError } from './lib/api';
import { useProfileStatus } from './lib/queries';
import { RequireLogin } from './components/RequireLogin';
import { RouteLoading } from './components/RouteLoading';
import { PageMetadata } from './components/PageMetadata';

const Leads = lazy(() => import('./routes/Leads').then((module) => ({ default: module.Leads })));
const Onboarding = lazy(() =>
  import('./routes/Onboarding').then((module) => ({ default: module.Onboarding })),
);
const Search = lazy(() => import('./routes/Search').then((module) => ({ default: module.Search })));
const Settings = lazy(() =>
  import('./routes/Settings').then((module) => ({ default: module.Settings })),
);
const Applications = lazy(() =>
  import('./routes/Applications').then((module) => ({ default: module.Applications })),
);
const Login = lazy(() => import('./routes/Login').then((module) => ({ default: module.Login })));

export default function App() {
  return (
    <Router basename={import.meta.env.BASE_URL}>
      <PageMetadata />
      <ErrorBoundary>
        <Routes>
          <Route
            path="login"
            element={
              <Suspense fallback={<RouteLoading />}>
                <Login />
              </Suspense>
            }
          />
          <Route element={<RequireLogin />}>
            <Route element={<Layout />}>
              <Route index element={<Landing />} />
              <Route path="onboarding" element={<Onboarding />} />
              <Route path="profile" element={<Onboarding />} />
              <Route path="search" element={<Search />} />
              <Route path="leads" element={<Leads />} />
              <Route path="settings" element={<Settings />} />
              <Route path="applications" element={<Applications />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Route>
        </Routes>
      </ErrorBoundary>
    </Router>
  );
}

/**
 * Where `/` goes.
 *
 * `GET /api/profile/status` exists precisely for this decision — it answers
 * "has this been set up" with a 200 either way, so the first-run path is a
 * normal response rather than a 404 the client has to treat as success.
 */
function Landing() {
  const status = useProfileStatus();

  if (status.isPending) {
    return (
      <div className="flex justify-center py-24 text-muted">
        <Spinner size={22} />
      </div>
    );
  }

  if (status.isError) {
    const authFailure = status.error instanceof ApiError && status.error.isAuthFailure;
    // An auth failure already raises the shell's banner, which links to
    // settings; sending the user there directly saves a click.
    if (authFailure) return <Navigate to="/settings" replace />;

    return (
      <EmptyState
        title="Could not reach the API"
        description={status.error.message}
        action={
          <Button variant="primary" onClick={() => void status.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  return <Navigate to={status.data.exists ? '/leads' : '/onboarding'} replace />;
}

function NotFound() {
  return (
    <EmptyState
      title="Page not found"
      description="That URL does not match any screen in the app."
      action={
        <Link to="/leads" className={buttonClass('primary')}>
          Go to leads
        </Link>
      }
    />
  );
}
