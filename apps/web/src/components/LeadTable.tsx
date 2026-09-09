/**
 * The leads table.
 *
 * ## Why this isn't a `<table>`, and isn't TanStack Table
 *
 * Sorting, filtering and pagination all happen on the server — `sort`, `order`
 * and every predicate live in the query string. A table library's state would
 * therefore only mirror query params it doesn't own, and row selection here is a
 * `Set<string>`. What the screen genuinely needs is virtualization over a list
 * that can run to hundreds of rows, which `@tanstack/react-virtual` does without
 * a column model.
 *
 * A real `<table>` is also awkward to virtualize: rows have to be absolutely
 * positioned inside `<tbody>`, which browsers render inconsistently. So this is a
 * CSS grid carrying explicit ARIA table roles — same semantics for a screen
 * reader, no layout fight — and below `md` the same rows re-flow as cards, where
 * nine columns would be unreadable anyway.
 *
 * The role nesting is load-bearing: `table > rowgroup > row > cell` with no
 * generic `<div>` in between, because an intervening element breaks the required
 * ownership chain and the whole thing degrades to a pile of unlabelled text. The
 * virtualizer's sizer element *is* the second rowgroup, and the footer sits
 * outside the table entirely.
 *
 * ## It virtualizes the window, not a box of its own
 *
 * This used to own a `flex-1 overflow-y-auto` scroller. It never scrolled. Every
 * ancestor up to the page root is sized with `min-h-*`, which is a floor and not
 * a cap, so the column resolved to its content's full height and the scroller's
 * `clientHeight` equalled its `scrollHeight` — measured at 9871px for 162 leads.
 *
 * A virtualizer sizes its window from that `clientHeight`, so the window covered
 * the entire list and all 162 rows rendered on first paint: virtualization was
 * doing measurement work and buying nothing. Worse, the prefetch below reads the
 * tail off the virtualizer, and a tail that is permanently in view means *every*
 * page is fetched on mount — N sequential requests at page load, and a footer
 * reading "End of the list" before the user has touched anything.
 *
 * Bounding the height instead would mean `dvh` arithmetic against the app header
 * that breaks the moment that header changes. The page had also already committed
 * to window scrolling — the filter rail beside this table is `lg:sticky`, which
 * only means anything when the *window* is the scrollport. So the window is the
 * scrollport here too, and the private scroller is gone rather than propped up.
 *
 * `scrollMargin` is what makes that work: the virtualizer returns positions in
 * document coordinates, so each row is placed at `item.start - scrollMargin`.
 *
 * ## Cards vs columns is a container query, not a media query
 *
 * The nine-column grid only exists above `--container-table`, measured against
 * *this table's* width rather than the window's. That is the width that actually
 * constrains it: opening the detail drawer takes ~520px out of the row, and at
 * 1440px the remaining ~600px collapsed every `minmax(0, …)` track toward zero —
 * body cells truncated to two characters and the header labels, which have no
 * track to be clipped by, painted straight over one another.
 *
 * A viewport query cannot see that, because the viewport did not change. The
 * same query also covers the phone case the old `md:` covered, so this is a
 * strict replacement rather than a second rule layered on top.
 *
 * ## Reading a row
 *
 * The match score is text first with a meter under it; nothing here is encoded in
 * colour alone. Every row names its source, which is both a provenance signal and
 * an attribution requirement for the boards that ask for one.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { ExternalLink, Globe } from 'lucide-react';
import {
  formatRelativeDate,
  formatSalary,
  SOURCE_LABELS,
  type Lead,
  type LeadStatus,
} from '@job-radar/shared';
import { MatchScore } from './MatchMeter';
import { Badge, Spinner, cx } from './ui';
import type { LeadFilters } from '../lib/queries';

/**
 * What an unmeasured row is assumed to be tall.
 *
 * Real heights come from `measureElement`, but only for rows that have actually
 * been rendered — every row past the window is still the estimate, and the
 * document's height is `count × estimate` until it is scrolled through. So the
 * estimate is not cosmetic: get it wrong and the page grows or shrinks under the
 * scroll thumb on every step, which is exactly what an 80 here used to do.
 *
 * Both numbers are the measured mean over all 162 leads in the local database,
 * taken by scrolling the whole list and collecting `getBoundingClientRect`. Each
 * has exactly two values — 55/63 desktop, 221/239 card — differing by the one
 * optional line, the tech-stack row, in a 51/111 split. Every cell truncates, so
 * neither depends on the viewport width; re-measure only if a row gains a line.
 */
