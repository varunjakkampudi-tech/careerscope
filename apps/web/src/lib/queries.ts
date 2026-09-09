/**
 * Server state.
 *
 * Every call to the API goes through a hook here rather than being fetched
 * inline, so caching, invalidation and retry policy are decided once. Three
 * conventions run through the file:
 *
 *  - **Query keys mirror URLs.** `['leads', filters]` for `/api/leads?…`. A
 *    mutation that changes leads invalidates `['leads']` and every filtered
 *    variant goes stale together, which is the behaviour you want when a status
 *    change moves a row in or out of the current filter.
 *  - **A 404 is data, not an error, where the resource is optional.** The
 *    profile does not exist before onboarding; `useProfile` returns `null` for
 *    it instead of throwing, so the first-run path is a normal render rather
 *    than an error boundary.
 *  - **Nothing retries an auth failure.** Retrying a 401 three times just makes
 *    the rate limiter angry and delays the message that would actually help.
 */

import type {
  Company,
  Lead,
  LeadPage,
  LeadStatus,
  LeadUpdate,
  Profile,
  ProfileUpdate,
  Resume,
  SearchRequest,
  SearchRun,
  SkillGap,
  SourceCatalog,
  SourceId,
} from '@job-radar/shared';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { downloadFile, request } from './api';

/* -------------------------------------------------------------------------- */
/* Keys                                                                       */
/* -------------------------------------------------------------------------- */

export const queryKeys = {
  sources: ['sources'] as const,
  profile: ['profile'] as const,
  profileStatus: ['profile', 'status'] as const,
  resumes: ['resumes'] as const,
  lastSearch: ['search', 'last'] as const,
  runs: ['runs'] as const,
  activeRun: ['runs', 'active'] as const,
  leads: ['leads'] as const,
  leadList: (filters: LeadFilters) => ['leads', 'list', filters] as const,
  leadCounts: ['leads', 'counts'] as const,
  skillGap: (threshold: number) => ['leads', 'skill-gap', threshold] as const,
  lead: (id: string) => ['leads', 'detail', id] as const,
};

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The leads query, in the shapes the UI works in.
 *
 * Arrays rather than the comma-joined strings `leadQuerySchema` parses — the
 * client builds those in `api.ts`'s query serialiser, so a filter chip component
 * can push and splice a real array.
 */
export interface LeadFilters {
  minScore: number;
  sources?: SourceId[];
  statuses?: LeadStatus[];
  location?: string;
  company?: string;
  search?: string;
  remoteOnly?: boolean;
  postedWithinDays?: number;
  minSalary?: number;
  runId?: string;
  sort: 'score' | 'postedAt' | 'company' | 'title' | 'salary';
  order: 'asc' | 'desc';
}

/** Rows per request. Large enough that scrolling rarely waits, small enough to stay snappy. */
export const LEAD_PAGE_SIZE = 50;

/* -------------------------------------------------------------------------- */
/* Capability + profile                                                       */
/* -------------------------------------------------------------------------- */

export function useSources(): UseQueryResult<SourceCatalog> {
  return useQuery({
    queryKey: queryKeys.sources,
    queryFn: () => request<SourceCatalog>('/sources'),
    // Availability changes only when the server restarts with different env, so
    // there is no value in refetching it on every screen change.
    staleTime: 5 * 60_000,
  });
}

export interface ProfileStatus {
  exists: boolean;
  hasResume: boolean;
  updatedAt: string | null;
}

export function useProfileStatus(): UseQueryResult<ProfileStatus> {
  return useQuery({
    queryKey: queryKeys.profileStatus,
    queryFn: () => request<ProfileStatus>('/profile/status'),
  });
}

/** Returns `null` — not an error — when onboarding has not happened yet. */
export function useProfile(): UseQueryResult<Profile | null> {
  return useQuery({
    queryKey: queryKeys.profile,
    queryFn: async () => {
      const { profile } = await request<{ profile: Profile | null }>('/profile');
      return profile;
    },
  });
}

export function useCreateProfile(): UseMutationResult<Profile, Error, Profile> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (profile: Profile) => {
      const result = await request<{ profile: Profile }>('/profile', {
        method: 'POST',
        body: profile,
      });
      return result.profile;
    },
    onSuccess: (profile) => {
      client.setQueryData(queryKeys.profile, profile);
      void client.invalidateQueries({ queryKey: queryKeys.profileStatus });
      void client.invalidateQueries({ queryKey: queryKeys.leads });
    },
  });
}

export function useUpdateProfile(): UseMutationResult<Profile, Error, ProfileUpdate> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (patch: ProfileUpdate) => {
      const result = await request<{ profile: Profile }>('/profile', {
        method: 'PUT',
        body: patch,
      });
      return result.profile;
    },
    onSuccess: (profile) => {
      client.setQueryData(queryKeys.profile, profile);
      void client.invalidateQueries({ queryKey: queryKeys.profileStatus });
      void client.invalidateQueries({ queryKey: queryKeys.leads });
    },
  });
}

export function useDeleteProfile(): UseMutationResult<void, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<void>('/profile', { method: 'DELETE' }),
    // Everything downstream of the profile — leads, runs, resumes — belongs to
    // it, so the whole cache goes rather than a list of keys that will drift.
    onSuccess: () => client.clear(),
  });
}

/* -------------------------------------------------------------------------- */
/* Resume                                                                     */
/* -------------------------------------------------------------------------- */

export interface UploadedResume {
  resume: Resume;
  derived: Resume['derived'];
}

