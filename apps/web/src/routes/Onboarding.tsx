/**
 * Onboarding — and, afterwards, the profile editor.
 *
 * One screen serves both. An existing profile prefills every field and the same
 * form saves an update, because a "set up" screen and an "edit" screen with the
 * same twenty fields are two copies of the same thing that will drift apart.
 *
 * ## The resume comes first, but is not a wall
 *
 * Uploading a PDF or DOCX fills in name, contact details, skills and years of
 * experience, which is most of the form. But the upload is skippable: parsing is
 * a convenience, and a user whose resume parses badly must still be able to type
 * their own details rather than being stuck behind a dropzone.
 *
 * ## Validation is the shared schema, not a second opinion
 *
 * `profileSchema.safeParse` produces the field errors, so the browser enforces
 * exactly what the API enforces. A rule added server-side shows up here for free,
 * and there is no local copy of "titles must have at least one entry" to forget
 * to update.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ALLOWED_RESUME_MIME,
  EMPLOYMENT_TYPES,
  MAX_RESUME_BYTES,
  profileSchema,
  type DerivedResume,
  type EmploymentType,
  type Profile,
} from '@job-radar/shared';
import {
  useCreateProfile,
  useProfile,
  useResumes,
  useUpdateProfile,
  useUploadResume,
} from '../lib/queries';
import { Download } from 'lucide-react';
import { importProfileJson } from '../lib/profileImport';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Select,
  Skeleton,
  Spinner,
  TagInput,
  cx,
} from '../components/ui';

const EMPLOYMENT_LABEL: Record<EmploymentType, string> = {
  fulltime: 'Full-time',
  parttime: 'Part-time',
  contract: 'Contract',
  internship: 'Internship',
  temporary: 'Temporary',
};

/** Everything empty, so an uncontrolled input never appears. */
function emptyProfile(): Profile {
  return {
    candidate: {
      fullName: '',
      email: '',
      phone: '',
      location: '',
      linkedin: '',
      github: '',
      portfolio: '',
    },
    preferences: {
      titles: [],
      techStack: [],
      locations: [],
      remoteOnly: false,
      minSalary: null,
      employmentTypes: ['fulltime'],
      excludeKeywords: [],
      excludeCompanies: [],
    },
    application: {
      currentCtc: '',
      expectedCtc: '',
      noticePeriodDays: 0,
      willingToRelocate: true,
      yearsOfExperience: 0,
    },
    resumeId: null,
  };
}

/**
 * Waits for the saved profile, then hands it to the form as its starting point.
 *
 * The split is what makes seeding safe. `ProfileForm` reads `initial` once, when
 * it mounts, and never again — so a background refetch landing while the user is
 * halfway through typing cannot overwrite them. Getting the same guarantee from
 * a single component means a seeded-once flag and an effect that has to know not
 * to fire twice; this is the same rule expressed as structure.
 */
export function Onboarding() {
  const existing = useProfile();

  if (existing.isLoading) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  // No profile yet — and a failed fetch lands here too, with an empty form the
  // user can still fill in rather than a dead end.
  return <ProfileForm initial={existing.data ?? emptyProfile()} isEdit={existing.data != null} />;
}

