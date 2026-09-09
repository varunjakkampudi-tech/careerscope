/**
 * Settings.
 *
 * Four things live here, in descending order of how often they're needed: the
 * API key, the appearance toggle, what this install can actually reach, and the
 * destructive data controls.
 *
 * ## The key is never echoed
 *
 * `maskedApiKey()` shows the first and last four characters and dots in between
 * — enough to answer "is the stored key the one I think it is", never enough to
 * copy. The full value is not rendered, not selectable, and not put in the DOM.
 * The input that sets it is `type="password"` and is cleared on save.
 *
 * ## Source availability is read, never configured
 *
 * Which providers are on is decided by environment variables on the server. This
 * screen reports what the catalogue says and names the variable that would turn
 * a disabled one on — it cannot flip them, because a browser writing server
 * credentials is exactly the thing the API key exists to prevent.
 *
 * ## Wiping asks twice
 *
 * Deleting the profile takes the resume and every lead with it, and there is no
 * undo. So the button arms first and confirms second, with the consequence
 * spelled out between the two clicks.
 */

import { useState, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from '../lib/api';
import { useSession } from '../lib/session';
import { Link } from 'react-router-dom';
import { SOURCE_LABELS, type SourceInfo } from '@job-radar/shared';
import {
  clearApiKey,
  currentPersistence,
  hasApiKey,
  maskedApiKey,
  setApiKey,
  subscribeToApiKey,
  type KeyPersistence,
} from '../lib/auth';
import { getThemeChoice, setThemeChoice, subscribeToTheme, type ThemeChoice } from '../lib/theme';
import {
  useDeleteProfile,
  useExportLeads,
  useProfile,
  useResumes,
  useSources,
} from '../lib/queries';
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  Skeleton,
  buttonClass,
  cx,
} from '../components/ui';

const KIND_LABEL: Record<SourceInfo['kind'], string> = {
  ats: 'Company boards',
  api: 'Aggregators',
  remote: 'Remote boards',
  scrape: 'Scrapers',
  email: 'Job-alert emails',
};

const KIND_ORDER: SourceInfo['kind'][] = ['ats', 'remote', 'api', 'scrape', 'email'];

export function Settings() {
  const session = useSession();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-16">
      <header>
        <h1 className="text-xl font-semibold text-ink">Settings</h1>
        <p className="mt-1 text-sm text-muted">
          Account, appearance, sources and data for this single-owner installation.
        </p>
      </header>

      {session.data?.enabled ? (
        <section className="border-b border-border pb-4">
          <h2 className="text-sm font-semibold text-ink">Account</h2>
          <p className="mt-2 break-all text-sm text-muted">{session.data.email}</p>
          <Link to="/profile" className="mt-2 inline-block text-sm text-accent">
            View profile
          </Link>
        </section>
      ) : session.data ? (
        <ApiKeySection />
      ) : null}
      <AppearanceSection />
      <ScheduleSection />
      <SourcesSection />
      <DataSection />
    </div>
  );
}

