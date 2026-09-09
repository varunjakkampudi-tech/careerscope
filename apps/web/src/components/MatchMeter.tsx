/**
 * How an "87%" is shown, and how it is justified.
 *
 * A score with no visible derivation is a number the user has to take on faith,
 * and this one decides whether they spend an hour on an application. So every
 * piece the engine computed is rendered: the seven weighted dimensions, what
 * each one scored and why, which skills were found and which were not, whether
 * the description was actually read, and whether Claude moved the number.
 *
 * ## The colour scale
 *
 * Hue does exactly one job here — how strong the match is — as a five-step
 * ordinal ramp in a single hue (see `index.css`, where the steps and their
 * validation are recorded). It deliberately does *not* encode "did this clear
 * your bar", because the bar is a slider the user moves: a palette with a hard
 * colour break at 85% would be lying the moment they drag it to 70%. The
 * threshold gets its own channel instead — a tick on the meter track and a
 * badge with an icon and words.
 *
 * Consequently nothing here reads a value out of colour alone. Every dimension
 * prints its own percentage next to its bar (the bars are `aria-hidden`; the
 * text is the accessible view), and the headline number is text first with the
 * meter underneath it.
 */

import { useState, type ReactNode } from 'react';
import {
  formatScore,
  LOW_CONFIDENCE_SCORE_CEILING,
  MATCH_DIMENSION_LABELS,
  MATCH_WEIGHTS,
  type MatchBreakdown,
  type MatchDimension,
} from '@job-radar/shared';
import { Badge, Button, cx } from './ui';

/* -------------------------------------------------------------------------- */
/* Bands                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Class names are written out in full rather than composed from the score,
 * because Tailwind finds utilities by scanning source text — a template literal
 * like `bg-match-${band}` produces a class that is never generated.
 */
const BAND_FILL: Record<string, string> = {
  '90': 'bg-match-90',
  '80': 'bg-match-80',
  '70': 'bg-match-70',
  '60': 'bg-match-60',
  low: 'bg-match-low',
};

const BAND_LABEL: Record<string, string> = {
  '90': 'Exceptional match',
  '80': 'Strong match',
  '70': 'Good match',
  '60': 'Partial match',
  low: 'Weak match',
};

function bandOf(score: number): string {
  if (score >= 0.9) return '90';
  if (score >= 0.8) return '80';
  if (score >= 0.7) return '70';
  if (score >= 0.6) return '60';
  return 'low';
}

/** The ramp step for a score, as a background utility. Shared with the table. */
export function matchFillClass(score: number): string {
  return BAND_FILL[bandOf(score)] ?? 'bg-match-low';
}

export function matchBandLabel(score: number): string {
  return BAND_LABEL[bandOf(score)] ?? 'Weak match';
}

const pct = (value: number) => `${Math.min(100, Math.max(0, value * 100))}%`;

/* -------------------------------------------------------------------------- */
/* Compact — one row of a table                                               */
/* -------------------------------------------------------------------------- */

export interface MatchScoreProps {
  score: number;
  /** The user's current threshold, drawn as a tick on the track. */
  threshold?: number;
  /** 'low' draws the cap marker, so a capped score never looks like a ceiling. */
  confidence?: 'high' | 'low';
  className?: string;
}

/**
 * The leads table cell: the number, then a short meter under it.
 *
 * Sized to sit in a row without setting the row height — the whole thing is
 * two lines of a normal-height cell.
 */
export function MatchScore({ score, threshold, confidence, className }: MatchScoreProps) {
  return (
    <div className={cx('w-[86px]', className)}>
      <div className="flex items-baseline gap-1">
        <span className="text-sm font-semibold text-ink tabular-nums">{formatScore(score)}</span>
        {confidence === 'low' ? (
          <span
            className="text-xs text-warn"
            title={`Only a snippet was available, so this score is capped at ${formatScore(
              LOW_CONFIDENCE_SCORE_CEILING,
            )}.`}
            aria-label="Capped: description not fully read"
          >
            ⌃
          </span>
        ) : null}
      </div>
      <Track score={score} threshold={threshold} height="h-1.5" />
    </div>
  );
}

/**
 * The meter itself.
 *
 * The fill is square where it meets the baseline and rounded at the data end;
 * the track clips it, so a 3% score still reads as a sliver rather than
 * disappearing into a rounded corner. The threshold tick lives outside the
 * clipping box so it can overhang the track and read as a tick and not a
 * segment boundary.
 */
