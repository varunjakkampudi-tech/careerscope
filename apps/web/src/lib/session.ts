import { useQuery } from '@tanstack/react-query';
import { request } from './api';

export interface LoginSession {
  enabled: boolean;
  configured: boolean;
  authenticated: boolean;
  canSetup: boolean;
  email: string | null;
}

export const sessionQuery = {
  queryKey: ['auth-session'],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    request<LoginSession>('/auth/session', { signal }),
  staleTime: 0,
  retry: false,
};

export function useSession() {
  return useQuery({ ...sessionQuery, refetchInterval: 30000 });
}
