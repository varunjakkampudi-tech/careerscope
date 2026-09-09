/**
 * The leads filter rail.
 *
 * One filter column, above/beside everything it scopes — never per-card filters.
 * Every control here writes into the same `LeadFilters` object, which becomes the
 * query string, which becomes the React Query key: change a filter and the table
 * refetches, and the filter state is the single source of truth for what is on
 * screen.
 *
 * Text inputs are debounced locally rather than firing a request per keystroke,
 * but the *committed* value always comes from the parent — so a reset button
 * outside this component still clears the boxes.
 */

import { useEffect, useId, useState } from 'react';
import {
  formatScore,
  LEAD_STATUSES,
  SOURCE_LABELS,
  type LeadPage,
  type LeadStatus,
  type SourceInfo,
} from '@job-radar/shared';
import type { LeadFilters } from '../lib/queries';
import { Button, Checkbox, Field, Input, Select, Slider, cx } from './ui';

/** Long enough that a normal typing burst is one request, short enough to feel live. */
const DEBOUNCE_MS = 350;

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  saved: 'Saved',
  applied: 'Applied',
  interviewing: 'Interviewing',
  rejected: 'Rejected',
  dismissed: 'Dismissed',
};

const POSTED_OPTIONS = [
  { value: '', label: 'Any time' },
  { value: '1', label: 'Last 24 hours' },
  { value: '3', label: 'Last 3 days' },
  { value: '7', label: 'Last week' },
  { value: '14', label: 'Last 2 weeks' },
  { value: '30', label: 'Last 30 days' },
];

const SORT_OPTIONS: { value: LeadFilters['sort']; label: string }[] = [
  { value: 'score', label: 'Match score' },
  { value: 'postedAt', label: 'Date posted' },
  { value: 'salary', label: 'Package' },
  { value: 'company', label: 'Company' },
  { value: 'title', label: 'Role' },
];

export interface FilterRailProps {
  filters: LeadFilters;
  onChange: (next: LeadFilters) => void;
  onReset: () => void;
  sources: SourceInfo[];
  facets?: LeadPage['facets'] | undefined;
  className?: string;
}

