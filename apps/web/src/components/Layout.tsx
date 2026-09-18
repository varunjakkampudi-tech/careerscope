/**
 * The application shell: header, navigation, and the two pieces of global state
 * that have to be visible from every screen — whether the API key works, and
 * whether a search is currently running.
 *
 * The running-search indicator is the important one. A run takes minutes, and
 * without a persistent signal the only way to know one is in flight is to be
 * sitting on the search screen watching it. Here it is visible from the leads
 * table, from settings, from anywhere.
 */

import { Suspense, useSyncExternalStore } from 'react';
import { ArrowUp, Monitor, Moon, Settings2, Sun } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { isAuthRejected, subscribeToAuthFailure } from '../lib/auth';
import { useActiveRun, useLeadCounts } from '../lib/queries';
import {
  getResolvedTheme,
  getThemeChoice,
  setThemeChoice,
  subscribeToTheme,
  type ThemeChoice,
} from '../lib/theme';
import { Alert, Badge, Button, buttonClass, cx, Spinner } from './ui';
import { AccountControls } from './AccountControls';
import { useSession } from '../lib/session';
import { RouteLoading } from './RouteLoading';
import { APP_NAME, APP_VERSION } from '../lib/brand';
import { Brand } from './Brand';

export function Layout() {
  const session = useSession();
  const authRejected = useSyncExternalStore(subscribeToAuthFailure, isAuthRejected);
  const activeRun = useActiveRun();
  const counts = useLeadCounts();

  const running = activeRun.data;

  return (
    <div className="app-shell flex min-h-dvh flex-col bg-canvas">
      <a href="#main-content" className="skip-link" tabIndex={0}>
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-border bg-surface">
        <div className="shell-gutter mx-auto grid h-app-header w-full max-w-[1600px] grid-cols-[minmax(0,1fr)_auto] grid-rows-[3.5rem_3rem] items-center gap-x-3 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:grid-rows-1 lg:gap-x-8">
          <NavLink to="/" className="flex w-fit items-center gap-2.5" aria-label={APP_NAME}>
            <Brand />
          </NavLink>

          <nav
            className="col-span-2 row-start-2 flex min-w-0 items-center gap-1 overflow-x-auto lg:col-span-1 lg:col-start-2 lg:row-start-1"
            aria-label="Main"
          >
            <NavItem to="/search" label="Search" />
            <NavItem
              to="/leads"
              label="Leads"
              badge={counts.isPending ? 'pending' : counts.data?.total || undefined}
            />
            <NavItem to="/applications" label="Applications" />
            <NavItem to="/settings" label="Settings" />
            <NavItem to="/jobs" label="Public jobs" />
          </nav>

          <div className="col-start-2 row-start-1 flex items-center gap-1 lg:col-start-3">
            {running ? (
              <NavLink
                to="/search"
                className="mr-2 hidden h-9 items-center gap-1.5 rounded-md bg-accent-soft px-2 text-xs font-medium text-accent sm:flex"
                title={`${running.stage} — ${Math.round(running.progress * 100)}%`}
              >
                <Spinner size={12} />
                <span className="hidden sm:inline">Searching</span>
                <span className="tabular-nums">{Math.round(running.progress * 100)}%</span>
              </NavLink>
            ) : null}
            <ThemeToggle />
            <AccountControls />
          </div>
        </div>
      </header>

      {authRejected ? (
        <div className="mx-auto w-full max-w-[1600px] px-4 pt-4">
          <Alert
            tone="bad"
            title={session.data?.enabled ? 'Authentication required' : 'The API rejected your key'}
            action={
              <NavLink
                to={session.data?.enabled ? '/login' : '/settings'}
                className={buttonClass('primary', 'sm')}
              >
                {session.data?.enabled ? 'Sign in' : 'Open settings'}
              </NavLink>
            }
          >
            {session.data?.enabled
              ? 'Your request was refused. Check your session and try again.'
              : 'Requests are being refused. Check the key against APP_API_KEY on the server.'}
          </Alert>
        </div>
      ) : null}

      <main
        id="main-content"
        tabIndex={-1}
        className="shell-gutter mx-auto w-full min-w-0 max-w-[1600px] flex-1 py-6 focus-visible:outline-none"
      >
        <Suspense fallback={<RouteLoading />}>
          <Outlet />
        </Suspense>
      </main>
      <footer className="border-t border-border bg-surface">
        <div className="shell-gutter mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 text-xs text-muted">
          <span className="font-medium" translate="no">
            {APP_NAME} <span className="ml-2 font-normal tabular-nums">v{APP_VERSION}</span>
          </span>
          <div className="flex items-center gap-3">
            <NavLink
              to="/settings"
              className="inline-flex min-h-10 items-center gap-1.5 hover:text-ink"
            >
              <Settings2 size={14} aria-hidden="true" />
              Workspace settings
            </NavLink>
            <a
              href="#main-content"
              className="inline-flex size-10 items-center justify-center rounded-lg hover:bg-canvas hover:text-ink"
              aria-label="Back to top"
              title="Back to top"
            >
              <ArrowUp size={16} aria-hidden="true" />
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `badge` is a tri-state: omitted for an item that never carries a count,
 * `'pending'` while the count is still in flight, and the number once it lands.
 * The middle state is what keeps the nav still — see the comment on the pill.
 */
function NavItem({ to, label, badge }: { to: string; label: string; badge?: number | 'pending' }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx(
          'flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-sm font-medium transition-colors',
          isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-canvas hover:text-ink',
        )
      }
    >
      {label}
      {/* The count is its own query, so it resolves after the nav has painted —
          and a pill that appears late widens this link and shoves every item to
          its right. Measured, that was Settings jumping 43px on every load.

          `invisible` holds the box and paints nothing, which also takes it out of
          the accessibility tree so nothing announces an empty pill. The width is
          fixed on the inner span rather than the badge, because `min-w` there
          would be measured against the border box and under-reserve by the
          padding. Three tabular digits covers any realistic count; a fourth costs
          one character rather than the whole pill. */}
      {badge !== undefined ? (
        <Badge tone="neutral" className={cx('tabular-nums', badge === 'pending' && 'invisible')}>
          <span className="inline-block min-w-[3ch] text-center">
            {badge === 'pending' ? null : badge}
          </span>
        </Badge>
      ) : null}
    </NavLink>
  );
}