export function useUploadResume(): UseMutationResult<UploadedResume, Error, File> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return request<UploadedResume>('/resume', { method: 'POST', form });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.resumes });
      void client.invalidateQueries({ queryKey: queryKeys.profileStatus });
    },
    // A 10 MB upload that failed on a flaky connection should not silently
    // re-send 10 MB twice more.
    retry: false,
  });
}

export function useResumes(): UseQueryResult<Resume[]> {
  return useQuery({
    queryKey: queryKeys.resumes,
    queryFn: async () => {
      const { resumes } = await request<{ resumes: Resume[] }>('/resume');
      return resumes;
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Search + runs                                                              */
/* -------------------------------------------------------------------------- */

export function useLastSearchRequest(): UseQueryResult<SearchRequest | null> {
  return useQuery({
    queryKey: queryKeys.lastSearch,
    queryFn: async () => {
      const { request: last } = await request<{ request: SearchRequest | null }>('/search/last');
      return last;
    },
  });
}

export function useStartSearch(): UseMutationResult<SearchRun, Error, SearchRequest> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: SearchRequest) => {
      const result = await request<{ run: SearchRun; events: string }>('/search', {
        method: 'POST',
        body,
      });
      return result.run;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.runs });
      void client.invalidateQueries({ queryKey: queryKeys.lastSearch });
    },
    retry: false,
  });
}

/**
 * The run that is queued or executing, if any.
 *
 * Polled slowly as a safety net. The SSE stream is the real source of progress;
 * this exists so a user who lands on the search screen with a run already going
 * — from another tab, or from an MCP client — sees it without waiting for an
 * event to happen to arrive.
 */
export function useActiveRun(): UseQueryResult<SearchRun | null> {
  return useQuery({
    queryKey: queryKeys.activeRun,
    queryFn: async () => {
      const { run } = await request<{ run: SearchRun | null }>('/runs/active');
      return run;
    },
    refetchInterval: 15_000,
  });
}

export function useCancelRun(): UseMutationResult<SearchRun, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { run } = await request<{ run: SearchRun }>(`/runs/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
      });
      return run;
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.runs }),
    retry: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Leads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The leads table's data source.
 *
 * Infinite rather than paged because the table is virtualized: the user scrolls
 * a single continuous list, and a page control would be a second, contradictory
 * way to move through it. `total` from the first page drives the count in the
 * header, so the UI can say "312 leads" before it has fetched 312 of them.
 */
export function useLeads(filters: LeadFilters) {
  return useInfiniteQuery({
    queryKey: queryKeys.leadList(filters),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      request<LeadPage>('/leads', {
        query: { ...filters, limit: LEAD_PAGE_SIZE, offset: pageParam },
      }),
    getNextPageParam: (lastPage) => {
      const seen = lastPage.offset + lastPage.items.length;
      return seen < lastPage.total ? seen : undefined;
    },
    // Leads only change when a run writes them or the user edits one, and both
    // invalidate explicitly. Refetching on every window focus would re-request
    // several pages for nothing.
    refetchOnWindowFocus: false,
  });
}

export function useLeadCounts(): UseQueryResult<{
  total: number;
  byStatus: Record<string, number>;
}> {
  return useQuery({
    queryKey: queryKeys.leadCounts,
    queryFn: () => request<{ total: number; byStatus: Record<string, number> }>('/leads/counts'),
  });
}

/**
 * What the near-miss leads keep asking for.
 *
 * Keyed by threshold, because the answer is a different question at 70% than at
 * 85%. It shares the `['leads']` prefix so dismissing a lead — which removes it
 * from the aggregate — refetches this without a second invalidation rule.
 */
export function useSkillGap(threshold: number): UseQueryResult<SkillGap> {
  return useQuery({
    queryKey: queryKeys.skillGap(threshold),
    queryFn: () =>
      request<SkillGap>(
        `/leads/skill-gap?${new URLSearchParams({ threshold: String(threshold) })}`,
      ),
  });
}

export interface LeadDetail {
  lead: Lead;
  /** The enriched company row — website, portal, careers email. Null if unresolved. */
  company: Company | null;
}

export function useLead(id: string | null): UseQueryResult<LeadDetail> {
  return useQuery({
    queryKey: queryKeys.lead(id ?? ''),
    queryFn: () => request<LeadDetail>(`/leads/${encodeURIComponent(id ?? '')}`),
    enabled: id !== null,
  });
}

export function useUpdateLead(): UseMutationResult<Lead, Error, { id: string; patch: LeadUpdate }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }) => {
      const { lead } = await request<{ lead: Lead }>(`/leads/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: patch,
      });
      return lead;
    },
    onSuccess: (lead) => {
      // The drawer's copy is updated in place so the change is visible
      // immediately, while the list is invalidated because a status change can
      // move the row out of the current filter entirely.
      client.setQueryData<LeadDetail>(queryKeys.lead(lead.id), (previous) =>
        previous ? { ...previous, lead } : previous,
      );
      void client.invalidateQueries({ queryKey: queryKeys.leads });
    },
  });
}

export function useBulkUpdateLeads(): UseMutationResult<
  { updated: number; requested: number },
  Error,
  { ids: string[]; status: LeadStatus }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      request<{ updated: number; requested: number }>('/leads/bulk', { method: 'POST', body }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.leads }),
  });
}

export function useExportLeads(): UseMutationResult<
  void,
  Error,
  { format: 'xlsx' | 'csv'; filters: LeadFilters }
> {
  return useMutation({
    mutationFn: ({ format, filters }) => downloadFile(`/export/leads.${format}`, { ...filters }),
    retry: false,
  });
}
