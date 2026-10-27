'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell,
  Bookmark,
  ClipboardCheck,
  ClipboardList,
  FileText,
  LayoutDashboard,
  Library,
  LogOut,
  Moon,
  Mountain,
  Search,
  Settings,
  Sparkles,
  Sun,
  TrendingUp,
} from 'lucide-react';
import BrandLogo from './brand-logo';
import { api } from '@/lib/api';
import { localizedText, useInterfaceLocale } from '@/lib/locale';
import styles from './dashboard-shell.module.css';

type NotificationItem = {
  id: string;
  leadId: string;
  createdAt: string;
  readAt: string | null;
};

function NotificationCenter() {
  const locale = useInterfaceLocale();
  const t = (key: Parameters<typeof localizedText>[1], count?: number) =>
    localizedText(locale, key, count);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // A failed mark-as-read is about one item, so it must not reuse the list
  // load flag above and hide every reminder.
  const [markError, setMarkError] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const mounted = useRef(false);
  const activeLoad = useRef<{
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);

  const loadNotifications = useCallback(async (showLoading = false, refreshAfterActive = false) => {
    if (!mounted.current) return;
    // Focus, visibility, the polling timer, and opening the panel may all ask
    // for the same read at once. Keep one request for this mounted shell so
    // an older navigation's background request cannot accumulate beside a
    // newer refresh.
    const current = activeLoad.current;
    if (current) {
      if (!refreshAfterActive) return current.promise;
      await current.promise;
      if (!mounted.current) return;

      // A lifecycle signal may have started a newer request while the caller
      // waited. That request began after the mutation and is therefore the
      // refresh this caller needs; share it instead of issuing a duplicate.
      const newer = activeLoad.current;
      if (newer) return newer.promise;
    }

    const controller = new AbortController();
    if (showLoading) setLoading(true);
    const active = { controller, promise: Promise.resolve() };
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await api<{ items: NotificationItem[]; unreadCount: number }>(
          '/notifications',
          { signal: controller.signal },
        );
        setError(false);
        setItems(result.items);
        setUnreadCount(result.unreadCount);
        setLoaded(true);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (activeLoad.current === active) activeLoad.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    });
    active.promise = promise;
    activeLoad.current = active;
    return promise;
  }, []);

  useEffect(() => {
    mounted.current = true;
    const initialLoad = window.setTimeout(() => void loadNotifications(), 0);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void loadNotifications();
    };
    const refreshInterval = window.setInterval(refreshWhenVisible, 30_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      mounted.current = false;
      window.clearTimeout(initialLoad);
      window.clearInterval(refreshInterval);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      activeLoad.current?.controller.abort();
      activeLoad.current = null;
    };
  }, [loadNotifications]);

  async function markRead(id: string) {
    setMarkError(null);
    try {
      await api(`/notifications/${id}/read`, { method: 'PUT' });
      if (mounted.current) await loadNotifications(false, true);
    } catch {
      if (mounted.current) setMarkError(id);
    }
  }

  return (
    <details
      className={styles.notificationControl}
      lang={locale}
      onToggle={(event) => {
        if (event.currentTarget.open) void loadNotifications();
      }}
    >
      <summary
        className={styles.iconButton}
        aria-label={unreadCount ? t('unreadNotifications', unreadCount) : t('notifications')}
        title={t('notifications')}
      >
        <Bell size={17} aria-hidden="true" />
        {unreadCount > 0 && <span className={styles.notificationCount}>{unreadCount}</span>}
      </summary>
      <section className={styles.notificationPanel} aria-label={t('notifications')} lang={locale}>
        <h2>{t('notifications')}</h2>
        <p className={styles.notificationPrivacy}>{t('reminderPrivacy')}</p>
        <div aria-live="polite" aria-busy={loading}>
          {loading && <p role="status">{t('loadingNotifications')}</p>}
          {!loading && error && (
            <div role="alert">
              <p>{t('notificationsError')}</p>
              <button type="button" onClick={() => void loadNotifications(true)}>
                {t('retry')}
              </button>
            </div>
          )}
          {!loading && !error && loaded && items.length === 0 && <p>{t('noReminders')}</p>}
          {!loading && !error && items.length > 0 && (
            <ul className={styles.notificationList}>
              {items.map((item) => (
                <li key={item.id} data-read={item.readAt !== null}>
                  <span>{t('upcomingInterview')}</span>
                  <time dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleString(locale)}
                  </time>
                  <div>
                    <Link href={`/saved?lead=${encodeURIComponent(item.leadId)}`} prefetch={false}>
                      {t('openApplication')}
                    </Link>
                    {item.readAt === null && (
                      <button type="button" onClick={() => void markRead(item.id)}>
                        {t('markRead')}
                      </button>
                    )}
                  </div>
                  {markError === item.id && <p role="alert">{t('pleaseTryAgain')}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </details>
  );
}

// Every entry here was seen consistently across the approved design handoff
// under design/, in this order, plus "Preparation" (real existing
// functionality with no design mockup and no exact match to any design nav
// label — added as its own honestly-labelled item rather than folded into
// "Skills", which is a distinct, still-unbuilt concept). `href: null` marks a
// nav item the design shows but that has no real destination in CareerScope
// today — rendered disabled with a "Not yet available" tag rather than as a
// dead or fake-functional link. Every other entry is now a real, dedicated
// Next.js route (CS-6) rather than a `?view=` deep-link into one shared page
// — a label must reach the screen it names. See
// docs/FRONTEND-ADMIN-ROADMAP.md for the full per-item disposition.
// "Preparation" is placed last, after every item the design mockups show,
// rather than inserted in the middle — inserting it earlier would shift
// every item below it down by one row and out of the position the design
// puts it at, for a page the design never depicted in the first place.
const navItems = [
  { key: 'dashboard', message: 'dashboard', icon: LayoutDashboard, href: '/dashboard' },
  { key: 'jobs', message: 'jobs', icon: Search, href: '/jobs' },
  { key: 'applications', message: 'applications', icon: ClipboardList, href: '/applications' },
  { key: 'saved', message: 'saved', icon: Bookmark, href: '/saved' },
  { key: 'resume', message: 'resume', icon: FileText, href: '/resume' },
  { key: 'skills', message: 'skills', icon: TrendingUp, href: null },
  { key: 'insights', message: 'insights', icon: TrendingUp, href: null },
  { key: 'ai-assistant', message: 'aiAssistant', icon: Sparkles, href: null },
  { key: 'career-resources', message: 'careerResources', icon: Library, href: '/career-resources' },
  { key: 'settings', message: 'settings', icon: Settings, href: '/settings' },
  { key: 'preparation', message: 'preparation', icon: ClipboardCheck, href: '/preparation' },
] as const;
export type NavKey = (typeof navItems)[number]['key'];

// Derives the active sidebar item straight from the URL — the single place
// that mapping lives, rather than each page passing its own `active` literal
// (which drifts the moment a route is renamed and nothing catches it).
export function navKeyForPath(pathname: string): NavKey {
  const match = navItems.find((item) => item.href === pathname);
  return match?.key ?? 'dashboard';
}

// A real initials avatar derived from the signed-in owner's own verified contact
// (never a fabricated photo/portrait of anyone) — ChatGPT-reviewed choice,
// 2026-09-23, for the avatar position both the sidebar footer and topbar
// show in the owner-supplied design. Falls back to a generic mark when the
// identity genuinely isn't available yet (still loading, or none returned).
function initialsFrom(identity: string | undefined) {
  if (!identity) return '·';
  const local = identity.split('@')[0] ?? identity;
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : local.slice(0, 2);
  return letters.toUpperCase();
}

function InitialsAvatar({ identity }: { identity: string | undefined }) {
  return (
    <span className={styles.avatar} aria-hidden="true" title={identity ?? 'Signed in'}>
      {initialsFrom(identity)}
    </span>
  );
}

export function DashboardSidebar({
  active,
  identity,
}: {
  active: (typeof navItems)[number]['key'];
  identity?: string;
}) {
  const locale = useInterfaceLocale();
  const t = (key: Parameters<typeof localizedText>[1]) => localizedText(locale, key);
  return (
    <nav className={styles.sidebar} aria-label="CareerScope" lang="en">
      <div className={styles.brandRow}>
        <BrandLogo compact />
        <div>
          <div className={styles.brandTagline} lang={locale}>
            {t('brandTagline')}
          </div>
        </div>
      </div>
      <div className={styles.nav} lang={locale}>
        {navItems.map(({ key, message, icon: Icon, href }) =>
          href ? (
            <Link
              key={key}
              href={href}
              prefetch={false}
              tabIndex={0}
              className={styles.navItem}
              aria-current={key === active ? 'page' : undefined}
            >
              <Icon size={16} aria-hidden="true" />
              {t(message)}
            </Link>
          ) : (
            <span
              key={key}
              className={styles.navItemDisabled}
              aria-disabled="true"
              title={t('unavailable')}
            >
              <Icon size={16} aria-hidden="true" />
              {t(message)}
              <span className={styles.navSoon}>{t('soon')}</span>
            </span>
          ),
        )}
      </div>
      {/* Purely decorative motivational copy — not a data claim, so it stays
          even though CareerScope has no billing/plan concept to attach it to
          (the design's "Upgrade Plan" button is deliberately not reproduced;
          single-owner apps have nothing to upgrade to). */}
      <div className={styles.sidebarIllustration} lang={locale}>
        <Mountain size={28} aria-hidden="true" />
        <strong>{t('motivationTitle')}</strong>
        <p>{t('motivationBody')}</p>
      </div>
      <div className={styles.sidebarAccount} lang={locale}>
        <InitialsAvatar identity={identity} />
        <div>
          <div className={styles.sidebarAccountEmail}>{identity ?? t('signedIn')}</div>
          <div className={styles.sidebarFooter} lang={locale}>
            {t('privateWorkspace')}
          </div>
        </div>
      </div>
    </nav>
  );
}

// Below 768px the sidebar is hidden entirely (design shows a bottom tab bar
// on its mobile variants, but only for the 4-5 items each specific screen
// chose to surface there — there is no single mobile nav mockup covering
// every sidebar item). This strip reuses the exact same nav data instead of
// inventing a distinct mobile taxonomy, so every item the desktop sidebar
// can reach, the mobile view can reach too — never fewer capabilities on
// the narrower viewport.
export function DashboardMobileNav({ active }: { active: (typeof navItems)[number]['key'] }) {
  const locale = useInterfaceLocale();
  const t = (key: Parameters<typeof localizedText>[1]) => localizedText(locale, key);
  return (
    <div className={styles.mobileNavFade}>
      <nav className={styles.mobileNav} aria-label="CareerScope, compact" lang="en">
        {navItems.map(({ key, message, icon: Icon, href }) =>
          href ? (
            <Link
              key={key}
              href={href}
              prefetch={false}
              className={styles.mobileNavItem}
              lang={locale}
              aria-current={key === active ? 'page' : undefined}
            >
              <Icon size={14} aria-hidden="true" />
              {t(message)}
            </Link>
          ) : (
            <span
              key={key}
              className={styles.mobileNavItemDisabled}
              aria-disabled="true"
              lang={locale}
              title={t('unavailable')}
            >
              <Icon size={14} aria-hidden="true" />
              {t(message)}
            </span>
          ),
        )}
      </nav>
    </div>
  );
}

export function DashboardTopbar({
  theme,
  onToggleTheme,
  identity,
  onSignOut,
  signOutPending,
}: {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  identity?: string;
  onSignOut: () => void;
  signOutPending: boolean;
}) {
  const locale = useInterfaceLocale();
  const t = (key: Parameters<typeof localizedText>[1]) => localizedText(locale, key);
  return (
    <header className={styles.topbar} lang={locale}>
      {/* Links into the real, existing search workspace rather than an
          instant-search box with nothing behind it: CareerScope has no
          cross-entity search endpoint today, so a functional-looking
          search field here would be a UI element that does nothing. */}
      <Link href="/jobs" prefetch={false} className={styles.topbarSearch} lang={locale}>
        <Search size={15} aria-hidden="true" />
        <span>{t('searchJobs')}</span>
      </Link>
      <div className={styles.topbarActions}>
        <button
          type="button"
          className={styles.iconButton}
          lang={locale}
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? t('switchLight') : t('switchDark')}
          title={theme === 'dark' ? t('switchLight') : t('switchDark')}
        >
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button
          type="button"
          className={styles.iconButton}
          lang={locale}
          onClick={onSignOut}
          disabled={signOutPending}
          aria-label={t('signOut')}
          title={t('signOut')}
        >
          <LogOut size={17} />
        </button>
        <NotificationCenter key={identity ?? 'signed-in'} />
        <InitialsAvatar identity={identity} />
      </div>
    </header>
  );
}