const ROW_ESTIMATE = 61;
const CARD_ESTIMATE = 233;

/** Load the next page once the tail is this close. */
const PREFETCH_ROWS = 6;

/**
 * Below this the rows are cards, above it they are a nine-column grid.
 *
 * The CSS side of the same decision is `--container-table` in `index.css`, and
 * the two numbers have to stay equal — this one only picks which estimate seeds
 * an unmeasured row, so a disagreement seeds cards with a row's height and the
 * document's length is out by a factor of four until it is scrolled through.
 */
const COMPACT_WIDTH = 768;

/**
 * The nine column tracks, as a raw CSS value rather than a Tailwind class.
 *
 * Tailwind finds utilities by scanning source text, so `md:${GRID}` would
 * generate nothing. The alternative — writing the same arbitrary-value class out
 * twice, once bare for the header and once `md:`-prefixed for the rows — is two
 * copies that will drift. An inline `grid-template-columns` is one source of
 * truth, ignored while the element is `display: flex` on a phone.
 */
const COLUMN_TRACKS =
  '32px 80px minmax(0, 2.2fr) minmax(0, 1.3fr) 58px minmax(0, 1fr) minmax(0, 1fr) 80px 65px 90px';

const STATUS_TONE: Record<LeadStatus, 'neutral' | 'accent' | 'good' | 'warn' | 'bad'> = {
  new: 'accent',
  saved: 'neutral',
  applied: 'good',
  interviewing: 'good',
  rejected: 'bad',
  dismissed: 'neutral',
};

const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New',
  saved: 'Saved',
  applied: 'Applied',
  interviewing: 'Interviewing',
  rejected: 'Rejected',
  dismissed: 'Dismissed',
};

type SortField = LeadFilters['sort'];

/** Column order, and which of them the server can sort by. */
const COLUMNS: { key: string; label: string; sort?: SortField; className?: string }[] = [
  { key: 'select', label: '' },
  { key: 'match', label: 'Match', sort: 'score' },
  { key: 'role', label: 'Role', sort: 'title' },
  { key: 'company', label: 'Company', sort: 'company' },
  { key: 'careers', label: 'Links' },
  { key: 'package', label: 'Package', sort: 'salary' },
  { key: 'location', label: 'Location' },
  { key: 'source', label: 'Source' },
  { key: 'posted', label: 'Posted', sort: 'postedAt' },
  { key: 'status', label: 'Status', className: 'text-right' },
];

export interface LeadTableProps {
  leads: Lead[];
  /** Drawn as a tick on every meter, so "did this clear my bar" reads per row. */
  threshold: number;
  activeId: string | null;
  selection: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  sort: SortField;
  order: LeadFilters['order'];
  /** Same field again means "flip the order" — the parent decides that. */
  onSort: (field: SortField) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  /** Dimmed during a refetch — no skeleton flash, no layout jump. */
  isRefetching?: boolean;
  className?: string;
}

