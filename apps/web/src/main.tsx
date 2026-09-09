/**
 * Entry point.
 *
 * Two things happen before React renders, and both are deliberate:
 *
 *  1. `initTheme()` puts the theme class on `<html>`. It cannot be an inline
 *     script in `index.html` — the API's CSP forbids one — so this is the
 *     earliest point available. See `lib/theme.ts`.
 *  2. The query client is configured with a retry policy that knows the
 *     difference between "the server is briefly unhappy" and "your key is
 *     wrong". Retrying the second three times just delays the message that would
 *     have fixed it.
 */

import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { ApiError } from './lib/api';
import { reportAuthFailure } from './lib/auth';
import { initTheme } from './lib/theme';

initTheme();

/** Raises the shell's "key rejected" banner from anywhere in the app. */
function noteAuthFailure(error: unknown): void {
  if (error instanceof ApiError && error.isAuthFailure) {
    reportAuthFailure();
    if (error.status === 401) void queryClient.invalidateQueries({ queryKey: ['auth-session'] });
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: noteAuthFailure }),
  mutationCache: new MutationCache({ onError: noteAuthFailure }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // A 4xx is a statement about the request, and repeating it verbatim
        // cannot change the answer. A 5xx or a dropped connection might.
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
    },
    // Nothing here is idempotent — a retried resume upload is a duplicate
    // resume, a retried search is a second run.
    mutations: { retry: false },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root — index.html did not load as expected');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
