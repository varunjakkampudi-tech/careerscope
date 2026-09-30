import type { ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle, LoaderCircle, type LucideIcon } from 'lucide-react';
import styles from './ui-states.module.css';

// CS-13: one shared loading/empty/error treatment for every signed-in route,
// so the product no longer looks different page to page and a screen that
// silently shows nothing is never confused with one still loading. Icon
// choices follow the owner-supplied brand asset sheet's own empty-state
// language (page-designs/) rather than inventing a separate visual system.

// CS-13 rollout, 2026-09-25: the remaining signed-in routes state their
// loading/empty/error conditions *inside* an existing card or list column,
// where the block presentation above (a centred 32px-padded panel with its
// own icon) would visibly restyle a screen that is currently frozen. So each
// component gained a second presentation rather than each route keeping its
// own private one: `variant="inline"` renders exactly the one-line markup
// those call sites render today - the caller's own class, the caller's own
// adjacent action control - while the decision of which element, which ARIA
// role and which shape a state takes now lives in this one module. Nothing
// moves pixel-wise; what moves is ownership.
//
// The props are a discriminated union on purpose: an inline state has no
// title/description pair and no built-in retry button, and the type system
// should say so instead of leaving four ignored props at every call site.

type LoadingStateProps =
  | { variant?: 'block'; message?: string }
  | { variant: 'inline'; message: string; className?: string; icon?: ReactNode };

export function LoadingState(props: LoadingStateProps) {
  if (props.variant === 'inline') {
    return (
      <p className={props.className} role="status">
        {props.icon}
        {props.icon ? ' ' : null}
        {props.message}
      </p>
    );
  }
  return (
    <div className={styles.wrap} role="status">
      <LoaderCircle size={22} className={styles.loadingIcon} aria-hidden="true" />
      <p className={styles.description}>{props.message ?? 'Loading…'}</p>
    </div>
  );
}

// Every error state must say what failed and offer the next action — never a
// bare message a user can't act on.
type ErrorStateProps =
  // CS-13 F-2 (second half): `variant` is optional here, so the block variant
  // is what `<ErrorState message={err.message} />` resolves to — the SHORTER
  // of the two spellings. While `title` was optional with a default of
  // 'Something went wrong', that call compiled cleanly and rendered the
  // canonical example of not saying what failed, over a bare transport
  // message, with no action. F-2 closed that hole for `inline` and left it
  // open on the default path, so the rule stopped being convention for one
  // variant and remained convention for the other.
  //
  // `title` is therefore required and the default is deleted: naming what
  // failed is now unrepresentable to omit on BOTH halves, not just one.
  //
  // `onRetry` stays optional deliberately, and that is a decision rather than
  // an oversight — a terminal error legitimately has nothing to retry, and
  // forcing a no-op handler would be worse than omitting one.
  | { variant?: 'block'; title: string; message: string; onRetry?: () => void }
  // CS-13 F-2: the inline variant took a single unconstrained `message`, so
  // `<ErrorState variant="inline" message={err.message} />` — a bare transport
  // message with no indication of what failed, precisely what AC2 forbids —
  // compiled cleanly. The discriminated union enforced SHAPE, not CONTENT, and
  // the rule was held up by three assertions and per-site discipline rather
  // than by the module the rollout consolidated into.
  //
  // Splitting it makes omitting the "what failed" half UNREPRESENTABLE. Both
  // parts are required: `what` names the operation in the product's own terms,
  // `detail` carries either the underlying error text or the recovery
  // instruction. This would have made F-1 impossible — a screen cannot regress
  // to a bare message without deleting a required prop and failing the build.
  //
  // `what=""` still compiles and collapses to the bare detail. TypeScript
  // cannot express non-empty without branded types, and deliberately typing an
  // empty string is a different act from accidentally omitting a prop.
  // Recorded as known and accepted (CS-13 P3), not silently unnoticed.
  //
  // `action` stays the call site's own existing recovery control, kept as its
  // own element so consolidating an inline error does not restyle the button
  // next to it.
  //
  // `id` is a passthrough so the rendered <p> can be the target of an input's
  // `aria-describedby`. Without it, a form field could not be associated with
  // its own error text, and a call site would have to choose between the
  // contract and the accessible association — which would push exactly the
  // form errors this contract exists for back out to a bare <p>.
  | {
      variant: 'inline';
      what: string;
      detail: string;
      className?: string;
      id?: string;
      action?: ReactNode;
    };

