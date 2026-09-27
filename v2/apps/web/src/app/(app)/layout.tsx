import type { ReactNode } from 'react';
import AuthenticatedShell from '@/components/authenticated-shell';

// Every authenticated route lives under this one route group so the single
// auth boundary and shared visual shell (CS-6) apply uniformly — a page
// added here gets both automatically, rather than each page re-implementing
// its own copy (which is exactly how Dashboard's first version diverged).
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}
