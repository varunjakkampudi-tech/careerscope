/**
 * The lead detail drawer.
 *
 * Everything the table had to truncate: the full description, the company's real
 * links, the match breakdown, and the two things you can actually change about a
 * lead — its status and your note on it.
 *
 * ## Non-modal, deliberately
 *
 * On desktop the table stays visible and usable beside this panel, so it is a
 * `role="dialog"` without `aria-modal` and without a focus trap. Trapping focus
 * would strand a keyboard user inside a panel that is sitting next to a live
 * list they can see. Escape closes it, focus starts on the heading, and Tab
 * eventually walks out into the table — which is the correct behaviour for a
 * non-modal panel. Below `md` it covers the screen and gets a backdrop, because
 * there the table genuinely is gone.
 *
 * ## Company data comes from the detail response, not the job
 *
 * `job.company` is a narrowed projection carried on every row — id, name, site,
 * portal, email. The enriched row from `useLead()` is the full record, and it is
 * the only place `atsType`, `linkedinUrl` and the provenance `note` exist. Read
 * the wrong one and those three fields silently never render.
 *
 * ## Nothing here is invented
 *
 * A careers email is shown only when the resolver actually found a `mailto:` on
 * the company's own page. When it didn't, this says so and points at the portal
 * instead of composing `careers@` + the domain and hoping.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  formatRelativeDate,
  formatSalary,
  SOURCE_LABELS,
  LEAD_STATUSES,
  type Company,
  type Job,
  type Lead,
  type LeadStatus,
} from '@job-radar/shared';
import { useLead, useUpdateLead } from '../lib/queries';
import { MatchMeter } from './MatchMeter';
import { ApplicationPanel } from './ApplicationPanel';
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyButton,
  ExternalLink,
  Field,
  Select,
  Skeleton,
  Textarea,
  buttonClass,
  cx,
} from './ui';

const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New',
  saved: 'Saved',
  applied: 'Applied',
  interviewing: 'Interviewing',
  rejected: 'Rejected',
  dismissed: 'Dismissed',
};

const EMPLOYMENT_LABEL: Record<string, string> = {
  fulltime: 'Full-time',
  parttime: 'Part-time',
  contract: 'Contract',
  internship: 'Internship',
  temporary: 'Temporary',
};

export interface LeadDrawerProps {
  leadId: string;
  /**
   * The row the user clicked. Rendering from it while the detail request is in
   * flight means the header appears instantly — the data is already on screen,
   * so a spinner here would be theatre.
   */
  fallback?: Lead | undefined;
  threshold: number;
  onClose: () => void;
}