export function ErrorState(props: ErrorStateProps) {
  if (props.variant === 'inline') {
    return (
      <p className={props.className} id={props.id} role="alert">
        {`${props.what} ${props.detail}`.trim()}
        {props.action}
      </p>
    );
  }
  const { title, message, onRetry } = props;
  return (
    <div className={styles.errorWrap} role="alert">
      <AlertTriangle size={22} className={styles.errorIcon} aria-hidden="true" />
      <p className={styles.title}>{title}</p>
      <p className={styles.description}>{message}</p>
      {onRetry && (
        <div className={styles.actionRow}>
          <button type="button" className={styles.retryButton} onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

// The acceptance-criterion distinction: "nothing yet" (a first visit, nothing
// has happened here at all) reads and looks different from "nothing matches
// your filters" (data exists, this view of it is empty) — the same icon/copy
// for both would blur a real, actionable difference.
//
// THIS COMMENT USED TO OPEN WITH "`reason` is the acceptance-criterion
// distinction", naming a prop that has never existed on this type. That was a
// third instance of the F-2 shape: the distinction is real and is asserted in
// check-ui.ts, but nothing in the TYPE carries it. It lives in the free-text
// `title`/`description`/`message` a call site happens to write, so a screen can
// show "Nothing yet" over a filtered-empty list and still compile.
//
// The structural fix — a required `reason: 'nothing-yet' | 'filtered'` that
// drives icon and copy, making the wrong one unrepresentable rather than merely
// discouraged — touches all 16 EmptyState call sites and changes rendered copy,
// so it is its own ticket rather than a drive-by edit under the UI freeze. The
// comment is corrected here so it documents what the code DOES, not what an
// absent prop would have done.

/**
 * Why this view is empty. Required on BOTH variants (CS-62).
 *
 * The ticket originally proposed two values, `nothing-yet` and `filtered`.
 * Reading all 16 call sites before writing the type showed that binary was
 * wrong: "Select a lead.", "No search selected" and "Run a search to see this."
 * are none of the above — they are prompts, not empty results. Forcing them to
 * claim `nothing-yet` would have produced technically-valid props that say the
 * wrong thing, which is the defect wearing a different costume.
 *
 * - `nothing-yet`     nothing has ever been here. A first visit.
 * - `filtered`        data exists; THIS view of it is empty. The user can act
 *                     by changing the filter, and the copy must say so.
 * - `awaiting-input`  nothing is wrong and nothing is missing; the user has not
 *                     chosen or run anything yet.
 *
 * It is rendered as `data-empty-reason` and drives NO visual difference today.
 * That is deliberate under the UI freeze: making it drive icon and copy changes
 * rendered output, which is out of bounds. What it buys now is that every call
 * site must DECLARE which case it is, the declaration is checkable by tests
 * rather than by reading prose, and a later change can drive presentation from
 * a value that is already correct everywhere.
 */
export type EmptyReason = 'nothing-yet' | 'filtered' | 'awaiting-input';

type EmptyStateProps =
  | {
      variant?: 'block';
      reason: EmptyReason;
      icon: LucideIcon;
      title: string;
      description: string;
      action?: { label: string; href?: string; onClick?: () => void } | ReactNode;
    }
  // CS-62: `reason` is required on this variant too, and THAT is the part the
  // type enforces — an inline call site cannot omit the discriminator any more
  // than a block one can.
  //
  // What the type does NOT enforce is the wording of `message`. An earlier
  // version of this comment asserted that a call site empty because of a
  // filter "must say so there", which reads as a rule while being a
  // convention no compiler can check: `message` is free text, and nothing
  // relates its content to `reason`. The claim is recorded as unenforced
  // rather than deleted, because deleting it would hide that the gap exists
  // — a reviewer would otherwise assume the enforcement extends to the copy.
  // If that correspondence is ever needed, it has to come from a closed set
  // of messages, not from a comment.
  //
  // `announce` keeps the call sites that already publish their empty result
  // to assistive technology (role="status") doing exactly that, instead of
  // the rollout silently removing a live region.
  | {
      variant: 'inline';
      reason: EmptyReason;
      message: string;
      className?: string;
      announce?: boolean;
    };

export function EmptyState(props: EmptyStateProps) {
  if (props.variant === 'inline') {
    return (
      <p
        className={props.className}
        data-empty-reason={props.reason}
        role={props.announce ? 'status' : undefined}
      >
        {props.message}
      </p>
    );
  }
  const { icon: Icon, title, description, action } = props;
  return (
    <div className={styles.wrap} data-empty-reason={props.reason}>
      <Icon size={28} className={styles.emptyIcon} aria-hidden="true" />
      <p className={styles.title}>{title}</p>
      <p className={styles.description}>{description}</p>
      {action &&
        (isActionDescriptor(action) ? (
          <div className={styles.actionRow}>
            {action.href ? (
              <Link href={action.href} className={styles.actionLink}>
                {action.label}
              </Link>
            ) : (
              <button type="button" className={styles.actionLink} onClick={action.onClick}>
                {action.label}
              </button>
            )}
          </div>
        ) : (
          <div className={styles.actionRow}>{action}</div>
        ))}
    </div>
  );
}

function isActionDescriptor(
  value: unknown,
): value is { label: string; href?: string; onClick?: () => void } {
  return typeof value === 'object' && value !== null && 'label' in value;
}