function ScheduleSection() {
  const client = useQueryClient();
  const [time, setTime] = useState<string | null>(null);
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const schedule = useQuery({
    queryKey: ['search-schedule'],
    queryFn: () =>
      request<{
        intervalMinutes: number;
        dailyAt: { time: string; timeZone: string } | null;
        lastScheduledAt: string | null;
        lastAttempt: {
          at: string;
          status: 'paused' | 'queued';
          message: string;
          runId: string | null;
        } | null;
      }>('/search/schedule'),
    refetchInterval: 60000,
  });
  const save = useMutation({
    mutationFn: (body: { intervalMinutes: number; dailyAt?: { time: string; timeZone: string } }) =>
      request('/search/schedule', { method: 'PUT', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['search-schedule'] });
    },
  });
  return (
    <section className="border-b border-border py-5">
      <h2 className="mb-3 text-sm font-semibold text-ink">Automatic search</h2>
      <Field label="Frequency" htmlFor="search-frequency">
        <Select
          id="search-frequency"
          value={schedule.data?.intervalMinutes ?? 0}
          disabled={!schedule.data || save.isPending}
          onChange={(event) => save.mutate({ intervalMinutes: Number(event.target.value) })}
        >
          <option value={0}>Off</option>
          <option value={1440}>Every day</option>
          {schedule.data && ![0, 1440].includes(schedule.data.intervalMinutes) ? (
            <option value={schedule.data.intervalMinutes}>
              Every {schedule.data.intervalMinutes} minutes
            </option>
          ) : null}
        </Select>
      </Field>
      {schedule.data?.intervalMinutes === 1440 ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate({
              intervalMinutes: 1440,
              dailyAt: {
                time: time ?? schedule.data?.dailyAt?.time ?? '07:00',
                timeZone: timeZone ?? schedule.data?.dailyAt?.timeZone ?? 'Asia/Kolkata',
              },
            });
          }}
        >
          <Field label="Start time" htmlFor="search-daily-time">
            <Input
              id="search-daily-time"
              type="time"
              required
              value={time ?? schedule.data.dailyAt?.time ?? '07:00'}
              onChange={(event) => setTime(event.target.value)}
            />
          </Field>
          <Field label="Timezone" htmlFor="search-daily-timezone">
            <Input
              id="search-daily-timezone"
              required
              maxLength={100}
              value={timeZone ?? schedule.data.dailyAt?.timeZone ?? 'Asia/Kolkata'}
              onChange={(event) => setTimeZone(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={save.isPending}>
            Save time
          </Button>
          <p className="w-full text-xs text-muted">
            {schedule.data.dailyAt
              ? `Daily at ${schedule.data.dailyAt.time} (${schedule.data.dailyAt.timeZone})`
              : 'Every 24 hours; no fixed start time saved.'}
          </p>
        </form>
      ) : null}
      <p className="mt-2 text-xs text-muted">
        Requires the API to stay running. Uses your last search's sources and filters.
      </p>
      {schedule.data?.lastScheduledAt ? (
        <p className="mt-2 text-xs text-muted">
          Last scheduled attempt: {new Date(schedule.data.lastScheduledAt).toLocaleString()}
        </p>
      ) : null}
      {schedule.data?.lastAttempt ? (
        <div className="mt-3 space-y-2">
          {schedule.data.lastAttempt.status === 'paused' ? (
            <Alert tone="warn" title="Last scheduled attempt paused">
              {schedule.data.lastAttempt.message}
            </Alert>
          ) : (
            <p role="status" className="text-sm text-muted">
              {schedule.data.lastAttempt.message}
            </p>
          )}
          <Link to="/search" className="inline-block text-sm text-accent hover:underline">
            Review search
          </Link>
        </div>
      ) : null}
      {save.isSuccess ? (
        <p role="status" className="mt-2 text-xs text-good">
          Schedule saved.
        </p>
      ) : null}
      {save.error || schedule.error ? (
        <p role="alert" className="text-sm text-bad">
          {(save.error ?? schedule.error)?.message}
        </p>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* API key                                                                    */
/* -------------------------------------------------------------------------- */

function ApiKeySection() {
  // Subscribed rather than read once: clearing the key from here has to update
  // this panel and the header lock in the same tick.
  const present = useSyncExternalStore(subscribeToApiKey, hasApiKey);
  const masked = useSyncExternalStore(subscribeToApiKey, maskedApiKey);
  const persistence = useSyncExternalStore(subscribeToApiKey, currentPersistence);

  const [draft, setDraft] = useState('');
  const [where, setWhere] = useState<KeyPersistence>('local');
  const [saved, setSaved] = useState(false);

  const save = () => {
    setApiKey(draft, where);
    setDraft(''); // never leave the plaintext sitting in a mounted input
    setSaved(true);
  };

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">API key</h2>
        <Badge tone={present ? 'good' : 'warn'}>{present ? 'Stored' : 'Not set'}</Badge>
      </div>
      <p className="mb-4 text-xs text-muted">
        Sent as <code className="text-faint">x-api-key</code> on every request. It must match{' '}
        <code className="text-faint">APP_API_KEY</code> on the server. If the server runs with{' '}
        <code className="text-faint">AUTH_DISABLED=true</code>, no key is needed.
      </p>

      {present && masked ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-canvas px-3 py-2">
          {/* Masked and inert. The real value is deliberately not in the DOM. */}
          <code className="font-mono text-sm text-ink select-none">{masked}</code>
          <span className="text-xs text-faint">
            {persistence === 'session'
              ? 'this tab only — cleared when the browser closes'
              : 'remembered on this device'}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              clearApiKey();
              setSaved(false);
            }}
          >
            Forget it
          </Button>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <Field label={present ? 'Replace the key' : 'Set the key'} htmlFor="settings-key">
          <Input
            id="settings-key"
            type="password"
            value={draft}
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the value of APP_API_KEY"
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
          />
        </Field>

        <Field label="Remember it" htmlFor="settings-key-where" className="sm:w-44">
          <Select
            id="settings-key-where"
            value={where}
            onChange={(event) => setWhere(event.target.value as KeyPersistence)}
          >
            <option value="local">On this device</option>
            <option value="session">This tab only</option>
          </Select>
        </Field>

        <Button variant="primary" disabled={draft.trim() === ''} onClick={save} className="sm:mb-0">
          Save
        </Button>
      </div>

      {saved ? (
        <p className="mt-3 text-xs text-good">
          Saved. Requests from this tab now carry it — reload if a page still shows an auth error.
        </p>
      ) : null}

      <p className="mt-3 text-xs text-faint">
        Choose “this tab only” on a shared or borrowed machine. The key is held in browser storage
        either way, which is safe here because this deployment is private and the page loads no
        third-party script — but it is not a session token, so treat it like a password.
      </p>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Appearance                                                                 */
/* -------------------------------------------------------------------------- */

const THEMES: { value: ThemeChoice; label: string; hint: string }[] = [
  { value: 'system', label: 'Match system', hint: 'Follows your OS setting' },
  { value: 'light', label: 'Light', hint: '' },
  { value: 'dark', label: 'Dark', hint: '' },
];

function AppearanceSection() {
  const choice = useSyncExternalStore(subscribeToTheme, getThemeChoice);

  return (
    <Card className="p-5">
      <h2 className="mb-3 text-sm font-semibold text-ink">Appearance</h2>
      <div role="radiogroup" aria-label="Colour theme" className="flex flex-wrap gap-2">
        {THEMES.map((theme) => (
          <button
            key={theme.value}
            type="button"
            role="radio"
            aria-checked={choice === theme.value}
            onClick={() => setThemeChoice(theme.value)}
            className={cx(
              'rounded-lg border px-3 py-2 text-sm',
              choice === theme.value
                ? 'border-accent bg-accent-soft text-ink'
                : 'border-border text-muted hover:text-ink',
            )}
          >
            {theme.label}
            {theme.hint ? <span className="block text-xs text-faint">{theme.hint}</span> : null}
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-faint">
        Both themes use their own validated colour steps rather than an inverted copy of the other,
        so match scores stay readable in either.
      </p>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Sources                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What this install can reach, and why anything disabled is disabled.
 *
 * `disabledReason` comes from the server and names the missing environment
 * variable — never its value. That distinction is the whole reason the reason
 * string is safe to render verbatim.
 */
function SourcesSection() {
  const catalog = useSources();

  if (catalog.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (catalog.isError) {
    return (
      <Alert
        tone="bad"
        title="Couldn’t read the source catalogue"
        action={
          <Button size="sm" variant="secondary" onClick={() => void catalog.refetch()}>
            Retry
          </Button>
        }
      >
        {catalog.error.message}
      </Alert>
    );
  }

  const sources = catalog.data?.sources ?? [];
  const capabilities = catalog.data?.capabilities;
  const enabled = sources.filter((source) => source.enabled).length;

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">Sources</h2>
        <span className="text-xs text-muted">
          {enabled} of {sources.length} available
        </span>
      </div>
      <p className="mb-4 text-xs text-muted">
        Configured on the server, not here — a browser cannot be trusted with provider credentials.
        Set the named variable and restart the API to enable one.
      </p>

      <div className="flex flex-col gap-5">
        {KIND_ORDER.map((kind) => {
          const group = sources.filter((source) => source.kind === kind);
          if (group.length === 0) return null;
          return (
            <div key={kind}>
              <h3 className="mb-2 text-xs font-medium tracking-wide text-faint uppercase">
                {KIND_LABEL[kind]}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {group.map((source) => (
                  <li
                    key={source.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-1.5 last:border-0"
                  >
                    <span className="text-sm text-ink">{SOURCE_LABELS[source.id]}</span>
                    <span className="flex items-center gap-2">
                      {!source.providesFullDescription ? (
                        <Badge
                          tone="warn"
                          title="Only a snippet is returned, so matches from this source are capped at 80%."
                        >
                          Snippet only
                        </Badge>
                      ) : null}
                      <Badge tone={source.enabled ? 'good' : 'neutral'}>
                        {source.enabled ? 'Available' : 'Off'}
                      </Badge>
                    </span>
                    {!source.enabled && source.disabledReason ? (
                      <span className="w-full text-xs text-faint">{source.disabledReason}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <dl className="mt-5 grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
        <Capability
          on={capabilities?.llmRerank ?? false}
          label="Semantic rerank"
          onHint="Claude gives a second opinion on the top candidates, blended 60/40 with the keyword score."
          offHint="Set ENABLE_LLM_RERANK and an Anthropic key to offer it. The keyword engine runs either way."
        />
        <Capability
          on={capabilities?.scrapers ?? false}
          label="Browser scrapers"
          onHint="LinkedIn, Naukri and Indeed can be selected when their browser requirements are met. Access may still be blocked by the source."
          offHint="Off by default. They need a headless browser and carry more terms-of-service risk than the APIs."
        />
      </dl>
    </Card>
  );
}

function Capability({
  on,
  label,
  onHint,
  offHint,
}: {
  on: boolean;
  label: string;
  onHint: string;
  offHint: string;
}) {
  return (
    <div>
      <dt className="flex items-center gap-2 text-sm text-ink">
        {label}
        <Badge tone={on ? 'good' : 'neutral'}>{on ? 'On' : 'Off'}</Badge>
      </dt>
      <dd className="mt-0.5 text-xs text-faint">{on ? onHint : offHint}</dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

function DataSection() {
  const profile = useProfile();
  const resumes = useResumes();
  const remove = useDeleteProfile();
  const exportLeads = useExportLeads();

  const [armed, setArmed] = useState(false);

  const resumeCount = resumes.data?.length ?? 0;
  const attached = resumes.data?.find((resume) => resume.id === profile.data?.resumeId);

  return (
    <Card className="p-5">
      <h2 className="mb-1 text-sm font-semibold text-ink">Your data</h2>
      <p className="mb-4 text-xs text-muted">
        Everything is stored in a single SQLite file on the machine running the API. Nothing is sent
        anywhere except to the job sources you search, and to Claude if semantic rerank is on.
      </p>

      <dl className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-muted">Profile</dt>
          <dd className="text-sm break-words text-ink">
            {profile.isLoading
              ? '…'
              : profile.data
                ? profile.data.candidate.fullName
                : 'Not set up'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">Resume</dt>
          <dd className="text-sm break-words text-ink">
            {resumes.isLoading || profile.isLoading
              ? '…'
              : attached
                ? `${attached.filename} · ${Math.round(attached.sizeBytes / 1024).toLocaleString()} KB`
                : 'No resume attached'}
            {resumeCount > (attached ? 1 : 0) ? (
              <span className="text-faint"> ({resumeCount} uploaded)</span>
            ) : null}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <Link to="/profile" className={buttonClass('secondary', 'sm')}>
          Edit profile
        </Link>
        <Button
          size="sm"
          variant="secondary"
          loading={exportLeads.isPending}
          onClick={() =>
            exportLeads.mutate({
              format: 'xlsx',
              filters: { minScore: 0, sort: 'score', order: 'desc' },
            })
          }
        >
          Export every lead
        </Button>
      </div>

      {exportLeads.isError ? (
        <Alert tone="bad" title="Export failed" className="mt-3">
          {exportLeads.error.message}
        </Alert>
      ) : null}

      {/* Arm, then confirm. One click that deletes the resume, the profile and
          every lead is a click somebody makes by accident exactly once. */}
      <div className="mt-6 border-t border-border pt-4">
        <h3 className="text-sm font-medium text-ink">Delete everything</h3>
        <p className="mt-0.5 mb-3 text-xs text-muted">
          Removes the profile, the uploaded resume and every lead scored against it. Search history
          goes too. This cannot be undone — export first if you want a copy.
        </p>

        {remove.isError ? (
          <Alert tone="bad" title="Couldn’t delete" className="mb-3">
            {remove.error.message}
          </Alert>
        ) : null}

        {remove.isSuccess ? (
          <Alert tone="good" title="Deleted" className="mb-3">
            Everything is gone.{' '}
            <Link to="/" className="text-accent underline">
              Set up a new profile
            </Link>{' '}
            to start again.
          </Alert>
        ) : armed ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="danger"
              loading={remove.isPending}
              onClick={() => remove.mutate(undefined, { onSuccess: () => setArmed(false) })}
            >
              Yes, delete it all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setArmed(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={!profile.data}
            onClick={() => setArmed(true)}
          >
            Delete all data
          </Button>
        )}
      </div>
    </Card>
  );
}