const THEME_ORDER: ThemeChoice[] = ['system', 'light', 'dark'];
const THEME_LABELS: Record<ThemeChoice, string> = {
  system: 'Match system',
  light: 'Light',
  dark: 'Dark',
};

/**
 * Cycles system → light → dark.
 *
 * A cycle rather than a two-state switch because "follow the system" is a real
 * choice a user can want back, and a binary toggle silently throws it away the
 * first time it is pressed.
 */
export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribeToTheme, getThemeChoice);
  const resolved = useSyncExternalStore(subscribeToTheme, getResolvedTheme);
  const next = THEME_ORDER[(THEME_ORDER.indexOf(choice) + 1) % THEME_ORDER.length] ?? 'system';

  return (
    <Button
      size="sm"
      variant="ghost"
      className="size-10 min-h-10 min-w-10 shrink-0 p-0"
      onClick={() => setThemeChoice(next)}
      title={`Theme: ${THEME_LABELS[choice]} — switch to ${THEME_LABELS[next].toLowerCase()}`}
      aria-label={`Theme: ${THEME_LABELS[choice]}`}
    >
      {choice === 'system' ? (
        <Monitor size={18} aria-hidden="true" />
      ) : resolved === 'dark' ? (
        <Moon size={18} aria-hidden="true" />
      ) : (
        <Sun size={18} aria-hidden="true" />
      )}
    </Button>
  );
}