function ProfileForm({ initial, isEdit }: { initial: Profile; isEdit: boolean }) {
  const navigate = useNavigate();
  const create = useCreateProfile();
  const update = useUpdateProfile();
  const upload = useUploadResume();
  const resumes = useResumes();

  const [draft, setDraft] = useState<Profile>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importedFile, setImportedFile] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [preferredLocations, setPreferredLocations] = useState(initial.preferences.locations);

  const importJson = async (file: File) => {
    setImporting(true);
    setImportError(null);
    setImportedFile(null);
    try {
      if (file.size > 1024 * 1024) throw new Error('Profile JSON must be smaller than 1 MB.');
      const text = await file.text();
      const next = importProfileJson(text, draft);
      setDraft(next);
      setErrors({});
      setImportedFile(file.name);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Could not read profile JSON.');
    } finally {
      setImporting(false);
    }
  };

  const patchCandidate = (next: Partial<Profile['candidate']>) =>
    setDraft((previous) => ({ ...previous, candidate: { ...previous.candidate, ...next } }));
  const patchPreferences = (next: Partial<Profile['preferences']>) =>
    setDraft((previous) => ({ ...previous, preferences: { ...previous.preferences, ...next } }));
  const patchApplication = (next: Partial<Profile['application']>) =>
    setDraft((previous) => ({ ...previous, application: { ...previous.application, ...next } }));

  /**
   * Merge what the parser found into the draft without overwriting anything the
   * user has already typed — their correction beats the parser's guess.
   */
  const applyDerived = (derived: DerivedResume, resumeId: string) => {
    setDraft((previous) => ({
      ...previous,
      resumeId,
      candidate: {
        ...previous.candidate,
        fullName: previous.candidate.fullName || (derived.fullName ?? ''),
        email: previous.candidate.email || (derived.email ?? ''),
        phone: previous.candidate.phone || (derived.phone ?? ''),
        location: previous.candidate.location || (derived.location ?? ''),
        linkedin: previous.candidate.linkedin || (derived.linkedin ?? ''),
        github: previous.candidate.github || (derived.github ?? ''),
        portfolio: previous.candidate.portfolio || (derived.portfolio ?? ''),
      },
      preferences: {
        ...previous.preferences,
        techStack:
          previous.preferences.techStack.length > 0
            ? previous.preferences.techStack
            : derived.techStack,
        titles:
          previous.preferences.titles.length > 0 ? previous.preferences.titles : derived.titles,
      },
      application: {
        ...previous.application,
        yearsOfExperience:
          previous.application.yearsOfExperience || (derived.yearsOfExperience ?? 0),
      },
    }));
  };

  const submit = () => {
    const result = profileSchema.safeParse(draft);
    if (!result.success) {
      const next: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path.join('.');
        // First issue per field wins — a stack of messages under one input is
        // noise, and the first is the one the user has to fix anyway.
        if (!(key in next)) next[key] = issue.message;
      }
      setErrors(next);
      // Take the user to the problem rather than leaving them staring at a
      // disabled-looking button somewhere below the fold.
      const first = document.querySelector<HTMLElement>('[data-invalid="true"]');
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    setErrors({});
    const onDone = () => {
      setSaved(true);
      if (!isEdit) navigate('/search');
    };
    if (isEdit) update.mutate(result.data, { onSuccess: onDone });
    else create.mutate(result.data, { onSuccess: onDone });
  };

  const saving = create.isPending || update.isPending;
  const saveError = create.error ?? update.error;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-16">
      <header>
        <h1 className="text-xl font-semibold text-ink">
          {isEdit ? 'Your profile' : 'Set up your profile'}
        </h1>
      </header>

      <ResumeDrop
        onFile={(file) =>
          upload.mutate(file, {
            onSuccess: (result) => applyDerived(result.derived, result.resume.id),
          })
        }
        pending={upload.isPending || importing}
        error={upload.error?.message ?? null}
        derived={upload.data?.derived ?? null}
        filename={
          resumes.data?.find((resume) => resume.id === draft.resumeId)?.filename ??
          upload.data?.resume.filename ??
          null
        }
        attached={draft.resumeId != null}
      />

      {resumes.data?.length ? (
        <Field label="Attached resume" htmlFor="attached-resume">
          <Select
            id="attached-resume"
            value={draft.resumeId ?? ''}
            onChange={(event) =>
              setDraft((previous) => ({ ...previous, resumeId: event.target.value || null }))
            }
          >
            <option value="">No resume</option>
            {resumes.data.map((resume) => (
              <option key={resume.id} value={resume.id}>
                {resume.filename}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-good">
          Profile saved.
        </p>
      ) : null}

      <section className="border-b border-border pb-5">
        <Button
          className="mb-3"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' }),
            );
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = 'profile.json';
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <Download size={16} aria-hidden="true" /> Download profile JSON
        </Button>
        <Field label="Profile JSON" htmlFor="profile-json">
          <Input
            id="profile-json"
            type="file"
            accept=".json,application/json"
            disabled={importing || upload.isPending || saving}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importJson(file);
            }}
          />
        </Field>
        {importedFile ? (
          <p role="status" className="mt-2 text-xs text-good">
            Imported {importedFile}. Unsaved changes.
          </p>
        ) : null}
        {importError ? (
          <p role="alert" className="mt-2 text-xs text-bad text-wrap-anywhere">
            {importError}
          </p>
        ) : null}
      </section>

      <Section title="You" description="Used to fill in applications and to contact you back.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required error={errors['candidate.fullName']} htmlFor="fullName">
            <Input
              id="fullName"
              value={draft.candidate.fullName}
              onChange={(event) => patchCandidate({ fullName: event.target.value })}
            />
          </Field>
          <Field label="Email" required error={errors['candidate.email']} htmlFor="email">
            <Input
              id="email"
              type="email"
              value={draft.candidate.email}
              onChange={(event) => patchCandidate({ email: event.target.value })}
            />
          </Field>
          <Field label="Phone" error={errors['candidate.phone']} htmlFor="phone">
            <Input
              id="phone"
              value={draft.candidate.phone}
              onChange={(event) => patchCandidate({ phone: event.target.value })}
            />
          </Field>
          <Field
            label="Current location"
            required
            hint="Where you are now — used to score commute and relocation."
            error={errors['candidate.location']}
            htmlFor="location"
          >
            <Input
              id="location"
              value={draft.candidate.location}
              placeholder="Bengaluru, India"
              onChange={(event) => patchCandidate({ location: event.target.value })}
            />
          </Field>
          <Field label="LinkedIn" error={errors['candidate.linkedin']} htmlFor="linkedin">
            <Input
              id="linkedin"
              type="url"
              placeholder="https://linkedin.com/in/…"
              value={draft.candidate.linkedin}
              onChange={(event) => patchCandidate({ linkedin: event.target.value })}
            />
          </Field>
          <Field label="GitHub" error={errors['candidate.github']} htmlFor="github">
            <Input
              id="github"
              type="url"
              placeholder="https://github.com/…"
              value={draft.candidate.github}
              onChange={(event) => patchCandidate({ github: event.target.value })}
            />
          </Field>
          <Field
            label="Portfolio"
            error={errors['candidate.portfolio']}
            htmlFor="portfolio"
            className="sm:col-span-2"
          >
            <Input
              id="portfolio"
              type="url"
              value={draft.candidate.portfolio}
              onChange={(event) => patchCandidate({ portfolio: event.target.value })}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Compensation and availability"
        description="Expected CTC is scored against the posted package. A job that doesn’t disclose one is treated as neutral, never as a mismatch."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Current CTC"
            hint="Free text — “28 LPA”, “₹2,800,000”, “$120k” all work."
            error={errors['application.currentCtc']}
            htmlFor="currentCtc"
          >
            <Input
              id="currentCtc"
              value={draft.application.currentCtc}
              placeholder="28 LPA"
              onChange={(event) => patchApplication({ currentCtc: event.target.value })}
            />
          </Field>
          <Field
            label="Expected CTC"
            error={errors['application.expectedCtc']}
            htmlFor="expectedCtc"
          >
            <Input
              id="expectedCtc"
              value={draft.application.expectedCtc}
              placeholder="40 LPA"
              onChange={(event) => patchApplication({ expectedCtc: event.target.value })}
            />
          </Field>
          <Field
            label="Years of experience"
            error={errors['application.yearsOfExperience']}
            htmlFor="yearsOfExperience"
          >
            <Input
              id="yearsOfExperience"
              type="number"
              min={0}
              max={60}
              step={0.5}
              value={String(draft.application.yearsOfExperience)}
              onChange={(event) =>
                patchApplication({ yearsOfExperience: Number(event.target.value) || 0 })
              }
            />
          </Field>
          <Field
            label="Notice period (days)"
            error={errors['application.noticePeriodDays']}
            htmlFor="noticePeriodDays"
          >
            <Input
              id="noticePeriodDays"
              type="number"
              min={0}
              max={365}
              value={String(draft.application.noticePeriodDays)}
              onChange={(event) =>
                patchApplication({ noticePeriodDays: Number(event.target.value) || 0 })
              }
            />
          </Field>
        </div>
        <Checkbox
          className="mt-4"
          checked={draft.application.willingToRelocate}
          onChange={(next) => patchApplication({ willingToRelocate: next })}
          label="Willing to relocate"
          hint="Off means a job outside your preferred locations scores near zero on location."
        />
      </Section>

      <Section
        title="What you're looking for"
        description="Target roles and your skills are the two heaviest inputs to the score — skills alone are 40% of it."
      >
        <div className="flex flex-col gap-4">
          <Field
            label="Target roles"
            required
            hint="Job titles you'd take. Press Enter or comma between each."
            error={errors['preferences.titles']}
            htmlFor="titles"
          >
            <TagInput
              id="titles"
              value={draft.preferences.titles}
              onChange={(titles) => patchPreferences({ titles })}
              placeholder="Senior Software Engineer"
              max={25}
            />
          </Field>

          <Field
            label="Your skills"
            required
            hint="Prefilled from your resume. These are matched against what each description demands, through an alias table — React matches React.js, Node matches Express."
            error={errors['preferences.techStack']}
            htmlFor="techStack"
          >
            <TagInput
              id="techStack"
              value={draft.preferences.techStack}
              onChange={(techStack) => patchPreferences({ techStack })}
              placeholder="TypeScript"
              max={120}
            />
          </Field>

          <Checkbox
            label="Anywhere"
            checked={draft.preferences.locations.length === 0}
            onChange={(anywhere) => {
              if (anywhere) {
                setPreferredLocations(draft.preferences.locations);
                patchPreferences({ locations: [] });
              } else {
                patchPreferences({
                  locations: preferredLocations.length
                    ? preferredLocations
                    : [draft.candidate.location || 'Hyderabad'],
                });
              }
            }}
          />
          <Field
            label="Preferred locations"
            hint="Leave empty to accept anywhere."
            error={errors['preferences.locations']}
            htmlFor="locations"
          >
            <TagInput
              id="locations"
              value={draft.preferences.locations}
              onChange={(locations) => patchPreferences({ locations })}
              placeholder="Bengaluru"
              max={25}
            />
          </Field>

          <Checkbox
            checked={draft.preferences.remoteOnly}
            onChange={(remoteOnly) => patchPreferences({ remoteOnly })}
            label="Remote only"
            hint="A hard filter: on-site jobs are excluded outright, not just scored down."
          />

          <Field
            label="Minimum package"
            hint="Annual, in your own currency. Jobs that don’t state a salary are kept regardless."
            error={errors['preferences.minSalary']}
            htmlFor="minSalary"
          >
            <Input
              id="minSalary"
              type="number"
              min={0}
              placeholder="e.g. 3500000"
              value={draft.preferences.minSalary == null ? '' : String(draft.preferences.minSalary)}
              onChange={(event) => {
                const raw = event.target.value;
                patchPreferences({ minSalary: raw === '' ? null : Number(raw) });
              }}
            />
          </Field>

          <fieldset data-invalid={errors['preferences.employmentTypes'] ? 'true' : undefined}>
            <legend className="mb-2 text-sm font-medium text-ink">Employment types</legend>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {EMPLOYMENT_TYPES.map((type) => (
                <Checkbox
                  key={type}
                  checked={draft.preferences.employmentTypes.includes(type)}
                  onChange={(next) =>
                    patchPreferences({
                      employmentTypes: next
                        ? [...draft.preferences.employmentTypes, type]
                        : draft.preferences.employmentTypes.filter((item) => item !== type),
                    })
                  }
                  label={EMPLOYMENT_LABEL[type]}
                />
              ))}
            </div>
            {errors['preferences.employmentTypes'] ? (
              <p className="mt-1 text-xs text-bad">{errors['preferences.employmentTypes']}</p>
            ) : null}
          </fieldset>
        </div>
      </Section>

      <Section
        title="Exclusions"
        description="Two different strengths: a keyword removes the job entirely, a company only flags it."
      >
        <div className="flex flex-col gap-4">
          <Field
            label="Exclude keywords"
            hint="A description containing any of these is dropped before scoring."
            error={errors['preferences.excludeKeywords']}
            htmlFor="excludeKeywords"
          >
            <TagInput
              id="excludeKeywords"
              value={draft.preferences.excludeKeywords}
              onChange={(excludeKeywords) => patchPreferences({ excludeKeywords })}
              placeholder="unpaid"
              max={60}
            />
          </Field>
          <Field
            label="Companies not to apply to"
            hint="Still shown, marked with a flag. Never auto-applied to."
            error={errors['preferences.excludeCompanies']}
            htmlFor="excludeCompanies"
          >
            <TagInput
              id="excludeCompanies"
              value={draft.preferences.excludeCompanies}
              onChange={(excludeCompanies) => patchPreferences({ excludeCompanies })}
              placeholder="Acme Corp"
              max={200}
            />
          </Field>
        </div>
      </Section>

      {saveError ? (
        <Alert tone="bad" title="Couldn’t save your profile">
          {saveError.message}
        </Alert>
      ) : null}

      {Object.keys(errors).length > 0 ? (
        <Alert tone="warn" title="Some fields need attention">
          {Object.keys(errors).length} field
          {Object.keys(errors).length === 1 ? '' : 's'} above{' '}
          {Object.keys(errors).length === 1 ? 'has' : 'have'} a problem.
        </Alert>
      ) : null}

      <div className="flex items-center gap-3">
        <Button onClick={submit} loading={saving}>
          {isEdit ? 'Save profile' : 'Save and search'}
        </Button>
        {isEdit ? (
          <Button variant="ghost" onClick={() => navigate('/leads')} disabled={saving}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                   */
/* -------------------------------------------------------------------------- */

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {description ? <p className="mt-0.5 mb-4 text-xs text-muted">{description}</p> : null}
      {children}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Resume upload                                                              */
/* -------------------------------------------------------------------------- */

const ACCEPT = ALLOWED_RESUME_MIME.join(',');

function ResumeDrop({
  onFile,
  pending,
  error,
  derived,
  filename,
  attached,
}: {
  onFile: (file: File) => void;
  pending: boolean;
  error: string | null;
  derived: DerivedResume | null;
  filename: string | null;
  attached: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);

  /**
   * Check type and size here as well as on the server. The server check is the
   * one that matters for safety; this one exists so a 40 MB file fails in a
   * millisecond instead of after a minute of uploading.
   */
  const accept = (file: File | undefined) => {
    if (!file) return;
    if (!(ALLOWED_RESUME_MIME as readonly string[]).includes(file.type)) {
      setRejected(`${file.name} isn’t a PDF or DOCX.`);
      return;
    }
    if (file.size > MAX_RESUME_BYTES) {
      setRejected(
        `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_RESUME_BYTES / 1024 / 1024} MB.`,
      );
      return;
    }
    setRejected(null);
    onFile(file);
  };

  const message = rejected ?? error;

  return (
    <Card className="p-5">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          accept(event.dataTransfer.files[0]);
        }}
        className={cx(
          'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors',
          dragging ? 'border-accent bg-accent-soft' : 'border-border',
        )}
      >
        {pending ? (
          <>
            <Spinner size={22} />
            <p className="mt-2 text-sm text-muted">Reading your resume…</p>
          </>
        ) : (
          <>
            <p className="text-sm text-ink">
              {attached ? 'Replace your resume' : 'Drop your resume here'}
            </p>
            <p className="mt-1 text-xs text-muted">
              PDF or DOCX, up to {MAX_RESUME_BYTES / 1024 / 1024} MB. Optional — you can fill the
              form in by hand.
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => input.current?.click()}
            >
              Choose a file
            </Button>
          </>
        )}

        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(event) => {
            accept(event.target.files?.[0]);
            // Reset so picking the same file twice still fires a change event.
            event.target.value = '';
          }}
        />
      </div>

      {message ? (
        <Alert tone="bad" title="That file didn’t work" className="mt-3">
          {message}
        </Alert>
      ) : null}

      {derived && filename ? <DerivedSummary derived={derived} filename={filename} /> : null}
    </Card>
  );
}

/**
 * What the parser actually got. Shown because a resume that parsed to four
 * skills and no name is a silent failure otherwise — the form would look filled
 * in and the matching would quietly be based on nothing.
 */
function DerivedSummary({ derived, filename }: { derived: DerivedResume; filename: string }) {
  const thin = derived.techStack.length < 5;

  const summary = useMemo(
    () =>
      [
        `${derived.techStack.length} skill${derived.techStack.length === 1 ? '' : 's'}`,
        derived.titles.length > 0
          ? `${derived.titles.length} past title${derived.titles.length === 1 ? '' : 's'}`
          : null,
        derived.yearsOfExperience != null ? `${derived.yearsOfExperience} years` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    [derived],
  );

  return (
    <div className="mt-4">
      <p className="text-sm text-ink">
        Read <span className="font-medium">{filename}</span>
        <span className="text-muted"> — {summary}</span>
      </p>
      {thin ? (
        <Alert tone="warn" title="That looks thin" className="mt-2">
          Only {derived.techStack.length} skills came out, which usually means the file is a scan or
          uses an unusual layout. Add the rest by hand below — the skills list drives 40% of every
          match score.
        </Alert>
      ) : null}
    </div>
  );
}