export function LeadDrawer({ leadId, fallback, threshold, onClose }: LeadDrawerProps) {
  const detail = useLead(leadId);
  const heading = useRef<HTMLDivElement>(null);
  const headingId = useId();

  const lead = detail.data?.lead ?? fallback;
  const company = detail.data?.company ?? null;

  // Escape closes. Bound to the document rather than the panel so it works even
  // when focus has walked out into the table behind it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Move focus in when the drawer opens or switches leads, so a screen reader
  // announces the new lead instead of leaving the user reading the old one.
  useEffect(() => {
    heading.current?.focus();
  }, [leadId]);

  return (
    <>
      {/* Mobile only: on desktop the table beside this stays clickable. */}
      <div
        className="fixed inset-0 z-30 bg-black/40 md:hidden"
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        role="dialog"
        aria-labelledby={headingId}
        className={cx(
          'fixed inset-0 z-40 flex flex-col overflow-y-auto bg-surface',
          // Desktop: a scrollport of its own, pinned beside a window-scrolled
          // table. `h-full` would inherit the row's height, and that row is as
          // tall as the whole list — an `overflow-y-auto` box taller than its
          // content never scrolls. The height is stated against the viewport
          // instead, which is the only thing here that has a fixed size.
          'md:sticky md:inset-auto md:top-[calc(var(--spacing-app-header)+1.5rem)] md:z-auto',
          'md:h-[calc(100dvh-var(--spacing-app-header)-3rem)] md:self-start',
          'md:w-[440px] md:shrink-0 md:border-l md:border-border lg:w-[520px]',
        )}
      >
        <div
          ref={heading}
          tabIndex={-1}
          className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-surface px-5 py-4 outline-none"
        >
          <div className="min-w-0">
            {lead ? (
              <>
                <h2 id={headingId} className="text-base leading-snug font-semibold text-ink">
                  {lead.job.title}
                </h2>
                <p className="mt-0.5 truncate text-sm text-muted">{lead.job.company.name}</p>
              </>
            ) : (
              <h2 id={headingId} className="text-base font-semibold text-ink">
                Loading lead…
              </h2>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close details">
            Close
          </Button>
        </div>

        {detail.isError && !lead ? (
          <div className="p-5">
            <Alert
              tone="bad"
              title="Couldn't load this lead"
              action={
                <Button size="sm" variant="secondary" onClick={() => void detail.refetch()}>
                  Retry
                </Button>
              }
            >
              {detail.error.message}
            </Alert>
          </div>
        ) : !lead ? (
          <div className="flex flex-col gap-3 p-5">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <div className="flex flex-col gap-6 px-5 py-5">
            <Actions lead={lead} company={company} />
            <ApplicationPanel key={lead.id} leadId={lead.id} />
            <MatchMeter match={lead.match} threshold={threshold} />
            <Facts job={lead.job} />
            <Links job={lead.job} company={company} />
            {/* Both are keyed so that switching leads remounts them with fresh
                state, rather than each syncing itself back in an effect. The
                note's key includes the saved text: it has to reset when the
                server's copy changes — which is what a successful save does —
                but not on a background refetch that returns the same string,
                or a half-typed note would vanish. */}
            <Description key={lead.job.id} job={lead.job} />
            <NoteEditor key={`${lead.id}:${lead.note}`} lead={lead} />
          </div>
        )}
      </aside>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Apply + status                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The two things worth doing from here, side by side: go apply, and record that
 * you did. Marking applied is not automatic on click — the user may open the
 * posting and decide against it, and a status they didn't choose is a lie in
 * their own tracker.
 */
function Actions({ lead, company }: { lead: Lead; company: Company | null }) {
  const update = useUpdateLead();
  const statusId = useId();

  const portal = company?.atsPortalUrl ?? lead.job.company.atsPortalUrl;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ExternalLink href={lead.job.applyUrl} className={buttonClass('primary')}>
          Open posting
        </ExternalLink>
        {portal ? (
          <ExternalLink href={portal} className={buttonClass('secondary')}>
            Careers portal
          </ExternalLink>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Status" htmlFor={statusId} className="w-44">
          <Select
            id={statusId}
            value={lead.status}
            disabled={update.isPending}
            onChange={(event) =>
              update.mutate({
                id: lead.id,
                patch: { status: event.target.value as LeadStatus },
              })
            }
          >
            {LEAD_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </Select>
        </Field>
        {update.isError ? (
          <p className="pb-2 text-xs text-bad">Couldn’t save: {update.error.message}</p>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Facts                                                                      */
/* -------------------------------------------------------------------------- */

function Facts({ job }: { job: Job }) {
  const years = job.requiredYears;
  const experience =
    years.min === null && years.max === null
      ? null
      : years.min !== null && years.max !== null
        ? `${years.min}–${years.max} years`
        : years.min !== null
          ? `${years.min}+ years`
          : `Up to ${years.max} years`;

  const location = job.location.trim();

  return (
    <Card className="p-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Fact
          label="Job ID"
          value={
            <span className="font-mono text-xs">
              {job.id} <CopyButton value={job.id} />
            </span>
          }
        />
        <Fact
          label="Source job ID"
          value={
            <span className="font-mono text-xs">
              {job.sourceJobId} <CopyButton value={job.sourceJobId} />
            </span>
          }
        />
        <Fact label="Package" value={formatSalary(job.salary)} />
        <Fact
          label="Location"
          value={
            <>
              {location || (job.isRemote ? 'Remote' : 'Not stated')}
              {job.isRemote && location ? (
                <Badge tone="accent" className="ml-2">
                  Remote
                </Badge>
              ) : null}
            </>
          }
        />
        <Fact
          label="Employment"
          value={
            job.employmentType
              ? (EMPLOYMENT_LABEL[job.employmentType] ?? job.employmentType)
              : 'Not stated'
          }
        />
        <Fact label="Experience asked" value={experience ?? 'Not stated'} />
        <Fact label="Posted" value={formatRelativeDate(job.postedAt) || 'Not stated'} />
        <Fact
          label="Source"
          value={
            <>
              {SOURCE_LABELS[job.source]}
              {job.sourcePublisher ? (
                <span className="text-faint"> · via {job.sourcePublisher}</span>
              ) : null}
            </>
          }
        />
      </dl>

      {job.techStack.length > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <dt className="mb-1.5 text-xs text-muted">Tech stack in the description</dt>
          <div className="flex flex-wrap gap-1.5">
            {job.techStack.map((tech) => (
              <Badge key={tech} tone="neutral">
                {tech}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-ink text-wrap-anywhere">{value}</dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Links + contact                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every route to this employer that was actually verified.
 *
 * `job.company` carries a projection of the same fields, so prefer the enriched
 * row and fall back to the projection — a lead saved before the resolver ran
 * still has whatever the board itself reported.
 */
function Links({ job, company }: { job: Job; company: Company | null }) {
  const website = company?.website ?? job.company.website;
  const careersUrl = company?.careersUrl ?? job.company.careersUrl;
  const portal = company?.atsPortalUrl ?? job.company.atsPortalUrl;
  const email = company?.careersEmail ?? job.company.careersEmail;
  const emailConfidence = company?.emailConfidence ?? job.company.emailConfidence;

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Where to go</h3>

      <ul className="flex flex-col gap-2 text-sm">
        <LinkRow label="Direct job link" href={job.applyUrl} />
        <LinkRow label="Listing on the source" href={job.sourceUrl} />
        <LinkRow label="Company website" href={website} />
        <LinkRow label="Careers page" href={careersUrl} />
        <LinkRow
          label={company?.atsType ? `Careers portal (${company.atsType})` : 'Careers portal'}
          href={portal}
        />
        <LinkRow label="Company on LinkedIn" href={company?.linkedinUrl ?? null} />
      </ul>

      <div className="mt-4 border-t border-border pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-xs font-medium text-muted">Careers email</h4>
          {email ? (
            <Badge tone={emailConfidence === 'verified' ? 'good' : 'warn'}>{emailConfidence}</Badge>
          ) : null}
        </div>
        {email ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <a href={`mailto:${email}`} className="text-sm text-accent hover:underline">
              {email}
            </a>
            <CopyButton value={email} />
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted">
            Not yet verified — apply through the portal. An address is only shown here when it was
            published on the company’s own careers or contact page.
          </p>
        )}
      </div>

      {company?.note ? (
        <p className="mt-3 border-t border-border pt-3 text-xs text-faint text-wrap-anywhere">
          {company.note}
          {company.resolvedAt ? ` · checked ${formatRelativeDate(company.resolvedAt)}` : ''}
        </p>
      ) : null}
    </Card>
  );
}

function LinkRow({ label, href }: { label: string; href: string | null }) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-xs text-muted">{label}</span>
      {href ? (
        <ExternalLink href={href} className="min-w-0 truncate text-right text-accent" title={href}>
          {hostOf(href)}
        </ExternalLink>
      ) : (
        <span className="text-xs text-faint">Not yet verified</span>
      )}
    </li>
  );
}

/** A bare host reads better than a 200-character tracking URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/* -------------------------------------------------------------------------- */
/* Description                                                                */
/* -------------------------------------------------------------------------- */

/** Above this, collapse it — a 12,000-character JD buries the note field. */
const JD_COLLAPSE_CHARS = 1600;

function Description({ job }: { job: Job }) {
  const text = job.descriptionText.trim();
  const [expanded, setExpanded] = useState(false);
  const long = text.length > JD_COLLAPSE_CHARS;

  if (!text) {
    return (
      <Alert tone="info" title="No description available">
        {job.hasFullDescription
          ? 'This source returned an empty description.'
          : 'This source only returns a snippet, so the match score is capped and the full text has to be read on the posting itself.'}
      </Alert>
    );
  }

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">Job description</h3>
        {!job.hasFullDescription ? <Badge tone="warn">Snippet only</Badge> : null}
      </div>

      {/* `whitespace-pre-wrap` keeps the board's own paragraphing and bullets.
          The text is plain — the API strips HTML at ingest — so there is
          nothing to sanitise and nothing to dangerously set. */}
      <div
        className={cx(
          'text-sm leading-relaxed whitespace-pre-wrap text-muted text-wrap-anywhere',
          long && !expanded && 'relative max-h-72 overflow-hidden',
        )}
      >
        {text}
        {long && !expanded ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface to-transparent" />
        ) : null}
      </div>

      {long ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1"
          onClick={() => setExpanded((previous) => !previous)}
        >
          {expanded ? 'Show less' : 'Show full description'}
        </Button>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Note                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Explicit save rather than autosave-on-blur. A note is the one field here the
 * user typed themselves, and a silent save that quietly failed would lose it —
 * so the button says whether it went through.
 */
function NoteEditor({ lead }: { lead: Lead }) {
  const update = useUpdateLead();
  const [draft, setDraft] = useState(lead.note);
  const noteId = useId();

  const dirty = draft !== lead.note;

  return (
    <section>
      <Field label="Your notes" htmlFor={noteId}>
        <Textarea
          id={noteId}
          rows={4}
          value={draft}
          maxLength={4000}
          placeholder="Recruiter name, referral, where you are in the process…"
          onChange={(event) => setDraft(event.target.value)}
        />
      </Field>
      <div className="mt-2 flex items-center gap-3">
        <Button
          size="sm"
          disabled={!dirty}
          loading={update.isPending}
          onClick={() => update.mutate({ id: lead.id, patch: { note: draft } })}
        >
          Save note
        </Button>
        {update.isError ? (
          <span className="text-xs text-bad">{update.error.message}</span>
        ) : !dirty && update.isSuccess ? (
          <span className="text-xs text-good">Saved</span>
        ) : null}
      </div>
    </section>
  );
}
