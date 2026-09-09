/**
 * Choosing where to search.
 *
 * Sources are grouped by *what kind of result they give you*, not alphabetically,
 * because that is the axis the choice actually turns on: an ATS board returns the
 * employer's own posting with the full description and a direct apply link, while
 * an aggregator returns a snippet and a redirect. Sorting the two together would
 * hide the only distinction that matters.
 *
 * A source this install cannot run is rendered disabled with the reason attached
 * rather than hidden. Hiding it makes a missing API key look like a missing
 * feature, and the user never learns there is a switch to flip. The reason text
 * comes from the provider and names the environment variable — never its value.
 */

import { SNIPPET_ONLY_SOURCES, type SourceId, type SourceInfo } from '@job-radar/shared';
import { Badge, Button, Checkbox, cx } from './ui';

interface Group {
  kind: SourceInfo['kind'];
  title: string;
  blurb: string;
}

/**
 * Best-quality first. The order is a recommendation in itself — the boards at
 * the top need no configuration and return complete postings, so a user who
 * only ticks the first group still gets a working search.
 */
const GROUPS: Group[] = [
  {
    kind: 'email',
    title: 'Job-alert emails',
    blurb: '',
  },
  {
    kind: 'ats',
    title: 'Company job boards',
    blurb:
      'The employer’s own posting, straight from their applicant tracking system — full description, direct apply link, no key required. These produce the best matches.',
  },
  {
    kind: 'remote',
    title: 'Remote boards',
    blurb: 'Remote-first listings with full descriptions. No key required.',
  },
  {
    kind: 'api',
    title: 'Aggregators',
    blurb:
      'API credentials required. Aggregators may include LinkedIn and Indeed postings; availability and coverage depend on the provider and plan. Each lead names its reported publisher.',
  },
  {
    kind: 'scrape',
    title: 'Browser scrapers',
    blurb:
      'Drives a real browser against sites with no public API. Slower and more fragile than everything above, and off unless the server was started with ENABLE_SCRAPERS=true.',
  },
];

export interface SourcePickerProps {
  sources: SourceInfo[];
  value: SourceId[];
  onChange: (next: SourceId[]) => void;
  disabled?: boolean;
  className?: string;
}

export function SourcePicker({
  sources,
  value,
  onChange,
  disabled = false,
  className,
}: SourcePickerProps) {
  const selected = new Set(value);

  const toggle = (id: SourceId, next: boolean) => {
    const draft = new Set(selected);
    if (next) draft.add(id);
    else draft.delete(id);
    // Preserve the catalogue's order rather than click order, so the value is
    // stable across re-renders and comparable between runs.
    onChange(sources.filter((source) => draft.has(source.id)).map((source) => source.id));
  };

  const setMany = (ids: SourceId[], next: boolean) => {
    const draft = new Set(selected);
    for (const id of ids) {
      if (next) draft.add(id);
      else draft.delete(id);
    }
    onChange(sources.filter((source) => draft.has(source.id)).map((source) => source.id));
  };

  return (
    <div className={cx('flex flex-col gap-6', className)}>
      {GROUPS.map((group) => {
        const members = sources.filter((source) => source.kind === group.kind);
        if (members.length === 0) return null;

        const available = members.filter((source) => source.enabled);
        const chosen = members.filter((source) => selected.has(source.id));
        const allChosen = available.length > 0 && chosen.length === available.length;

        return (
          <section key={group.kind}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h3 className="text-sm font-semibold text-ink">
                {group.title}
                <span className="ml-2 text-xs font-normal text-faint tabular-nums">
                  {chosen.length}/{members.length}
                </span>
              </h3>
              {available.length > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    setMany(
                      available.map((source) => source.id),
                      !allChosen,
                    )
                  }
                >
                  {allChosen ? 'Clear group' : 'Select all available'}
                </Button>
              ) : null}
            </div>

            {group.blurb ? (
              <p className="mt-0.5 mb-3 max-w-2xl text-xs text-muted">{group.blurb}</p>
            ) : null}

            <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
              {members.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  checked={selected.has(source.id)}
                  disabled={disabled}
                  onChange={(next) => toggle(source.id, next)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function SourceRow({
  source,
  checked,
  disabled,
  onChange,
}: {
  source: SourceInfo;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const snippetOnly = (SNIPPET_ONLY_SOURCES as readonly string[]).includes(source.id);

  return (
    <div className={cx('min-w-0', !source.enabled && 'opacity-70')}>
      <Checkbox
        checked={checked && source.enabled}
        onChange={onChange}
        disabled={disabled || !source.enabled}
        label={source.label}
      />
      <div className="mt-1 ml-[26px] flex flex-wrap items-center gap-1.5">
        {source.requiresKey ? (
          <Badge tone={source.enabled ? 'neutral' : 'warn'}>
            {source.enabled ? 'Key configured' : 'Needs a key'}
          </Badge>
        ) : null}
        {snippetOnly ? (
          <Badge
            tone="warn"
            title="This source returns only a snippet, so its scores are capped at 80% — enough to surface a lead, never enough to clear a high bar on its own."
          >
            Snippet only
          </Badge>
        ) : null}
      </div>
      {source.disabledReason ? (
        <p className="mt-1 ml-[26px] text-xs text-muted text-wrap-anywhere">
          {source.disabledReason}
        </p>
      ) : null}
    </div>
  );
}
