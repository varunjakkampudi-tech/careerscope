/**
 * What the near misses keep asking for.
 *
 * The leads table answers "which jobs matched?". Sorting it every possible way
 * still cannot answer "what is the one thing standing between me and the jobs I
 * nearly got", because that answer is not in any single row — it is the shape of
 * the `missingSkills` lists taken together.
 *
 * ## It describes; it does not predict
 *
 * The panel says "Kafka was demanded by 9 of your 14 near misses". It never says
 * "learn Kafka and those 9 convert". That second claim needs the scorer re-run
 * against a counterfactual resume, and asserting it without doing so would be
 * the kind of confident guess the rest of this app refuses to make — the same
 * reason a careers address is only ever shown when a real `mailto:` was found.
 *
 * ## Why a `<details>`
 *
 * Vertical space above the table is the most expensive space on the screen. The
 * summary line carries the finding in words, so the insight costs one line and
 * reading the evidence is opt-in. `<details>` is also keyboard-operable and
 * screen-reader-announced for free, which a div with an `onClick` is not.
 *
 * ## Colour
 *
 * There is none that is new. This is a magnitude ranking in one unit — leads —
 * so it reuses the single-hue `match-fill`/`match-track` pair the meters already
 * use (validated in `index.css`). Length carries the value and every bar prints
 * its own counts as text beside it. Colouring each bar by its own value would
 * spend a channel restating the bar.
 *
 * ## Why the bar is nested rather than plain
 *
 * The rows are ordered `near DESC, total DESC`. A plain bar showing only near
 * misses makes that second key invisible, and with a thin near-miss set — four
 * leads, giving counts of 3, 2, 1, 1, 1, 1, 1, 1 — you get eight identical bars
 * in a visibly deliberate order, which reads as a broken chart. Worse, the
 * full-width track behind each bar *looked* like a channel while carrying
 * nothing.
 *
 * So the track carries `totalCount` and the fill carries `nearMissCount`, both
 * on one scale. This is legitimate because they are nested measures of the same
 * unit — `nearMissCount ≤ totalCount` by construction, so the fill can never
 * escape its track — and not a second axis. The dark fill stays the salient
 * mark, because near misses remain the measure that matters; the light extent is
 * context, and it is what explains why Java outranks Kubernetes.
 *
 * When nothing is a near miss the API ranks by `total` instead and every
 * `nearMissCount` is zero, so fill and track coincide and the bar renders solid
 * — the same plain bar as before, with no special case in the render.
 */

import { formatScore, type SkillGap, type SkillGapEntry } from '@job-radar/shared';
import { Badge, Skeleton, cx } from './ui';

export interface SkillGapPanelProps {
  data: SkillGap;
  /** Puts the skill into the table's free-text filter. */
  onPickSkill: (skill: string) => void;
  className?: string;
}