function Track({
  score,
  threshold,
  height = 'h-2.5',
}: {
  score: number;
  threshold?: number | undefined;
  height?: string;
}) {
  return (
    <div className="relative mt-1">
      <div className={cx('w-full overflow-hidden rounded-[4px] bg-match-track', height)}>
        <div
          className={cx(
            'motion-safe-only h-full rounded-r-[4px] transition-[width] duration-300',
            matchFillClass(score),
          )}
          style={{ width: pct(score) }}
        />
      </div>
      {threshold != null && threshold > 0 && threshold < 1 ? (
        <div
          className="pointer-events-none absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-ink/60"
          style={{ left: pct(threshold) }}
          title={`Your threshold: ${formatScore(threshold)}`}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Full panel                                                                 */
/* -------------------------------------------------------------------------- */

const DIMENSION_ORDER = Object.keys(MATCH_WEIGHTS) as MatchDimension[];
const SKILL_PREVIEW = 12;

export interface MatchMeterProps {
  match: MatchBreakdown;
  /** The threshold this lead was judged against, for the tick and the badge. */
  threshold?: number;
  className?: string;
}

export function MatchMeter({ match, threshold, className }: MatchMeterProps) {
  const clearsBar = threshold == null || match.score >= threshold;

  return (
    <div className={cx('flex flex-col gap-5', className)}>
      {/* Headline. Proportional figures, not tabular — a display-size number
          set in equal-width digits reads loose. */}
      <div>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div>
            <div className="text-5xl leading-none font-semibold text-ink">
              {formatScore(match.score)}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-sm text-muted">
              <span
                className={cx('inline-block size-2 rounded-full', matchFillClass(match.score))}
                aria-hidden="true"
              />
              {matchBandLabel(match.score)}
            </div>
          </div>

          {threshold != null ? (
            <Badge tone={clearsBar ? 'good' : 'neutral'}>
              {clearsBar ? <CheckIcon /> : <DashIcon />}
              {clearsBar ? 'Above' : 'Below'} your {formatScore(threshold)} bar
            </Badge>
          ) : null}
        </div>

        <Track score={match.score} threshold={threshold} />
      </div>

      {match.excludedReason ? (
        <p className="rounded-lg border border-bad/30 bg-bad-soft px-3 py-2 text-sm text-ink">
          <span className="font-medium">Excluded:</span> {match.excludedReason}
        </p>
      ) : null}

      {match.flaggedCompany ? (
        <p className="rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-ink">
          This company is on your do-not-apply list. The lead is still shown so you can decide.
        </p>
      ) : null}

      {match.confidence === 'low' ? (
        <p className="rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-ink">
          The source only returned a snippet, not the full description, so this score is capped at{' '}
          {formatScore(LOW_CONFIDENCE_SCORE_CEILING)}. Open the posting to judge it properly.
        </p>
      ) : null}

      <Dimensions match={match} />

      <Skills matched={match.matchedSkills} missing={match.missingSkills} />

      {match.llmScore != null ? (
        <div className="rounded-lg border border-border bg-canvas px-3 py-2.5 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium text-ink">Claude&apos;s read</span>
            <span className="text-muted tabular-nums">{formatScore(match.llmScore)}</span>
          </div>
          {match.llmRationale ? (
            <p className="mt-1 text-muted text-wrap-anywhere">{match.llmRationale}</p>
          ) : null}
          <p className="mt-2 text-xs text-faint">
            The headline blends this with the {formatScore(match.heuristicScore)} the rules engine
            scored on its own.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dimensions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Seven bars, all one hue.
 *
 * Colouring each bar by its own value would spend the only free channel
 * restating what bar length already says, so they share a single fill and
 * length carries the whole story. Order is fixed by weight — never re-sorted by
 * score, because a panel whose rows move between leads cannot be compared
 * across leads.
 */
function Dimensions({ match }: { match: MatchBreakdown }) {
  return (
    <section>
      <h4 className="mb-2.5 text-xs font-semibold tracking-wide text-faint uppercase">
        Where the score comes from
      </h4>
      <ul className="flex flex-col gap-2.5">
        {DIMENSION_ORDER.map((key) => {
          const dim = match.dimensions[key];
          const weight = MATCH_WEIGHTS[key];
          const earned = dim.score * weight * 100;

          return (
            <li key={key}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="flex items-baseline gap-1.5">
                  <span className="font-medium text-ink">{MATCH_DIMENSION_LABELS[key]}</span>
                  <span
                    className="text-xs text-faint tabular-nums"
                    title={`This dimension is ${Math.round(weight * 100)}% of the total score`}
                  >
                    {Math.round(weight * 100)}%
                  </span>
                </span>
                <span
                  className="shrink-0 text-muted tabular-nums"
                  title={`Contributes ${earned.toFixed(1)} of ${Math.round(weight * 100)} points`}
                >
                  {formatScore(dim.score)}
                </span>
              </div>

              <div
                className="mt-1 h-2 w-full overflow-hidden rounded-[4px] bg-match-track"
                aria-hidden="true"
              >
                <div
                  className="motion-safe-only h-full rounded-r-[4px] bg-match-fill transition-[width] duration-300"
                  style={{ width: pct(dim.score) }}
                />
              </div>

              {dim.reason ? <p className="mt-1 text-xs text-muted">{dim.reason}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Skills                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Matched and missing skills.
 *
 * These wear status colours, so each chip carries an icon and the group carries
 * a heading — the state is never left to hue alone. Long lists collapse rather
 * than truncate: a JD asking for thirty things should say so, but not before
 * the user has seen the seven bars above it.
 */
function Skills({ matched, missing }: { matched: string[]; missing: string[] }) {
  if (matched.length === 0 && missing.length === 0) {
    return (
      <p className="text-sm text-muted">No specific skills were extracted from this description.</p>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <SkillGroup
        title="You have"
        tone="good"
        icon={<CheckIcon />}
        skills={matched}
        empty="None of the listed requirements matched your profile."
      />
      <SkillGroup
        title="Not on your profile"
        tone="warn"
        icon={<PlusIcon />}
        skills={missing}
        empty="Nothing the description asked for is missing."
      />
    </div>
  );
}

function SkillGroup({
  title,
  tone,
  icon,
  skills,
  empty,
}: {
  title: string;
  tone: 'good' | 'warn';
  icon: ReactNode;
  skills: string[];
  empty: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? skills : skills.slice(0, SKILL_PREVIEW);
  const hidden = skills.length - shown.length;

  return (
    <section>
      <h4 className="mb-2 text-xs font-semibold tracking-wide text-faint uppercase">
        {title}
        {skills.length > 0 ? <span className="ml-1 tabular-nums">({skills.length})</span> : null}
      </h4>
      {skills.length === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {shown.map((skill) => (
            <Badge key={skill} tone={tone}>
              {icon}
              {skill}
            </Badge>
          ))}
          {hidden > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setExpanded(true)}>
              +{hidden} more
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/* -------------------------------------------------------------------------- */

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.5 6.4 4.8 8.7 9.5 3.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function DashIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
