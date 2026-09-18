/**
 * Regression tests for the app shell.
 *
 * The subject here is the nav badge, and specifically its middle state. The
 * lead count is its own query, so it lands after the nav has painted; a pill
 * that simply appears when it arrives widens the Leads link and shoves Settings
 * sideways. Measured on the real page that was a 43px jump on every load, and
 * about a third of the page's cumulative layout shift.
 *
 * The fix is a tri-state `badge` prop where `'pending'` renders the pill's box
 * and paints nothing. That is easy to "simplify" back into a falsy check by
 * someone who reads `invisible` as dead styling, so the geometry is pinned here
 * rather than left to the CLS number to catch a release later.
 */

import type { SearchRun } from '@job-radar/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Layout } from './Layout';
import { APP_VERSION } from '../lib/brand';
import { renderApp, screen, within } from '../test/utils';

const useLeadCounts = vi.hoisted(() => vi.fn());
const useActiveRun = vi.hoisted(() => vi.fn());
const isAuthRejected = vi.hoisted(() => vi.fn(() => false));

vi.mock('../lib/queries', () => ({ useLeadCounts, useActiveRun }));

// The auth banner is a different concern and doubles the DOM under test.
vi.mock('../lib/auth', () => ({
  hasApiKey: () => false,
  isAuthRejected,
  subscribeToApiKey: () => () => {},
  subscribeToAuthFailure: () => () => {},
}));

/** Only the fields the component reads; the rest of `UseQueryResult` is noise. */
function query<T>(partial: { data?: T; isPending?: boolean }) {
  return {
    data: partial.data,
    isPending: partial.isPending ?? false,
  } as UseQueryResult<T>;
}

function leadsLink() {
  return screen.getByRole('link', { name: /^Leads/ });
}

describe('Layout nav badge', () => {
  beforeEach(() => {
    useActiveRun.mockReturnValue(query<SearchRun | null>({ data: null }));
  });

  it('reserves the pill while the count is still in flight', () => {
    useLeadCounts.mockReturnValue(query({ isPending: true }));
    renderApp(<Layout />);

    const badge = leadsLink().querySelector('span.invisible');

    // Present in the layout, painting nothing. `invisible` is `visibility:
    // hidden` — it keeps the box, which is the entire point.
    expect(badge).not.toBeNull();
    expect(badge).toHaveTextContent('');
    expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/profile');
    expect(screen.queryByText('No API key set')).not.toBeInTheDocument();
  });

  it('does not announce the placeholder', () => {
    useLeadCounts.mockReturnValue(query({ isPending: true }));
    renderApp(<Layout />);

    // `visibility: hidden` also removes the node from the accessibility tree, so
    // the link's accessible name is the bare label rather than "Leads " with a
    // phantom pill after it. Testing Library's `name` matching is normalised, so
    // this asserts the absence of any announced count.
    expect(screen.getByRole('link', { name: 'Leads' })).toBeInTheDocument();
  });

  it('shows the count once it lands', () => {
    useLeadCounts.mockReturnValue(query({ data: { total: 162, byStatus: {} } }));
    renderApp(<Layout />);

    const link = leadsLink();
    expect(within(link).getByText('162')).toBeInTheDocument();
    expect(link.querySelector('span.invisible')).toBeNull();
  });

  it('keeps the reserved width identical either side of the swap', () => {
    // The whole fix rests on the pending box and the settled box being the same
    // size. Both go through the same `min-w-[3ch]` inner span; a `min-w` moved
    // onto the padded badge would be measured against the border box and
    // under-reserve by the padding, which is the bug this pins.
    useLeadCounts.mockReturnValue(query({ isPending: true }));
    const { unmount } = renderApp(<Layout />);
    const pendingClasses = leadsLink().querySelector('span.invisible span')?.className;
    unmount();

    useLeadCounts.mockReturnValue(query({ data: { total: 162, byStatus: {} } }));
    renderApp(<Layout />);
    const settledClasses = within(leadsLink()).getByText('162').className;

    expect(pendingClasses).toBe(settledClasses);
    expect(settledClasses).toContain('min-w-[3ch]');
  });

  it('carries no badge at all when the count is zero', () => {
    useLeadCounts.mockReturnValue(query({ data: { total: 0, byStatus: {} } }));
    renderApp(<Layout />);

    // A "0" pill is furniture. Once the count is known to be zero there is
    // nothing left to reserve space for, so the pill goes entirely.
    expect(leadsLink().querySelector('span')).toBeNull();
  });

  it('never badges the links that carry no count', () => {
    useLeadCounts.mockReturnValue(query({ isPending: true }));
    renderApp(<Layout />);

    for (const label of ['Search', 'Settings']) {
      expect(screen.getByRole('link', { name: label }).querySelector('span')).toBeNull();
    }
  });
});

it('still displays a rejected-credentials warning', () => {
  isAuthRejected.mockReturnValue(true);
  renderApp(<Layout />);
  expect(screen.getByText('The API rejected your key')).toBeInTheDocument();
  isAuthRejected.mockReturnValue(false);
});

it('provides a keyboard skip target and a compact workspace footer', () => {
  renderApp(<Layout />);
  expect(screen.getByRole('link', { name: 'CareerScope' })).toHaveAttribute('href', '/');
  expect(screen.getByText(`v${APP_VERSION}`)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute(
    'href',
    '#main-content',
  );
  expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('tabindex', '0');
  expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  expect(screen.getByRole('main')).toHaveAttribute('tabindex', '-1');
  const footer = screen.getByRole('contentinfo');
  expect(within(footer).getByRole('link', { name: 'Workspace settings' })).toHaveAttribute(
    'href',
    '/settings',
  );
  expect(within(footer).getByRole('link', { name: 'Back to top' })).toHaveAttribute(
    'href',
    '#main-content',
  );
});

describe('Layout running-search indicator', () => {
  beforeEach(() => {
    useLeadCounts.mockReturnValue(query({ data: { total: 3, byStatus: {} } }));
  });

  it('stays hidden when nothing is running', () => {
    useActiveRun.mockReturnValue(query<SearchRun | null>({ data: null }));
    renderApp(<Layout />);

    expect(screen.queryByText('Searching')).not.toBeInTheDocument();
  });

  it('shows rounded progress from anywhere in the app', () => {
    useActiveRun.mockReturnValue(
      query({ data: { stage: 'Scoring leads', progress: 0.426 } as SearchRun }),
    );
    renderApp(<Layout />, { route: '/settings' });

    // A run takes minutes. Without this, the only way to know one is in flight
    // is to be sitting on the search screen watching it.
    expect(screen.getByText('Searching')).toBeInTheDocument();
    expect(screen.getByText('43%')).toBeInTheDocument();
  });
});
