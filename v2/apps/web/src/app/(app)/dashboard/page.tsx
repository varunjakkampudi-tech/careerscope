'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bookmark,
  Check,
  ChevronRight,
  Circle,
  ClipboardCheck,
  FileText,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
  UserRound,
} from 'lucide-react';
import { api } from '@/lib/api';
import { ownerKey, useSession } from '@/lib/session';
import HeroIllustration from '@/components/hero-illustration';
import { SaveJob } from '@/components/saved-leads';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui-states';
import styles from '@/components/dashboard-shell.module.css';

type Run = { id: string; status: string; createdAt: string; request: { query: string } };
type LeadPage = {
  items: { id: string; data: { title: string; company: string }; createdAt: string }[];
  nextCursor: string | null;
};
type ResumeItem = { id: string; createdAt: string; status: string };
type Profile = {
  revision: number;
  profile: { preferences: { techStack: string[]; titles: string[] } } | null;
};
type MatchBreakdown = { score: number; matchedSkills: string[] } | null;
type Job = {
  id: string;
  data: {
    title: string;
    company: string;
    location: string;
    sourceUrl: string;
    match: MatchBreakdown;
  };
};
type Detail = { status: string; jobs: Job[] };

// Real, exact count when the page fits under the limit; an honest "50+"
// rather than a silently-capped number when it does not.
function countLabel(page: LeadPage | undefined) {
  if (!page) return null;
  return page.nextCursor === null ? String(page.items.length) : `${page.items.length}+`;
}

// A search run's job list is capped at 100 by the collector
// (v2/apps/workers/search/src/collect.ts: `results.slice(0, 100)`) before it
// ever reaches the database, independent of the Lead pagination `countLabel`
// above handles. Hitting that cap means real matches were discarded, so — the
// same honesty rule as `countLabel` — a full page must never be presented as
// an exact total. Independent Reviewer finding 1, 2026-09-23.
function jobCountLabel(jobs: Job[] | undefined) {
  if (!jobs) return null;
  return jobs.length >= 100 ? '100+' : String(jobs.length);
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning!';
  if (hour < 18) return 'Good afternoon!';
  return 'Good evening!';
}

// CS-38: a plain, honest relative-time label computed once per render from
// a real dataUpdatedAt timestamp - never a ticking clock/interval.
function freshnessLabel(updatedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (seconds < 60) return 'Updated just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `Updated ${hours}h ago`;
}

