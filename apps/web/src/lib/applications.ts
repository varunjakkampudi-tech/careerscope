import { useQuery } from '@tanstack/react-query';
import { request } from './api';

export interface ApplicationRun {
  id: string;
  leadId: string;
  status: 'running' | 'needs_input' | 'ready' | 'submitting' | 'submitted' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  events: { at: string; message: string }[];
  currentUrl: string | null;
  question: string | null;
  requestId: string | null;
  confirmation: string | null;
  outcomeUnknown: boolean;
  retryOf: string | null;
}

export function useApplications(leadId?: string) {
  return useQuery({
    queryKey: ['applications', leadId ?? 'all'],
    queryFn: ({ signal }) =>
      request<{ active: ApplicationRun | null; runs: ApplicationRun[] }>('/applications', {
        signal,
        query: { leadId },
      }),
    refetchInterval: (query) => (query.state.data?.active ? 1500 : 10000),
  });
}

export const applicationLabels: Record<ApplicationRun['status'], string> = {
  running: 'Preparing',
  needs_input: 'Your action needed',
  ready: 'Review before submitting',
  submitting: 'Submitting',
  submitted: 'Submitted',
  failed: 'Stopped',
  cancelled: 'Cancelled',
};

export function isApplicationActive(run: ApplicationRun): boolean {
  return ['running', 'needs_input', 'ready', 'submitting'].includes(run.status);
}