export function FilterRail({
  filters,
  onChange,
  onReset,
  sources,
  facets,
  className,
}: FilterRailProps) {
  const filterId = useId();
  const patch = (next: Partial<LeadFilters>) => onChange({ ...filters, ...next });

  const bySource = facets?.bySource ?? {};
  const byStatus = facets?.byStatus ?? {};

  // Only sources that actually produced a lead — a checkbox for a source with
  // zero results is a dead control that only makes the list longer.
  const shownSources = sources.filter(
    (source) => (bySource[source.id] ?? 0) > 0 || filters.sources?.includes(source.id),
  );

  const toggleIn = <T extends string>(list: T[] | undefined, value: T): T[] | undefined => {
    const current = list ?? [];
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value];
    // `undefined` rather than `[]` — an empty array would serialise into the
    // query string as "match nothing", where the intent is "no filter".
    return next.length > 0 ? next : undefined;
  };

  return (
    <div className={cx('flex flex-col gap-6', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">Filters</h2>
        <Button size="sm" variant="ghost" onClick={onReset}>
          Reset
        </Button>
      </div>

      <Slider
        label="Minimum match"
        value={Math.round(filters.minScore * 100)}
        onChange={(value) => patch({ minScore: value / 100 })}
        min={0}
        max={100}
        step={1}
        display={formatScore(filters.minScore)}
        hint="Default is 0%."
      />

      <DebouncedInput
        id={`${filterId}-search`}
        label="Search"
        placeholder="Role, company, or a word in the description"
        value={filters.search ?? ''}
        onCommit={(value) => patch({ search: value || undefined })}
      />

      <fieldset>
        <legend className="mb-2 text-xs font-semibold tracking-wide text-faint uppercase">
          Status
        </legend>
        <div className="flex flex-col gap-2">
          {LEAD_STATUSES.map((status) => (
            <Checkbox
              key={status}
              checked={filters.statuses?.includes(status) ?? false}
              onChange={() => patch({ statuses: toggleIn(filters.statuses, status) })}
              label={
                <span className="flex w-full items-baseline justify-between gap-2">
                  <span>{STATUS_LABELS[status]}</span>
                  <span className="text-xs text-faint tabular-nums">{byStatus[status] ?? 0}</span>
                </span>
              }
            />
          ))}
        </div>
      </fieldset>

      {shownSources.length > 0 ? (
        <fieldset>
          <legend className="mb-2 text-xs font-semibold tracking-wide text-faint uppercase">
            Source
          </legend>
          <div className="flex flex-col gap-2">
            {shownSources.map((source) => (
              <Checkbox
                key={source.id}
                checked={filters.sources?.includes(source.id) ?? false}
                onChange={() => patch({ sources: toggleIn(filters.sources, source.id) })}
                label={
                  <span className="flex w-full items-baseline justify-between gap-2">
                    <span>{SOURCE_LABELS[source.id]}</span>
                    <span className="text-xs text-faint tabular-nums">
                      {bySource[source.id] ?? 0}
                    </span>
                  </span>
                }
              />
            ))}
          </div>
        </fieldset>
      ) : null}

      <DebouncedInput
        id={`${filterId}-location`}
        label="Location"
        placeholder="Bengaluru, Remote…"
        value={filters.location ?? ''}
        onCommit={(value) => patch({ location: value || undefined })}
      />

      <DebouncedInput
        id={`${filterId}-company`}
        label="Company"
        placeholder="Exact or partial name"
        value={filters.company ?? ''}
        onCommit={(value) => patch({ company: value || undefined })}
      />

      <DebouncedInput
        id={`${filterId}-min-salary`}
        label="Minimum package"
        type="number"
        placeholder="e.g. 2000000"
        hint="Annual, in the posting's own currency. Jobs with no disclosed salary are kept."
        value={filters.minSalary == null ? '' : String(filters.minSalary)}
        onCommit={(value) => {
          const parsed = Number(value);
          patch({ minSalary: value && Number.isFinite(parsed) ? parsed : undefined });
        }}
      />

      <Checkbox
        checked={filters.remoteOnly ?? false}
        onChange={(next) => patch({ remoteOnly: next ? true : undefined })}
        label="Remote only"
      />

      <Field label="Posted" htmlFor={`${filterId}-posted`}>
        <Select
          id={`${filterId}-posted`}
          value={filters.postedWithinDays == null ? '' : String(filters.postedWithinDays)}
          onChange={(event) =>
            patch({
              postedWithinDays: event.target.value ? Number(event.target.value) : undefined,
            })
          }
        >
          {POSTED_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Sort by" htmlFor={`${filterId}-sort`}>
          <Select
            id={`${filterId}-sort`}
            value={filters.sort}
            onChange={(event) => patch({ sort: event.target.value as LeadFilters['sort'] })}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Order" htmlFor={`${filterId}-order`}>
          <Select
            id={`${filterId}-order`}
            value={filters.order}
            onChange={(event) => patch({ order: event.target.value as LeadFilters['order'] })}
          >
            <option value="desc">Highest first</option>
            <option value="asc">Lowest first</option>
          </Select>
        </Field>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Debounced text input                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Types locally, commits on a pause.
 *
 * The parent's committed value is adopted during render rather than in an
 * effect, so an external change — reset, back button, a shared link opening —
 * never renders a frame of stale text. The usual alternative, keying the input
 * on `value`, would remount it every time the debounce fires and take the focus
 * with it mid-sentence.
 *
 * `synced` is the last string the two sides agreed on — either one the parent
 * handed down or one this field committed. When the parent's value moves away
 * from it on its own, the draft follows. When it moves because of our own
 * commit, it doesn't: the user may have typed another character in the
 * milliseconds since, and adopting the echo would swallow it.
 */
function DebouncedInput({
  id,
  label,
  hint,
  placeholder,
  type,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  hint?: string;
  placeholder?: string;
  type?: 'text' | 'number';
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);

  if (value !== synced) {
    setSynced(value);
    setDraft(value);
  }

  const commit = (next: string) => {
    setSynced(next);
    onCommit(next);
  };

  useEffect(() => {
    if (draft === value) return;
    const timer = window.setTimeout(() => commit(draft.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // `commit` closes over `onCommit`, which is a fresh closure every render;
    // including it would restart the timer on each parent render and the value
    // would never commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, value]);

  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Input
        id={id}
        type={type ?? 'text'}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(draft.trim());
        }}
      />
    </Field>
  );
}