export function SkillGapPanel({ data, onPickSkill, className }: SkillGapPanelProps) {
  // Nothing to say beats saying nothing at length. A fresh install has no leads
  // and an empty panel here would just be furniture above an empty table.
  if (data.gaps.length === 0) return null;

  const bandLabel = `${formatScore(data.nearMissFloor)}–${formatScore(data.threshold)}`;

  // One scale for both marks, so a length means the same thing on every row.
  // `totalCount` is the larger of the two by construction, so it sets the scale.
  const scale = Math.max(...data.gaps.map((gap) => gap.totalCount), 1);

  return (
    <details className={cx('group rounded-lg border border-border bg-surface', className)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm text-ink">
        <Chevron />
        <span className="min-w-0 flex-1 text-wrap-anywhere">
          <span className="font-medium">{headline(data)}</span>{' '}
          <span className="text-muted">
            {data.nearMissLeads > 0
              ? `across ${data.nearMissLeads.toLocaleString()} ${
                  data.nearMissLeads === 1 ? 'lead' : 'leads'
                } scoring ${bandLabel}.`
              : `— nothing scored ${bandLabel}, so this ranks every lead instead.`}
          </span>
        </span>
        <span className="shrink-0 text-xs text-faint group-open:hidden">Show</span>
      </summary>

      <div className="border-t border-border px-3 py-3.5">
        <section>
          <h2 className="mb-2.5 text-xs font-semibold tracking-wide text-faint uppercase">
            Most asked for, least often found
          </h2>
          <ul className="flex flex-col gap-2">
            {data.gaps.map((gap) => (
              <li key={gap.skill}>
                <GapRow gap={gap} scale={scale} onPick={() => onPickSkill(gap.skill)} />
              </li>
            ))}
          </ul>
        </section>

        {data.strengths.length > 0 ? (
          <section className="mt-4">
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-faint uppercase">
              What your leads already credit you with
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {data.strengths.map((strength) => (
                <Badge key={strength.skill} tone="good">
                  <CheckIcon />
                  {strength.skill}
                  <span className="tabular-nums opacity-70">{strength.totalCount}</span>
                </Badge>
              ))}
            </div>
          </section>
        ) : null}

        <p className="mt-4 border-t border-border pt-3 text-xs text-muted">
          Counted over {data.totalLeads.toLocaleString()} leads. Dismissed leads, leads rejected by
          a hard filter, and leads scored from a snippet rather than a full description are left out
          — their missing-skill lists say more about the source than about you. This is a tally of
          what was asked for, not a prediction that learning any of it would clear your bar.
        </p>
      </div>
    </details>
  );
}

/* -------------------------------------------------------------------------- */
/* The space it will occupy                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The panel's collapsed height, held from the first paint.
 *
 * The gaps are their own query, so they resolve after the leads have painted —
 * and this panel sits *above* the table, so mounting it late pushes the entire
 * list down. Measured on the real `/leads`, that single 54px push was a 0.118
 * cumulative layout shift on its own: the whole of the page's CLS, and past the
 * 0.1 threshold by itself.
 *
 * The reservation is built out of the summary row's own padding and type scale
 * rather than a hard-coded height, so it tracks the real thing if either
 * changes: `py-2.5` twice, a `text-sm` line box, and the 1px border.
 *
 * It is `aria-hidden` because it says nothing — a screen reader announcing a
 * placeholder is worse than it announcing nothing and then the panel.
 */
export function SkillGapPanelSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cx('rounded-lg border border-border bg-surface px-3 py-2.5', className)}
    >
      <Skeleton className="h-5 w-96 max-w-full" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One ranked bar                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The bar is `aria-hidden`; the counts beside it are the accessible view, so
 * nothing here is readable only by looking at a length or a hue.
 *
 * The whole row is a button because the useful next move is always the same —
 * see the leads in question — and it is a filter the table already supports.
 */
function GapRow({ gap, scale, onPick }: { gap: SkillGapEntry; scale: number; onPick: () => void }) {
  // A count of one has to be visible, so it gets a floor. Zero keeps zero
  // width — a sliver where there is nothing would claim a near miss that the
  // text beside it correctly denies.
  const width = (value: number) => (value <= 0 ? 0 : Math.max(2, (value / scale) * 100));

  return (
    <button
      type="button"
      onClick={onPick}
      className="w-full rounded-md px-1.5 py-1 text-left hover:bg-canvas focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      title={`Filter the table to leads mentioning ${gap.skill}`}
    >
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium text-ink">{gap.skill}</span>
        <span className="shrink-0 text-xs text-muted tabular-nums">
          {gap.nearMissCount > 0
            ? `${gap.nearMissCount} near ${gap.nearMissCount === 1 ? 'miss' : 'misses'}`
            : `${gap.totalCount} ${gap.totalCount === 1 ? 'lead' : 'leads'}`}
          {gap.nearMissCount > 0 ? (
            <span className="text-faint"> · {gap.totalCount} overall</span>
          ) : null}
        </span>
      </div>

      {/* Two marks, one baseline, one scale. The fill is drawn over the track
          rather than inside it, so both are measured from the same origin and
          neither can be a percentage of the other. */}
      <div className="relative mt-1 h-2 w-full" aria-hidden="true">
        <div
          className="motion-safe-only absolute inset-y-0 left-0 rounded-[4px] bg-match-track transition-[width] duration-300"
          style={{ width: `${width(gap.totalCount)}%` }}
        />
        <div
          className="motion-safe-only absolute inset-y-0 left-0 rounded-[4px] bg-match-fill transition-[width] duration-300"
          style={{ width: `${width(gap.nearMissCount)}%` }}
        />
      </div>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The finding, in words, in the collapsed state.
 *
 * Three names at most. A summary line that lists twelve skills is a list, and
 * the user already has one of those below.
 */
function headline(data: SkillGap): string {
  const names = data.gaps.slice(0, 3).map((gap) => gap.skill);
  const listed =
    names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return `${listed} ${names.length === 1 ? 'is' : 'are'} what you are missing most`;
}

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/* -------------------------------------------------------------------------- */

function Chevron() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className="motion-safe-only shrink-0 text-faint transition-transform group-open:rotate-90"
    >
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
