'use client';

import Link from 'next/link';
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
import BrandMark from './brand-mark';
import styles from './dashboard-shell.module.css';

// Every entry here was seen consistently across the owner-supplied design
// images (page-designs/), in this order, plus "Preparation" (real existing
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
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, href: '/dashboard' },
  { key: 'jobs', label: 'Jobs', icon: Search, href: '/jobs' },
  { key: 'applications', label: 'Applications', icon: ClipboardList, href: '/applications' },
  { key: 'saved', label: 'Saved', icon: Bookmark, href: '/saved' },
  { key: 'resume', label: 'Resume', icon: FileText, href: '/resume' },
  { key: 'skills', label: 'Skills', icon: TrendingUp, href: null },
  { key: 'insights', label: 'Insights', icon: TrendingUp, href: null },
  { key: 'ai-assistant', label: 'AI Assistant', icon: Sparkles, href: null },
  { key: 'career-resources', label: 'Career Resources', icon: Library, href: '/career-resources' },
  { key: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
  { key: 'preparation', label: 'Preparation', icon: ClipboardCheck, href: '/preparation' },
] as const;
export type NavKey = (typeof navItems)[number]['key'];

// Derives the active sidebar item straight from the URL — the single place
// that mapping lives, rather than each page passing its own `active` literal
// (which drifts the moment a route is renamed and nothing catches it).
export function navKeyForPath(pathname: string): NavKey {
  const match = navItems.find((item) => item.href === pathname);
  return match?.key ?? 'dashboard';
}

// A real initials avatar derived from the signed-in owner's own email
// (never a fabricated photo/portrait of anyone) — ChatGPT-reviewed choice,
// 2026-09-23, for the avatar position both the sidebar footer and topbar
// show in the owner-supplied design. Falls back to a generic mark when the
// email genuinely isn't available yet (still loading, or none returned).
function initialsFrom(email: string | undefined) {
  if (!email) return '·';
  const local = email.split('@')[0] ?? email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : local.slice(0, 2);
  return letters.toUpperCase();
}

function InitialsAvatar({ email }: { email: string | undefined }) {
  return (
    <span className={styles.avatar} aria-hidden="true" title={email ?? 'Signed in'}>
      {initialsFrom(email)}
    </span>
  );
}

export function DashboardSidebar({
  active,
  email,
}: {
  active: (typeof navItems)[number]['key'];
  email?: string;
}) {
  return (
    <nav className={styles.sidebar} aria-label="CareerScope">
      <div className={styles.brandRow}>
        <BrandMark />
        <div>
          <div className={styles.brandName}>CareerScope</div>
          <div className={styles.brandTagline}>Discover · Prepare · Grow</div>
        </div>
      </div>
      <div className={styles.nav}>
        {navItems.map(({ key, label, icon: Icon, href }) =>
          href ? (
            <Link
              key={key}
              href={href}
              className={styles.navItem}
              aria-current={key === active ? 'page' : undefined}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </Link>
          ) : (
            <span
              key={key}
              className={styles.navItemDisabled}
              aria-disabled="true"
              title="Not yet available in CareerScope"
            >
              <Icon size={16} aria-hidden="true" />
              {label}
              <span className={styles.navSoon}>Soon</span>
            </span>
          ),
        )}
      </div>
      {/* Purely decorative motivational copy — not a data claim, so it stays
          even though CareerScope has no billing/plan concept to attach it to
          (the design's "Upgrade Plan" button is deliberately not reproduced;
          single-owner apps have nothing to upgrade to). */}
      <div className={styles.sidebarIllustration}>
        <Mountain size={28} aria-hidden="true" />
        <strong>Small Steps, Big Opportunities</strong>
        <p>Your next chapter is closer than you think.</p>
      </div>
      <div className={styles.sidebarAccount}>
        <InitialsAvatar email={email} />
        <div>
          <div className={styles.sidebarAccountEmail}>{email ?? 'Signed in'}</div>
          <div className={styles.sidebarFooter}>Private, single-owner workspace.</div>
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
  return (
    <nav className={styles.mobileNav} aria-label="CareerScope, compact">
      {navItems.map(({ key, label, icon: Icon, href }) =>
        href ? (
          <Link
            key={key}
            href={href}
            className={styles.mobileNavItem}
            aria-current={key === active ? 'page' : undefined}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </Link>
        ) : (
          <span
            key={key}
            className={styles.mobileNavItemDisabled}
            aria-disabled="true"
            title="Not yet available in CareerScope"
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </span>
        ),
      )}
    </nav>
  );
}

export function DashboardTopbar({
  theme,
  onToggleTheme,
  email,
  onSignOut,
  signOutPending,
}: {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  email?: string;
  onSignOut: () => void;
  signOutPending: boolean;
}) {
  return (
    <header className={styles.topbar}>
      {/* Links into the real, existing search workspace rather than an
          instant-search box with nothing behind it: CareerScope has no
          cross-entity search endpoint today, so a functional-looking
          search field here would be a UI element that does nothing. */}
      <Link href="/jobs" className={styles.topbarSearch}>
        <Search size={15} aria-hidden="true" />
        <span>Search jobs in your workspace</span>
      </Link>
      <div className={styles.topbarActions}>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onSignOut}
          disabled={signOutPending}
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOut size={17} />
        </button>
        {/* No notification bell: CareerScope has no notifications backend
            (CS-43 is still DISCOVERY). A bell with an invented count would
            be exactly the fabricated alert the product rules forbid. */}
        <span
          className={styles.iconButton}
          aria-hidden="true"
          title="Notifications are not available yet"
        >
          <Bell size={17} style={{ opacity: 0.35 }} />
        </span>
        <InitialsAvatar email={email} />
      </div>
    </header>
  );
}
