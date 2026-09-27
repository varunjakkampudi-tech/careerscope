'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// One QueryClient for the whole app (previously each route created its own,
// so navigating between the sign-in page, Dashboard and every other route
// silently discarded and re-fetched everything). Elevating it here means the
// `useSession()` cache — and every other query — now genuinely survives
// client-side navigation between routes, which is also what makes a single
// shared auth boundary (CS-6) possible instead of one session fetch per page.
export default function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 1000 } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