export function LeadTable({
  leads,
  threshold,
  activeId,
  selection,
  onOpen,
  onToggleSelect,
  onToggleSelectAll,
  sort,
  order,
  onSort,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  isRefetching = false,
  className,
}: LeadTableProps) {
  const list = useRef<HTMLDivElement>(null);
  const scrollMargin = useScrollMargin(list);
  const compact = useWidth(list) < COMPACT_WIDTH;

  const virtualizer = useWindowVirtualizer<HTMLDivElement>({
    count: leads.length,
    estimateSize: () => (compact ? CARD_ESTIMATE : ROW_ESTIMATE),
    overscan: 8,
    scrollMargin,
  });

  // Crossing the breakpoint invalidates every height the virtualizer holds, not
  // just the estimates: a row that measured 63px as a grid cell is 239px as a
  // card. `measure()` is the only thing that clears that cache — and it has to be
  // called, because the width is 0 until the first layout effect, so even a plain
  // mount on a desktop crosses the boundary once.
  const layout = useRef(compact);
  useLayoutEffect(() => {
    if (layout.current === compact) return;
    layout.current = compact;
    virtualizer.measure();
  }, [compact, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1];
  const lastIndex = last?.index;

  // Fetch the next page when the tail comes into view. Reading it off the
  // virtualizer rather than an IntersectionObserver sentinel means it also fires
  // during a fast flick, when a sentinel would be scrolled straight past.
  useEffect(() => {
    if (lastIndex === undefined || !hasNextPage || isFetchingNextPage) return;
    if (lastIndex >= leads.length - PREFETCH_ROWS) onLoadMore();
  }, [lastIndex, hasNextPage, isFetchingNextPage, leads.length, onLoadMore]);

  const allSelected = leads.length > 0 && leads.every((lead) => selection.has(lead.id));

  return (
    <div className={cx('@container flex flex-col', className)}>
      <div
        role="table"
        aria-label="Job leads"
        // -1 is the ARIA convention for "more rows exist than are loaded",
        // which is exactly true while another page is still fetchable.
        aria-rowcount={hasNextPage ? -1 : leads.length + 1}
        className={cx('motion-safe-only transition-opacity', isRefetching && 'opacity-60')}
      >
        {/* Header. Sticky to the window, and hidden on cards — there is no
            column to head there, and sorting lives in the filter rail.

            It pins *below* the app header rather than at 0, or it would slide
            behind a translucent bar and smear through the backdrop blur. The
            offset is the one token both elements read, plus that bar's 1px
            bottom border, which is the only place the border is accounted for.

            `rounded-t-card` because the card around this table is rounded and
            nothing clips this element — a square background would overpaint the
            card's own top corners and nick the border. Rows carry no background
            of their own, so the two notches this leaves are invisible except
            under a hovered row. */}
        <div
          role="rowgroup"
          className="sticky top-[calc(var(--spacing-app-header)+1px)] z-10 hidden rounded-t-card bg-surface @table:block"
        >
          <div
            role="row"
            aria-rowindex={1}
            style={{ gridTemplateColumns: COLUMN_TRACKS }}
            className="grid items-center gap-x-3 border-b border-border px-3 py-2 text-xs font-medium text-faint"
          >
            <span role="columnheader" className="flex items-center">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleSelectAll}
                disabled={leads.length === 0}
                className="h-4 w-4 accent-accent"
                aria-label={allSelected ? 'Clear selection' : 'Select all loaded leads'}
              />
            </span>

            {COLUMNS.slice(1).map((column) => (
              <span
                key={column.key}
                role="columnheader"
                aria-sort={
                  column.sort === undefined
                    ? undefined
                    : sort === column.sort
                      ? order === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                }
                // The tracks are `minmax(0, …)`, so a squeezed grid shrinks them
                // to nothing. A body cell truncates and degrades gracefully; a
                // header label has nothing clipping it and paints straight over
                // its neighbour. Clip it here so the failure mode is a label cut
                // short rather than two labels on top of each other.
                className={cx('overflow-hidden', column.className)}
              >
                {column.sort ? (
                  <SortButton
                    label={column.label}
                    active={sort === column.sort}
                    order={order}
                    onClick={() => onSort(column.sort as SortField)}
                  />
                ) : (
                  column.label
                )}
              </span>
            ))}
          </div>
        </div>

        {/* The virtualizer's sizer *is* the body rowgroup, and it is also what
            `scrollMargin` is measured from — the two have to be the same element
            or every row is drawn the header's height out of place. */}
        <div
          role="rowgroup"
          ref={list}
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {items.map((item) => {
            const lead = leads[item.index];
            if (!lead) return null;
            return (
              <Row
                key={lead.id}
                lead={lead}
                index={item.index}
                offset={item.start - scrollMargin}
                innerRef={virtualizer.measureElement}
                threshold={threshold}
                active={lead.id === activeId}
                selected={selection.has(lead.id)}
                onOpen={onOpen}
                onToggleSelect={onToggleSelect}
              />
            );
          })}
        </div>
      </div>

      {/* Outside the table: a spinner is not a row, and claiming it is one
          makes the row count wrong for anyone reading by keyboard. */}
      {isFetchingNextPage ? (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} />
          Loading more leads…
        </div>
      ) : null}

      {!hasNextPage && leads.length > 0 ? (
        <p className="py-4 text-center text-xs text-faint">
          End of the list — {leads.length.toLocaleString()} leads.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The list's distance from the top of the document.
 *
 * A window virtualizer positions rows in document coordinates, so it has to know
 * where the list starts. That offset is not a constant here: the skill-gap panel
 * above the table is a `<details>` the user can expand, and the bulk-action bar
 * appears the moment a row is ticked. A `<details>` toggle is a native DOM event
 * that causes no React render, so a one-shot measurement in a layout effect goes
 * stale and every row is then drawn that many pixels out of place.
 *
 * A `ResizeObserver` on the body catches all of it — the toggle, the bulk bar, a
 * window resize, a late-loading font — because each one changes the document's
 * height or width. `getBoundingClientRect` rather than `offsetTop`, because
 * `offsetTop` is relative to the nearest positioned ancestor and a `relative`
 * wrapper appearing anywhere above this would silently zero it out.
 */
function useScrollMargin(ref: RefObject<HTMLElement | null>): number {
  const [margin, setMargin] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => setMargin(element.getBoundingClientRect().top + window.scrollY);

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [ref]);

  return margin;
}

/**
 * The list's own width, which is what decides cards vs columns.
 *
 * The CSS makes that decision with a container query and never needs a number in
 * JS — but the virtualizer does, because a card and a row are four times apart in
 * height and it has to seed an unmeasured row with one of them.
 *
 * The first read is synchronous inside the layout effect rather than left to the
 * observer's first delivery. That delivery is a separate task, so a render would
 * commit at width 0 — and `virtual-core` memoises its measurements on the size
 * cache, not on `estimateSize`, so a whole list sized at the wrong estimate stays
 * that way until each row is individually measured. Measured on load, that was a
 * document 1450px short that snapped to the right length on the first scroll.
 *
 * Kept separate from `useScrollMargin` deliberately: this one reads `contentRect`
 * off the observer entry, which the browser has already computed, so the hot path
 * forces no layout. And because the sizer's height changes on every scroll step
 * this observer fires constantly — hence the equality guard, without which each
 * step would re-render the whole list.
 */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = (next: number) => setWidth((previous) => (previous === next ? previous : next));

    update(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => update(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

function SortButton({
  label,
  active,
  order,
  onClick,
}: {
  label: string;
  active: boolean;
  order: 'asc' | 'desc';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx('flex items-center gap-1 hover:text-ink', active && 'text-ink')}
    >
      {label}
      {active ? <span aria-hidden="true">{order === 'asc' ? '↑' : '↓'}</span> : null}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Row                                                                        */
/* -------------------------------------------------------------------------- */

interface RowProps {
  lead: Lead;
  index: number;
  offset: number;
  /** `virtualizer.measureElement`, so this row reports its real height. */
  innerRef: (node: HTMLDivElement | null) => void;
  threshold: number;
  active: boolean;
  selected: boolean;
  onOpen: (id: string) => void;
  onToggleSelect: (id: string) => void;
}

/**
 * One lead.
 *
 * The row is clickable for the mouse, but the keyboard path is the role title
 * rendered as a real `<button>` — a `role="row"` is not an interactive element,
 * and giving it a tabindex and an Enter handler produces a control that screen
 * readers announce as a table row and users cannot identify.
 */
function Row({
  lead,
  index,
  offset,
  innerRef,
  threshold,
  active,
  selected,
  onOpen,
  onToggleSelect,
}: RowProps) {
  const { job } = lead;
  const careersUrl = job.company.careersUrl || job.company.atsPortalUrl;
  const location = job.location.trim();
  const undisclosed =
    job.salary.annualMin === null && job.salary.annualMax === null && !job.salary.raw;

  return (
    // The click handler below is a pointer affordance only — the keyboard path
    // into a lead is the title, rendered as a real `<button>` further down. Both
    // rules want a tabindex and an Enter handler on the row itself; that would
    // add a second tab stop per row which screen readers announce as "row" and
    // users cannot act on, and it would not replace the button, so every lead
    // would cost two tabs to pass. This is the ARIA grid pattern: the row is not
    // the tab stop, the control inside a cell is.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus
    <div
      role="row"
      // +2: the header is row 1, and `index` is zero-based.
      aria-rowindex={index + 2}
      aria-current={active ? 'true' : undefined}
      data-index={index}
      ref={innerRef}
      onClick={() => onOpen(lead.id)}
      style={{ transform: `translateY(${offset}px)`, gridTemplateColumns: COLUMN_TRACKS }}
      className={cx(
        'absolute top-0 left-0 w-full cursor-pointer border-b border-border px-3 py-3 text-sm',
        'flex flex-col gap-1.5 @table:grid @table:items-center @table:gap-x-3 @table:gap-y-0',
        // In card mode there is no header, so this row is what sits flush against
        // the surrounding card's rounded top corners — and a selected or hovered
        // row is an opaque square that would paint straight into them. Nothing
        // clips it: the card cannot be `overflow-hidden` without becoming a scroll
        // container, which is what the sticky header offsets itself against.
        index === 0 && 'rounded-t-card @table:rounded-none',
        active ? 'bg-accent-soft' : 'hover:bg-canvas',
      )}
    >
      {/* Desktop selection cell. On a card the checkbox rides alongside the
          score instead, where it is reachable with a thumb. */}
      <span role="cell" className="hidden @table:flex @table:items-center">
        <SelectBox lead={lead} selected={selected} onToggleSelect={onToggleSelect} />
      </span>

      <span role="cell" className="flex items-center gap-3 @table:block">
        <span className="@table:hidden">
          <SelectBox lead={lead} selected={selected} onToggleSelect={onToggleSelect} />
        </span>
        <MatchScore
          score={lead.match.score}
          threshold={threshold}
          confidence={lead.match.confidence}
        />
      </span>

      <span role="cell" className="block min-w-0">
        <button
          type="button"
          onClick={(event) => {
            // The row handler would fire too and open it twice.
            event.stopPropagation();
            onOpen(lead.id);
          }}
          title={job.title}
          className="block w-full truncate text-left font-medium text-ink hover:text-accent"
        >
          {job.title}
        </button>
        <span className="block truncate text-xs text-muted @table:hidden">{job.company.name}</span>
        {job.techStack.length > 0 ? (
          <span
            className="mt-0.5 block truncate text-xs text-faint"
            title={job.techStack.join(', ')}
          >
            {job.techStack.slice(0, 6).join(' · ')}
          </span>
        ) : null}
      </span>

      <span
        role="cell"
        className="hidden min-w-0 truncate text-ink @table:block"
        title={job.company.name}
      >
        {job.company.name}
      </span>

      <span role="cell" className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-faint">
        {job.company.website ? (
          <a
            href={job.company.website}
            target="_blank"
            rel="noopener noreferrer"
            title={`${job.company.name} website`}
            aria-label={`${job.company.name} website`}
            className="inline-flex min-h-6 min-w-6 items-center gap-1 text-accent hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            <Globe size={16} aria-hidden="true" />
            <span className="@table:hidden">Website</span>
          </a>
        ) : (
          <span className="@table:hidden">Website: Unknown</span>
        )}
        {careersUrl ? (
          <a
            href={careersUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={`${job.company.name} careers`}
            aria-label={`${job.company.name} careers`}
            className="inline-flex min-h-6 min-w-6 items-center gap-1 text-accent hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            <ExternalLink size={16} aria-hidden="true" />
            <span className="@table:hidden">Careers</span>
          </a>
        ) : (
          <span title="Company careers page not verified">
            <span className="@table:hidden">Careers: </span>Unknown
          </span>
        )}
      </span>

      <span role="cell" className="block min-w-0 truncate">
        <span className="text-xs text-faint @table:hidden">Package: </span>
        <span className={undisclosed ? 'text-faint' : 'text-ink'}>{formatSalary(job.salary)}</span>
      </span>

      <span role="cell" className="block min-w-0 truncate" title={location || undefined}>
        <span className="text-xs text-faint @table:hidden">Location: </span>
        <span className="text-muted">{location || (job.isRemote ? 'Remote' : '—')}</span>
        {job.isRemote && location ? (
          <span className="ml-1 text-xs text-accent">· Remote</span>
        ) : null}
      </span>

      <span role="cell" className="block min-w-0 truncate text-xs text-muted">
        {SOURCE_LABELS[job.source]}
        {/* Named, never implied: JSearch surfacing a LinkedIn posting is not the
            same claim as this app having crawled LinkedIn. */}
        {job.sourcePublisher ? (
          <span className="text-faint"> · via {job.sourcePublisher}</span>
        ) : null}
      </span>

      <span role="cell" className="block text-xs text-faint">
        <span className="@table:hidden">Posted: </span>
        {formatRelativeDate(job.postedAt) || '—'}
      </span>

      <span role="cell" className="block @table:text-right">
        <Badge tone={STATUS_TONE[lead.status]}>{STATUS_LABEL[lead.status]}</Badge>
      </span>
    </div>
  );
}

function SelectBox({
  lead,
  selected,
  onToggleSelect,
}: {
  lead: Lead;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  return (
    <input
      type="checkbox"
      checked={selected}
      onChange={() => onToggleSelect(lead.id)}
      // Without this the row's own handler opens the drawer on every tick.
      onClick={(event) => event.stopPropagation()}
      className="h-4 w-4 accent-accent"
      aria-label={`Select ${lead.job.title} at ${lead.job.company.name}`}
    />
  );
}