function DashboardContent() {
  // Auth boundary, theme and the shared shell now live in
  // ../../components/authenticated-shell.tsx (CS-6) — this component only
  // ever renders once that boundary already let it through, so it can go
  // straight to its own data.
  const router = useRouter();
  const session = useSession();
  const authenticated = session.data?.authenticated === true;
  // CS-61: the owner digest is present exactly when authenticated, so every
  // query below that is gated on `authenticated` can be keyed on it safely.
  const owner = session.data?.owner;

  const profile = useQuery({
    queryKey: ownerKey(owner, 'dashboard-profile'),
    queryFn: ({ signal }) => api<Profile>('/profile', { signal }),
    enabled: !!owner && authenticated,
    retry: 1,
  });
  const resumes = useQuery({
    queryKey: ownerKey(owner, 'dashboard-resumes'),
    queryFn: ({ signal }) => api<{ enabled: boolean; items: ResumeItem[] }>('/resumes', { signal }),
    enabled: !!owner && authenticated,
    retry: 1,
  });
  const runs = useQuery({
    queryKey: ownerKey(owner, 'dashboard-searches'),
    queryFn: ({ signal }) => api<{ items: Run[] }>('/searches', { signal }),
    enabled: !!owner && authenticated,
    retry: 1,
  });
  const savedLeads = useQuery({
    queryKey: ownerKey(owner, 'dashboard-leads', 'saved'),
    queryFn: ({ signal }) => api<LeadPage>('/leads?status=saved&limit=50', { signal }),
    enabled: !!owner && authenticated,
    retry: 1,
  });
  const appliedLeads = useQuery({
    queryKey: ownerKey(owner, 'dashboard-leads', 'applied'),
    queryFn: ({ signal }) => api<LeadPage>('/leads?status=applied&limit=50', { signal }),
    enabled: !!owner && authenticated,
    retry: 1,
  });

  // The most recent run that actually produced a real result set — the
  // source for "Recommended Jobs" and "Top skills in your last search".
  // Never a market-wide claim: only this owner's own most recent search.
  const latestUsableRun = useMemo(
    () => runs.data?.items.find((run) => ['completed', 'partial'].includes(run.status)),
    [runs.data],
  );
  const latestDetail = useQuery({
    queryKey: ownerKey(owner, 'dashboard-latest-run', latestUsableRun?.id),
    queryFn: ({ signal }) => api<Detail>(`/searches/${latestUsableRun!.id}`, { signal }),
    enabled: !!owner && authenticated && !!latestUsableRun,
    retry: 1,
  });

  const recommended = useMemo(() => {
    const jobs = latestDetail.data?.jobs ?? [];
    return jobs
      .filter((job) => job.data.match)
      .sort((a, b) => (b.data.match!.score ?? 0) - (a.data.match!.score ?? 0))
      .slice(0, 4);
  }, [latestDetail.data]);

  const topSkills = useMemo(() => {
    const counts = new Map<string, number>();
    for (const job of latestDetail.data?.jobs ?? []) {
      for (const skill of job.data.match?.matchedSkills ?? []) {
        counts.set(skill, (counts.get(skill) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [latestDetail.data]);

  const activity = useMemo(() => {
    type Entry = { key: string; text: string; at: string; kind: 'search' | 'saved' | 'resume' };
    const entries: Entry[] = [];
    for (const run of runs.data?.items.slice(0, 3) ?? []) {
      entries.push({
        key: `run-${run.id}`,
        text: `Searched for "${run.request.query}"`,
        at: run.createdAt,
        kind: 'search',
      });
    }
    for (const lead of savedLeads.data?.items.slice(0, 3) ?? []) {
      entries.push({
        key: `lead-${lead.id}`,
        text: `Saved ${lead.data.title} at ${lead.data.company}`,
        at: lead.createdAt,
        kind: 'saved',
      });
    }
    // Same success criterion as the "Resume uploaded" checklist item above —
    // an in-progress or failed upload is not "activity" worth reporting as
    // done. Independent Reviewer finding 3, 2026-09-23.
    const latestResume = resumes.data?.items.find((item) => item.status === 'completed');
    if (latestResume) {
      entries.push({
        key: `resume-${latestResume.id}`,
        text: 'Updated your resume',
        at: latestResume.createdAt,
        kind: 'resume',
      });
    }
    return entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 5);
  }, [runs.data, savedLeads.data, resumes.data]);

  // Every checklist item is a real, independently verifiable fact — never a
  // fabricated "profile completeness" figure. See docs/FRONTEND-ADMIN-ROADMAP.md,
  // "Planning snapshot: 2026-09-23" for why this replaces the design's single
  // invented "94% Profile Match" figure.
  const checks = useMemo(
    () => [
      {
        label: 'Resume uploaded',
        done: (resumes.data?.items ?? []).some((item) => item.status === 'completed'),
      },
      {
        label: 'Skills added',
        done: (profile.data?.profile?.preferences.techStack.length ?? 0) > 0,
      },
      {
        label: 'Preferences set',
        done: profile.data?.profile !== null && profile.data?.profile !== undefined,
      },
      { label: 'Applied to a role', done: (appliedLeads.data?.items.length ?? 0) > 0 },
    ],
    [resumes.data, profile.data, appliedLeads.data],
  );
  const progressLoaded = resumes.isSuccess && profile.isSuccess && appliedLeads.isSuccess;
  const progressPercent = Math.round(
    (checks.filter((check) => check.done).length / checks.length) * 100,
  );

  // CS-38: "freshness semantics" - an honest "as of" indicator for the
  // owner-scoped data on this page, computed only from each query's own
  // dataUpdatedAt (never a ticking clock/interval - this component adds no
  // background polling, per the ticket's own explicit prohibition). Only
  // shown once the primary queries have loaded at least once.
  const freshnessSources = [profile, resumes, runs, savedLeads, appliedLeads];
  const allLoadedOnce = freshnessSources.every((query) => query.dataUpdatedAt > 0);
  const lastUpdatedAt = allLoadedOnce
    ? Math.max(...freshnessSources.map((query) => query.dataUpdatedAt))
    : null;
  const refreshing = freshnessSources.some((query) => query.isFetching);
  const refreshAll = () => {
    for (const query of freshnessSources) void query.refetch();
    if (latestUsableRun) void latestDetail.refetch();
  };

  return (
    <>
      <div className={styles.masterGrid}>
        <div className={styles.leftColumn}>
          {lastUpdatedAt !== null && (
            <div className={styles.freshnessRow} role="status">
              <span>{freshnessLabel(lastUpdatedAt)}</span>
              <button
                type="button"
                onClick={refreshAll}
                disabled={refreshing}
                className={styles.freshnessRefresh}
              >
                <RefreshCw
                  size={13}
                  aria-hidden="true"
                  className={refreshing ? 'spin' : undefined}
                />
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          )}
          <section className={styles.hero}>
            <div className={styles.heroIllustration}>
              <HeroIllustration />
            </div>
            <span className={styles.heroEyebrow}>Your career. A brighter tomorrow.</span>
            <h1>{greeting()}</h1>
            <p className={styles.heroSubtext}>Opportunities don&apos;t happen. You find them.</p>
            <p className={styles.heroSubtextSecondary}>
              Search smarter. Apply faster. Build the career you deserve.
            </p>
            <div className={styles.heroActions}>
              <Link href="/jobs" data-primary="">
                <Search size={15} aria-hidden="true" /> Find Jobs
              </Link>
              <Link href="/resume" data-secondary="">
                <UserRound size={15} aria-hidden="true" /> Upload / Update Resume
              </Link>
            </div>
          </section>

          <div className={styles.statRow}>
            <div className={styles.statCard}>
              <span className={styles.statIcon} data-tone="blue">
                <Bookmark size={16} aria-hidden="true" />
              </span>
              <span className={styles.statValue}>
                {savedLeads.isPending
                  ? '—'
                  : savedLeads.isError
                    ? '?'
                    : countLabel(savedLeads.data)}
              </span>
              <span className={styles.statLabel}>Saved jobs</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statIcon} data-tone="purple">
                <ClipboardCheck size={16} aria-hidden="true" />
              </span>
              <span className={styles.statValue}>
                {appliedLeads.isPending
                  ? '—'
                  : appliedLeads.isError
                    ? '?'
                    : countLabel(appliedLeads.data)}
              </span>
              <span className={styles.statLabel}>Applied</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statIcon} data-tone="green">
                <Search size={16} aria-hidden="true" />
              </span>
              <span className={styles.statValue}>
                {!latestUsableRun ? '—' : (jobCountLabel(latestDetail.data?.jobs) ?? '—')}
              </span>
              <span className={styles.statLabel}>Jobs in last search</span>
              {!latestUsableRun && (
                <span className={styles.statHint}>Run a search to see this</span>
              )}
            </div>
            <div className={styles.statCard}>
              <span className={styles.statIcon} data-tone="orange">
                <TrendingUp size={16} aria-hidden="true" />
              </span>
              <span className={styles.statValue}>
                {recommended[0] ? `${Math.round(recommended[0].data.match!.score * 100)}%` : '—'}
              </span>
              <span className={styles.statLabel}>Best match this search</span>
              {!recommended[0] && <span className={styles.statHint}>Run a search to see this</span>}
            </div>
          </div>

          <section className={styles.panel}>
            <div className={styles.panelHeaderRow}>
              <h2>Recommended Jobs for You</h2>
              <Link href="/jobs" className={styles.viewAllLink}>
                View all jobs
                <ChevronRight size={14} aria-hidden="true" />
              </Link>
            </div>
            {!latestUsableRun && (
              <EmptyState
                variant="inline"
                className={styles.stateNotice}
                message="Run a search to see recommended jobs."
                reason="awaiting-input"
              />
            )}
            {latestUsableRun && latestDetail.isPending && (
              <LoadingState variant="inline" className={styles.stateNotice} message="Loading…" />
            )}
            {latestUsableRun && latestDetail.isSuccess && recommended.length === 0 && (
              <EmptyState
                variant="inline"
                className={styles.stateNotice}
                message="Your last search has no scored results yet."
                reason="nothing-yet"
              />
            )}
            {recommended.length > 0 && (
              <div className={styles.jobCardList}>
                {recommended.map((job) => (
                  <div className={styles.jobCard} key={job.id}>
                    <div className={styles.jobCardHeader}>
                      <span className={styles.jobCardLogo} aria-hidden="true">
                        {job.data.company.charAt(0).toUpperCase()}
                      </span>
                      <div className={styles.jobCardBody}>
                        <div className={styles.jobCardTop}>
                          <span className={styles.jobCardTitle}>{job.data.title}</span>
                          <span className={styles.matchBadge}>
                            {Math.round(job.data.match!.score * 100)}% match
                          </span>
                        </div>
                        <span className={styles.jobCardMeta}>
                          {job.data.company} · {job.data.location}
                        </span>
                      </div>
                      <SaveJob
                        jobId={job.id}
                        csrf={session.data?.csrf ?? ''}
                        // Carries the lead id, so this opens the lead it
                        // names rather than the bare list (F-1b).
                        onOpen={(leadId) =>
                          router.push(`/saved?lead=${encodeURIComponent(leadId)}`)
                        }
                        iconOnly
                      />
                    </div>
                    {job.data.match!.matchedSkills.length > 0 && (
                      <div className={styles.tagRow}>
                        {job.data.match!.matchedSkills.slice(0, 5).map((skill) => (
                          <span key={skill}>{skill}</span>
                        ))}
                      </div>
                    )}
                    <div className={styles.jobCardFooter}>
                      <a href={job.data.sourceUrl} target="_blank" rel="noreferrer">
                        View Details <ChevronRight size={13} aria-hidden="true" />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className={styles.splitPanels}>
            <section className={styles.panel}>
              <h2>Your Recent Activity</h2>
              {!runs.isSuccess || !savedLeads.isSuccess || !resumes.isSuccess ? (
                <LoadingState variant="inline" className={styles.stateNotice} message="Loading…" />
              ) : activity.length === 0 ? (
                <EmptyState
                  variant="inline"
                  className={styles.stateNotice}
                  message="No activity yet."
                  reason="nothing-yet"
                />
              ) : (
                <ul className={styles.activityList}>
                  {activity.map((entry) => (
                    <li key={entry.key}>
                      <span className={styles.activityText}>
                        <span className={styles.activityIcon} aria-hidden="true">
                          {entry.kind === 'search' ? (
                            <Search size={13} />
                          ) : entry.kind === 'saved' ? (
                            <Bookmark size={13} />
                          ) : (
                            <FileText size={13} />
                          )}
                        </span>
                        <span>{entry.text}</span>
                      </span>
                      <small>{new Date(entry.at).toLocaleDateString()}</small>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.panel}>
              <h2>Top Skills in Your Last Search</h2>
              {!latestUsableRun && (
                <EmptyState
                  variant="inline"
                  className={styles.stateNotice}
                  message="Run a search to see this."
                  reason="awaiting-input"
                />
              )}
              {latestUsableRun && topSkills.length === 0 && latestDetail.isSuccess && (
                <EmptyState
                  variant="inline"
                  className={styles.stateNotice}
                  message="No matched skills recorded for that search."
                  reason="nothing-yet"
                />
              )}
              {topSkills.length > 0 && (
                <ul className={styles.skillRankList}>
                  {topSkills.map(([skill, count], index) => (
                    <li key={skill}>
                      <span>
                        {index + 1}. {skill}
                      </span>
                      <span>{count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className={styles.panel}>
            <h2>Recent Discovery</h2>
            {runs.isPending && (
              <LoadingState
                variant="inline"
                className={styles.stateNotice}
                message="Loading searches…"
              />
            )}
            {runs.isError && (
              <ErrorState
                variant="inline"
                className={styles.stateNotice}
                what="Could not load your recent searches."
                detail="Refresh the page to try again."
                action={
                  <button className={styles.retryButton} onClick={() => runs.refetch()}>
                    <RefreshCw size={13} aria-hidden="true" /> Retry
                  </button>
                }
              />
            )}
            {runs.isSuccess && (runs.data?.items.length ?? 0) === 0 && (
              <EmptyState
                variant="inline"
                className={styles.stateNotice}
                message="No searches yet."
                reason="nothing-yet"
              />
            )}
            {(runs.data?.items.length ?? 0) > 0 && (
              <ul className={styles.runList}>
                {runs.data!.items.slice(0, 5).map((run) => (
                  <li key={run.id}>
                    {/* Names the run it is rendering (F-3): without `?run=`
                        every entry opened whichever run was most recent. */}
                    <Link href={`/jobs?run=${encodeURIComponent(run.id)}`}>
                      <span>
                        <strong>{run.request.query}</strong>
                        <small>{new Date(run.createdAt).toLocaleDateString()}</small>
                      </span>
                      <span>{run.status}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className={styles.rightColumn}>
          <section className={styles.panel} aria-label="Your career progress">
            <h2>Your Career Progress {progressLoaded ? `${progressPercent}%` : ''}</h2>
            {!progressLoaded ? (
              <LoadingState variant="inline" className={styles.stateNotice} message="Loading…" />
            ) : (
              <>
                <div className={styles.progressBarTrack}>
                  <div
                    className={styles.progressBarFill}
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <ul className={styles.checklist}>
                  {checks.map((check) => (
                    <li key={check.label}>
                      {check.done ? (
                        <Check size={15} aria-hidden="true" color="#157539" />
                      ) : (
                        <Circle size={15} aria-hidden="true" />
                      )}
                      <span data-done={check.done}>{check.label}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <Link href="/resume" className={styles.ctaLink}>
              Improve My Profile
              <ChevronRight size={14} aria-hidden="true" />
            </Link>
          </section>

          <section className={styles.aiPanel} aria-label="AI career assistant">
            <div className={styles.aiPanelHeader}>
              <h2
                style={{
                  margin: 0,
                  fontSize: 15,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Sparkles size={16} aria-hidden="true" /> AI Career Assistant
              </h2>
              <span className={styles.aiBadge}>Not available yet</span>
            </div>
            <p className={styles.stateNotice}>
              CareerScope&apos;s AI features are not enabled in this build. When available, this
              will use only the deterministic evidence already shown on this page — never a
              replacement for it.
            </p>
          </section>

          <section className={styles.panel} aria-label="Quick actions">
            <h2>Quick Actions</h2>
            <div className={styles.quickActions}>
              <Link href="/jobs">
                <span className={styles.statIcon} data-tone="blue">
                  <Search size={15} aria-hidden="true" />
                </span>
                Search Jobs
                <ChevronRight size={14} aria-hidden="true" className={styles.quickActionChevron} />
              </Link>
              <Link href="/resume">
                <span className={styles.statIcon} data-tone="purple">
                  <UserRound size={15} aria-hidden="true" />
                </span>
                Upload / Update Resume
                <ChevronRight size={14} aria-hidden="true" className={styles.quickActionChevron} />
              </Link>
              <Link href="/saved">
                <span className={styles.statIcon} data-tone="green">
                  <Bookmark size={15} aria-hidden="true" />
                </span>
                View Saved Jobs
                <ChevronRight size={14} aria-hidden="true" className={styles.quickActionChevron} />
              </Link>
              <Link href="/applications">
                <span className={styles.statIcon} data-tone="purple">
                  <ClipboardCheck size={15} aria-hidden="true" />
                </span>
                Track Applications
                <ChevronRight size={14} aria-hidden="true" className={styles.quickActionChevron} />
              </Link>
              <Link href="/career-resources">
                <span className={styles.statIcon} data-tone="orange">
                  <TrendingUp size={15} aria-hidden="true" />
                </span>
                Explore Career Resources
                <ChevronRight size={14} aria-hidden="true" className={styles.quickActionChevron} />
              </Link>
            </div>
          </section>
        </div>
      </div>

      <div className={styles.proTip}>
        <span>
          <strong>Pro Tip:</strong> Complete your profile and add skills to improve your job
          matches.
        </span>
        <Link href="/resume" className={styles.ctaLink}>
          Complete Profile
          <ChevronRight size={14} aria-hidden="true" />
        </Link>
      </div>
      <p className={styles.footerQuote}>&quot;A smarter way to a brighter future.&quot;</p>
    </>
  );
}

export default DashboardContent;
