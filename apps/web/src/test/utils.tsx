/**
 * The render wrapper.
 *
 * Two providers are load-bearing for anything in `components/`: a router,
 * because `NavLink` throws outside one, and a query client, because the shell
 * reads lead counts and the active run through TanStack Query. A component test
 * that has to construct both by hand ends up testing the harness.
 *
 * The client is built per render, not shared. A module-level client would carry
 * one test's cache into the next, and the failure that produces — a query that
 * resolves instantly with someone else's data — looks like a component bug
 * rather than a fixture bug.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

export interface RenderAppOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial history entry, for a component whose output depends on the route. */
  route?: string;
}

export function renderApp(
  ui: ReactElement,
  { route = '/', ...options }: RenderAppOptions = {},
): RenderResult & { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // A test asserting an error state should not wait out three backoffs to
        // see it, and a test asserting a success state should not pass because a
        // retry papered over a broken fixture.
        retry: false,
        // Vitest fails a test that logs during teardown; a refetch fired by a
        // stale window-focus listener after the test body finished does exactly
        // that.
        refetchOnWindowFocus: false,
        staleTime: Infinity,
      },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }

  return { ...render(ui, { wrapper: Wrapper, ...options }), queryClient };
}

export * from '@testing-library/react';
export { default as userEvent } from '@testing-library/user-event';
