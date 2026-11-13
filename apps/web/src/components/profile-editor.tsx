import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ImagePlus, LoaderCircle, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { ApplicationDetails, ResumeImportField, WritableProfile } from '@careerscope/shared';
import { apiJson, apiParsed, offersDiscardAndReload } from '../lib/api';
import { parseProfileResponse, type ProfileResponse } from '../lib/api-schemas';
import { localizedText, useInterfaceLocale } from '../lib/locale';
import { PROFILE_PHOTO_UPDATED_EVENT } from '../lib/profile-photo';
import { useOwner, ownerKey } from '../lib/session';
import styles from './profile-editor.module.css';
import ResumePanel, { type ResumeProposal } from './resume-panel';
import ResumeProposalReview, { type AcceptedResumeProposal } from './resume-proposal-review';
import { ErrorState, LoadingState } from './ui-states';

const maximumProfilePhotoUploadBytes = 5 * 1024 * 1024;
const profilePhotoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

const employmentOptions = [
  ['fulltime', 'Full-time'],
  ['parttime', 'Part-time'],
  ['contract', 'Contract'],
  ['internship', 'Internship'],
  ['temporary', 'Temporary'],
] as const;
const careerSegments = [
  ['student', 'Student'],
  ['fresher', 'Fresher'],
  ['experienced', 'Experienced'],
] as const;

const onboardingSteps = [
  { title: 'Contact', description: 'Start with the details you want employers to use.' },
  { title: 'Your background', description: 'Choose what best describes your career stage.' },
  { title: 'Job preferences', description: 'Tell us what work you want to find.' },
  { title: 'Application details', description: 'Add optional details that help you prepare.' },
  { title: 'Accessibility', description: 'Set a workspace preference, then save your profile.' },
] as const;

function ProfileForm({
  record,
  proposal,
  csrf,
  resumeId,
  resumeImportFields,
  onSaved,
  onDirty,
  onReload,
}: {
  record: ProfileResponse;
  proposal?: AcceptedResumeProposal;
  csrf: string;
  resumeId: string | null;
  resumeImportFields: ResumeImportField[];
  onSaved: (record: ProfileResponse) => void;
  onDirty: () => void;
  onReload: () => void;
}) {
  const guided = record.profile === null;
  const [step, setStep] = useState(0);
  const [careerSegment, setCareerSegment] = useState(record.profile?.candidate.segment ?? '');
  const formElement = useRef<HTMLFormElement | null>(null);
  const stepSections = useRef<Array<HTMLFieldSetElement | null>>([]);
  const invalidFieldToFocus = useRef<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null
  >(null);
  const [photoMessage, setPhotoMessage] = useState('');
  const [photoValidationError, setPhotoValidationError] = useState('');

  const save = useMutation({
    mutationFn: (profile: WritableProfile) =>
      apiParsed('/profile', parseProfileResponse, {
        method: 'PUT',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ revision: record.revision, profile }),
      }),
    onSuccess: onSaved,
  });
  const photoUpload = useMutation({
    mutationFn: (file: File) =>
      apiJson('/profile/photo', {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      }),
    onSuccess: () => {
      setPhotoMessage('Profile picture saved.');
      window.dispatchEvent(new Event(PROFILE_PHOTO_UPDATED_EVENT));
    },
  });
  const photoDelete = useMutation({
    mutationFn: () => apiJson('/profile/photo', { method: 'DELETE' }),
    onSuccess: () => {
      setPhotoMessage('Profile picture removed.');
      window.dispatchEvent(new Event(PROFILE_PHOTO_UPDATED_EVENT));
    },
  });
  const candidate = {
    ...record.profile?.candidate,
    ...(proposal
      ? Object.fromEntries(
          (
            ['fullName', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio'] as const
          ).flatMap((field) => {
            const value = proposal[field];
            return Object.hasOwn(proposal, field) && typeof value === 'string'
              ? [[field, value]]
              : [];
          }),
        )
      : {}),
    ...(proposal?.education !== undefined ? { education: proposal.education } : {}),
    ...(proposal?.experience !== undefined ? { experience: proposal.experience } : {}),
  };
  const preferences = {
    ...record.profile?.preferences,
    ...(proposal?.techStack !== undefined ? { techStack: proposal.techStack } : {}),
    ...(proposal?.titles !== undefined ? { titles: proposal.titles } : {}),
  };
  const application = {
    ...record.profile?.application,
    ...(proposal?.yearsOfExperience !== undefined
      ? { yearsOfExperience: proposal.yearsOfExperience }
      : {}),
  };
  const [availabilityStatus, setAvailabilityStatus] = useState<
    ApplicationDetails['availabilityStatus']
  >(
    application.availabilityStatus ??
      ((application.noticePeriodDays ?? 0) === 0 ? 'immediate' : 'notice_period'),
  );

  function invalidFieldInSection(section: HTMLFieldSetElement | null, index: number) {
    if (!section) return null;
    const controls = Array.from(
      section.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input, select, textarea',
      ),
    );
    if (index === 2) {
      const employment = controls.filter(
        (control) => control instanceof HTMLInputElement && control.name.startsWith('employment:'),
      ) as HTMLInputElement[];
      if (employment.length && !employment.some((control) => control.checked)) {
        employment[0]!.setCustomValidity('Select at least one employment type.');
        return employment[0]!;
      }
    }
    return controls.find((control) => control.willValidate && !control.checkValidity()) ?? null;
  }

  useEffect(() => {
    const invalid = invalidFieldToFocus.current;
    if (!invalid) return;
    invalidFieldToFocus.current = null;
    requestAnimationFrame(() => {
      invalid.focus();
      invalid.reportValidity();
    });
  }, [step]);

  function moveToStep(nextStep: number, form: HTMLFormElement) {
    if (nextStep > step) {
      const invalid = invalidFieldInSection(stepSections.current[step] ?? null, step);
      if (invalid) {
        invalid.reportValidity();
        return;
      }
    }
    if (nextStep !== step) setStep(nextStep);
    form.querySelector('[aria-live="polite"]')?.scrollIntoView({ block: 'nearest' });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (guided) {
      for (let index = 0; index < onboardingSteps.length; index += 1) {
        const invalid = invalidFieldInSection(stepSections.current[index] ?? null, index);
        if (invalid) {
          invalidFieldToFocus.current = invalid;
          setStep(index);
          if (index === step) {
            invalidFieldToFocus.current = null;
            invalid.focus();
            invalid.reportValidity();
          }
          return;
        }
      }
    }
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const list = (name: string) => [
      ...new Set(
        text(name)
          .split(/[\n,]/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    const lines = (name: string) => [
      ...new Set(
        text(name)
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    for (const [name, limit] of Object.entries({
      titles: 25,
      techStack: 120,
      locations: 25,
      excludeKeywords: 60,
      excludeCompanies: 200,
    })) {
      if (list(name).length > limit) {
        const field = form.elements.namedItem(name) as HTMLTextAreaElement;
        field.setCustomValidity(`Enter no more than ${limit} values.`);
        field.reportValidity();
        return;
      }
    }
    for (const name of ['education', 'experience', 'projects']) {
      const entries = lines(name);
      const field = form.elements.namedItem(name) as HTMLTextAreaElement;
      if (entries.length > 20) {
        field.setCustomValidity('Enter no more than 20 entries.');
        field.reportValidity();
        return;
      }
      if (entries.some((entry) => entry.length > 200)) {
        field.setCustomValidity('Each entry must be 200 characters or fewer.');
        field.reportValidity();
        return;
      }
    }
    const employmentTypes = employmentOptions
      .map(([value]) => value)
      .filter((value) => data.has(`employment:${value}`));
    const segment = careerSegments.find(([value]) => value === text('segment'))?.[0];
    const graduationYear = text('graduationYear');
    if (!employmentTypes.length) {
      const field = form.elements.namedItem('employment:fulltime') as HTMLInputElement;
      field.setCustomValidity('Select at least one employment type.');
      field.reportValidity();
      return;
    }
    const salaryCurrency = text('minSalaryCurrency').trim();
    if (text('minSalary') && salaryCurrency && !/^[A-Za-z]{3}$/.test(salaryCurrency)) {
      const field = form.elements.namedItem('minSalaryCurrency') as HTMLInputElement;
      field.setCustomValidity('Use a three-letter currency code.');
      field.reportValidity();
      return;
    }
    save.mutate({
      candidate: {
        fullName: text('fullName'),
        email: text('email'),
        phone: text('phone'),
        location: text('location'),
        ...(segment ? { segment } : {}),
        education: lines('education'),
        experience: lines('experience'),
        ...(graduationYear ? { graduationYear: Number(graduationYear) } : {}),
        projects: lines('projects'),
        linkedin: text('linkedin'),
        github: text('github'),
        portfolio: text('portfolio'),
      },
      preferences: {
        titles: list('titles'),
        techStack: list('techStack'),
        locations: list('locations'),
        remoteOnly: data.has('remoteOnly'),
        minSalary: text('minSalary') ? Number(text('minSalary')) : null,
        minSalaryCurrency: text('minSalary')
          ? text('minSalaryCurrency').trim().toUpperCase() || null
          : null,
        employmentTypes,
        excludeKeywords: list('excludeKeywords'),
        excludeCompanies: list('excludeCompanies'),
      },
      application: {
        currentCtc: text('currentCtc'),
        expectedCtc: text('expectedCtc'),
        availabilityStatus,
        noticePeriodDays:
          availabilityStatus === 'notice_period' ? Number(text('noticePeriodDays')) : 0,
        preferredContactMethod: text(
          'preferredContactMethod',
        ) as ApplicationDetails['preferredContactMethod'],
        yearsOfExperience: text('yearsOfExperience').trim()
          ? Number(text('yearsOfExperience'))
          : null,
        willingToRelocate: data.has('willingToRelocate'),
      },
      accessibility: {
        reducedMotion: data.has('reducedMotion'),
      },
      resumeId,
      resumeImportFields,
    });
  }
  return (
    <form
      ref={formElement}
      className="profile-form"
      noValidate={guided}
      onSubmit={submit}
      onChange={(event) => {
        onDirty();
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
          target.setCustomValidity('');
        const employment = event.currentTarget.elements.namedItem('employment:fulltime');
        if (employment instanceof HTMLInputElement) employment.setCustomValidity('');
      }}
    >
      {guided && (
        <div className={styles.onboarding}>
          <nav aria-label="Profile setup progress">
            <ol className={styles.progressList}>
              {onboardingSteps.map(({ title }, index) => (
                <li key={title}>
                  {index < step ? (
                    <button
                      type="button"
                      onClick={() => formElement.current && moveToStep(index, formElement.current)}
                    >
                      <span className={styles.stepNumber}>{index + 1}</span>
                      <span className={styles.stepLabel}>{title}</span>
                    </button>
                  ) : (
                    <span aria-current={index === step ? 'step' : undefined}>
                      <span className={styles.stepNumber}>{index + 1}</span>
                      <span className={styles.stepLabel}>{title}</span>
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
          <p className={styles.stepStatus} role="status" aria-live="polite">
            Step {step + 1} of {onboardingSteps.length}: {onboardingSteps[step]!.title}
          </p>
          <p className={styles.saveNotice}>
            Your answers are saved together when you finish. You can return to earlier steps before
            saving.
          </p>
        </div>
      )}
      <fieldset
        ref={(element) => {
          stepSections.current[0] = element;
        }}
        hidden={guided && step !== 0}
        disabled={save.isPending}
      >
        <legend>Contact</legend>
        <div className="field-grid">
          <label>
            Full Name
            <input
              name="fullName"
              autoComplete="name"
              required
              maxLength={120}
              defaultValue={candidate?.fullName ?? ''}
            />
          </label>
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              defaultValue={candidate?.email ?? ''}
            />
          </label>
          <label>
            Phone
            <input
              name="phone"
              type="tel"
              autoComplete="tel"
              maxLength={40}
              defaultValue={candidate?.phone ?? ''}
            />
          </label>
          <label>
            Location
            <input
              name="location"
              autoComplete="address-level2"
              required
              maxLength={120}
              defaultValue={candidate?.location ?? ''}
            />
          </label>
        </div>
        <section className={styles.photoField} aria-labelledby="profile-photo-heading">
          <h3 id="profile-photo-heading">Profile picture</h3>
          <p id="profile-photo-help">
            Optional. JPEG, PNG, or WebP up to 5 MB. Only you can view this picture; it is not
            exposed in recruiter views.
          </p>
          <div className={styles.photoActions}>
            <label className="button-secondary">
              <ImagePlus size={16} aria-hidden="true" />
              {photoUpload.isPending ? 'Uploading…' : 'Upload picture'}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                aria-label="Upload picture"
                aria-describedby="profile-photo-help"
                disabled={photoUpload.isPending || photoDelete.isPending}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) {
                    setPhotoMessage('');
                    setPhotoValidationError('');
                    photoDelete.reset();
                    photoUpload.reset();
                    if (!profilePhotoTypes.has(file.type)) {
                      setPhotoValidationError('Choose a JPEG, PNG, or WebP image.');
                      return;
                    }
                    if (file.size > maximumProfilePhotoUploadBytes) {
                      setPhotoValidationError('Choose an image no larger than 5 MB.');
                      return;
                    }
                    photoUpload.mutate(file);
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                setPhotoMessage('');
                setPhotoValidationError('');
                photoUpload.reset();
                photoDelete.mutate();
              }}
              disabled={photoUpload.isPending || photoDelete.isPending}
            >
              <Trash2 size={16} aria-hidden="true" />
              {photoDelete.isPending ? 'Removing…' : 'Remove picture'}
            </button>
          </div>
          {(photoValidationError || photoUpload.error || photoDelete.error) && (
            <p className={styles.photoError} role="alert">
              {(photoValidationError || (photoUpload.error ?? photoDelete.error)?.message) ??
                'Could not update your picture.'}
            </p>
          )}
          {photoMessage && (
            <p className={styles.photoStatus} role="status">
              {photoMessage}
            </p>
          )}
        </section>
      </fieldset>
      <fieldset
        ref={(element) => {
          stepSections.current[1] = element;
        }}
        hidden={guided && step !== 1}
        disabled={save.isPending}
      >
        <legend>Your background</legend>
        {guided && <p className={styles.stepDescription}>{onboardingSteps[1].description}</p>}
        <div className="field-grid">
          <label>
            Career stage
            <select
              name="segment"
              defaultValue={candidate?.segment ?? ''}
              onChange={(event) => setCareerSegment(event.currentTarget.value)}
            >
              <option value="">Choose a stage</option>
              {careerSegments.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Graduation Year
            <input
              name="graduationYear"
              type="number"
              min={1900}
              max={2100}
              step={1}
              defaultValue={candidate?.graduationYear ?? ''}
            />
          </label>
          <label>
            <span id="education-label">Education</span>
            <textarea
              name="education"
              rows={3}
              maxLength={5000}
              aria-labelledby="education-label"
              aria-describedby="education-help"
              defaultValue={candidate?.education?.join('\n') ?? ''}
            />
            <span id="education-help">
              Add up to 20 schools, qualifications, or courses; each line is limited to 200
              characters.
            </span>
          </label>
          <label>
            <span id="experience-label">Work Experience</span>
            <textarea
              name="experience"
              rows={3}
              maxLength={5000}
              aria-labelledby="experience-label"
              aria-describedby="experience-help"
              defaultValue={candidate?.experience?.join('\n') ?? ''}
            />
            <span id="experience-help">
              Add up to 20 role summaries; each line is limited to 200 characters. These are
              candidate-provided claims and are not independently verified.
            </span>
          </label>
          <label>
            <span id="projects-label">Projects</span>
            <textarea
              name="projects"
              rows={3}
              maxLength={5000}
              aria-labelledby="projects-label"
              aria-describedby="projects-help"
              defaultValue={candidate?.projects?.join('\n') ?? ''}
            />
            <span id="projects-help">
              Add up to 20 project summaries; each line is limited to 200 characters.
            </span>
          </label>
          {(['linkedin', 'github', 'portfolio'] as const).map((name) => (
            <label key={name}>
              {name === 'linkedin' ? 'LinkedIn' : name === 'github' ? 'GitHub' : 'Portfolio'}
              <input
                name={name}
                type="url"
                pattern="https://.*"
                maxLength={2000}
                defaultValue={candidate?.[name] ?? ''}
              />
            </label>
          ))}
        </div>
        {guided && (
          <p className={styles.stepDescription}>
            {careerSegment === 'student'
              ? 'Include courses, projects, and skills you have actually used.'
              : careerSegment === 'fresher'
                ? 'Internships, coursework, and projects can help show your strengths.'
                : careerSegment === 'experienced'
                  ? 'If you are changing careers, list transferable skills here and the roles you want in the next step.'
                  : 'Choose a stage if it feels useful. Career stage is self-reported and is not inferred or verified.'}
          </p>
        )}
      </fieldset>
      <fieldset
        ref={(element) => {
          stepSections.current[2] = element;
        }}
        hidden={guided && step !== 2}
        disabled={save.isPending}
      >
        <legend>Job Preferences</legend>
        {guided && <p className={styles.stepDescription}>{onboardingSteps[2].description}</p>}
        <div className="field-grid">
          <label>
            Target Roles
            <textarea
              name="titles"
              required
              rows={3}
              maxLength={4000}
              defaultValue={preferences.titles?.join('\n') ?? ''}
            />
          </label>
          <label>
            Skills
            <textarea
              name="techStack"
              required
              rows={3}
              maxLength={8000}
              defaultValue={preferences.techStack?.join('\n') ?? ''}
            />
          </label>
          <label>
            Preferred Locations
            <textarea
              name="locations"
              rows={3}
              maxLength={4000}
              defaultValue={preferences.locations?.join('\n') ?? ''}
            />
          </label>
          <div className="field-with-hint">
            <label>
              Minimum Annual Salary
              <input
                name="minSalary"
                type="number"
                min={0}
                step={1}
                defaultValue={preferences?.minSalary ?? ''}
                aria-describedby="minSalary-help"
              />
            </label>
            <label htmlFor="minSalaryCurrency">Currency code</label>
            <input
              id="minSalaryCurrency"
              name="minSalaryCurrency"
              type="text"
              maxLength={3}
              pattern="[A-Za-z]{3}"
              autoCapitalize="characters"
              placeholder="INR"
              defaultValue={preferences?.minSalaryCurrency ?? ''}
              aria-describedby="minSalary-help"
            />
            <small id="minSalary-help">
              Optional annual floor for salary matching. The three-letter currency code is optional;
              known mismatches are not compared.
            </small>
          </div>
          <label>
            Excluded Keywords
            <textarea
              name="excludeKeywords"
              rows={3}
              maxLength={4000}
              defaultValue={preferences.excludeKeywords?.join('\n') ?? ''}
            />
          </label>
          <label>
            Excluded Companies
            <textarea
              name="excludeCompanies"
              rows={3}
              maxLength={8000}
              defaultValue={preferences.excludeCompanies?.join('\n') ?? ''}
            />
          </label>
        </div>
        <div className="check-row">
          <label>
            <input
              name="remoteOnly"
              type="checkbox"
              defaultChecked={preferences?.remoteOnly ?? false}
            />
            Remote Only
          </label>
        </div>
        <fieldset className="employment">
          <legend>Employment Types</legend>
          <div className="check-row">
            {employmentOptions.map(([value, label]) => (
              <label key={value}>
                <input
                  name={`employment:${value}`}
                  type="checkbox"
                  defaultChecked={(preferences?.employmentTypes ?? ['fulltime']).includes(value)}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      </fieldset>
      <fieldset
        ref={(element) => {
          stepSections.current[3] = element;
        }}
        hidden={guided && step !== 3}
        disabled={save.isPending}
      >
        <legend>Application Details</legend>
        {guided && <p className={styles.stepDescription}>{onboardingSteps[3].description}</p>}
        <p>
          Availability and preferred contact are kept in your profile and are not used for job
          matching.
        </p>
        <div className="field-grid">
          <label>
            Current Compensation
            <input name="currentCtc" maxLength={40} defaultValue={application?.currentCtc ?? ''} />
          </label>
          <label>
            Expected Compensation
            <input
              name="expectedCtc"
              maxLength={40}
              defaultValue={application?.expectedCtc ?? ''}
            />
          </label>
          <label>
            Availability
            <select
              name="availabilityStatus"
              value={availabilityStatus}
              onChange={(event) =>
                setAvailabilityStatus(
                  event.target.value as ApplicationDetails['availabilityStatus'],
                )
              }
            >
              <option value="immediate">Immediately available</option>
              <option value="notice_period">Serving a notice period</option>
              <option value="not_specified">Prefer not to say</option>
            </select>
          </label>
          <label hidden={availabilityStatus !== 'notice_period'}>
            Notice Period (Days)
            <input
              name="noticePeriodDays"
              type="number"
              required={availabilityStatus === 'notice_period'}
              min={1}
              max={365}
              step={1}
              disabled={availabilityStatus !== 'notice_period'}
              defaultValue={application?.noticePeriodDays || ''}
              aria-describedby="noticePeriodDays-help"
            />
            <small id="noticePeriodDays-help">Enter a value from 1 to 365 days.</small>
          </label>
          <label>
            Preferred Contact Method
            <select name="preferredContactMethod" defaultValue={application.preferredContactMethod}>
              <option value="no_preference">No preference</option>
              <option value="email">Email</option>
              <option value="phone">Phone</option>
            </select>
          </label>
          <div className="field-with-hint">
            <label>
              Years of Experience
              <input
                name="yearsOfExperience"
                type="number"
                min={0}
                max={60}
                step={0.1}
                defaultValue={application?.yearsOfExperience ?? ''}
                aria-describedby="yearsOfExperience-help"
              />
            </label>
            <small id="yearsOfExperience-help">
              Leave blank if you do not know or prefer not to say.
            </small>
          </div>
        </div>
        <div className="check-row">
          <label>
            <input
              name="willingToRelocate"
              type="checkbox"
              defaultChecked={application?.willingToRelocate ?? true}
            />
            Willing to Relocate
          </label>
        </div>
      </fieldset>
      <fieldset
        ref={(element) => {
          stepSections.current[4] = element;
        }}
        hidden={guided && step !== 4}
        disabled={save.isPending}
      >
        <legend>Accessibility</legend>
        <div className="check-row">
          <label>
            <input
              name="reducedMotion"
              type="checkbox"
              defaultChecked={record.profile?.accessibility?.reducedMotion ?? false}
            />
            Reduce non-essential motion
          </label>
        </div>
        <p>CareerScope will minimize animation and scrolling motion across your workspace.</p>
      </fieldset>
      {guided && (
        <div className={styles.stepActions}>
          {step > 0 && (
            <button type="button" onClick={() => setStep((current) => current - 1)}>
              Back
            </button>
          )}
          {step < onboardingSteps.length - 1 ? (
            <button
              key="continue"
              type="button"
              className="primary"
              onClick={(event) => {
                event.preventDefault();
                const form = event.currentTarget.form;
                if (form) moveToStep(step + 1, form);
              }}
            >
              Continue
            </button>
          ) : (
            <button key="finish" className="primary" type="submit" disabled={save.isPending}>
              {save.isPending ? (
                <>
                  <LoaderCircle className="spin" size={18} aria-hidden="true" /> Saving profile
                </>
              ) : (
                <>
                  <Save size={18} aria-hidden="true" /> Save and finish
                </>
              )}
            </button>
          )}
        </div>
      )}
      <div className="profile-actions">
        {!guided && (
          <button className="primary" disabled={save.isPending}>
            {save.isPending ? <LoaderCircle className="spin" size={18} /> : <Save size={18} />}Save
            Profile
          </button>
        )}
        {/* CS-35: only a revision conflict is repaired by reloading. Offering
            it for, say, PROFILE_NOT_SAVED would invite the owner to destroy
            edits that are not stale. */}
        {offersDiscardAndReload(save.error) && (
          <button type="button" onClick={onReload}>
            <RefreshCw size={16} />
            Discard Edits and Reload
          </button>
        )}
      </div>
      {save.error && (
        <ErrorState
          variant="inline"
          what="Could not save your profile."
          detail={save.error.message}
        />
      )}
    </form>
  );
}

export default function ProfileEditor({
  csrf,
  onBack,
  onDirty,
}: {
  csrf: string;
  onBack: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const cache = useQueryClient();
  // CS-61: owner-scoped query keys. Present exactly when authenticated.
  const owner = useOwner();
  const locale = useInterfaceLocale();
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [proposal, setProposal] = useState<AcceptedResumeProposal>();
  const [proposalForReview, setProposalForReview] = useState<ResumeProposal>();
  const [proposalResumeId, setProposalResumeId] = useState<string>();
  const [proposalResumeName, setProposalResumeName] = useState('');
  const [acceptedResumeImport, setAcceptedResumeImport] = useState<{
    resumeId: string;
    fields: ResumeImportField[];
  }>();
  useEffect(() => {
    if (!dirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [dirty]);
  // CS-36: clears the caller's dirty signal when this whole screen unmounts
  // (e.g. the sidebar's plain <Link> navigation away from /resume), the
  // same reasoning as saved-leads.tsx's equivalent cleanup.
  useEffect(() => () => onDirty(false), [onDirty]);
  const profile = useQuery({
    queryKey: ownerKey(owner, 'profile'),
    // CS-61: MANDATORY. Without this the query can run before the session
    // resolves, building `[name, undefined, ...]` - which merges every owner
    // back into one bucket and looks owner-scoped in the source.
    enabled: !!owner,
    queryFn: ({ signal }) => apiParsed('/profile', parseProfileResponse, { signal }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  async function reload() {
    const result = await profile.refetch();
    if (result.isSuccess) {
      setProposal(undefined);
      setProposalForReview(undefined);
      setProposalResumeId(undefined);
      setProposalResumeName('');
      setAcceptedResumeImport(undefined);
      setDirty(false);
      onDirty(false);
      setSaved(false);
      setGeneration((value) => value + 1);
    }
  }
  return (
    <section className="results profile-page">
      <div className="section-heading">
        <h1>Candidate Profile</h1>
        <button
          type="button"
          onClick={() => {
            if (!dirty || window.confirm('Discard unsaved profile changes?')) onBack();
          }}
        >
          <ArrowLeft size={17} />
          Back to Search
        </button>
      </div>
      <ResumePanel
        csrf={csrf}
        hasSavedProfile={profile.data?.profile !== null && profile.data?.profile !== undefined}
        onReview={(derived, resumeId, resumeName) => {
          if (dirty && !window.confirm('Replace unsaved edits with the resume draft?')) return;
          setProposal(undefined);
          setAcceptedResumeImport(undefined);
          setProposalForReview(derived);
          setProposalResumeId(resumeId);
          setProposalResumeName(resumeName);
          setGeneration((value) => value + 1);
          setDirty(false);
          onDirty(false);
          setSaved(false);
        }}
      />
      {profile.isPending ? (
        <LoadingState variant="inline" message="Loading profile..." />
      ) : profile.isError ? (
        <div role="alert">
          <p>Could not load your profile. {profile.error.message}</p>
          <button onClick={reload}>
            <RefreshCw size={16} />
            Retry
          </button>
        </div>
      ) : proposalForReview ? (
        <ResumeProposalReview
          key={generation}
          proposal={proposalForReview}
          sourceName={proposalResumeName}
          currentProfile={profile.data.profile}
          onApply={(accepted) => {
            if (!proposalResumeId) return;
            setAcceptedResumeImport({
              resumeId: proposalResumeId,
              fields: Object.keys(accepted) as ResumeImportField[],
            });
            setProposal(accepted);
            setProposalForReview(undefined);
            setProposalResumeId(undefined);
            setGeneration((value) => value + 1);
            setDirty(true);
            onDirty(true);
          }}
          onDirty={() => {
            setDirty(true);
            onDirty(true);
          }}
          onCancel={() => {
            if (dirty && !window.confirm(localizedText(locale, 'resumeReviewDiscardConfirm')))
              return;
            setProposalForReview(undefined);
            setProposalResumeId(undefined);
            setProposalResumeName('');
            setProposal(undefined);
            setAcceptedResumeImport(undefined);
            setGeneration((value) => value + 1);
            setDirty(false);
            onDirty(false);
          }}
        />
      ) : (
        <ProfileForm
          key={`${profile.data.revision}:${generation}`}
          record={profile.data}
          proposal={proposal}
          csrf={csrf}
          resumeId={acceptedResumeImport?.resumeId ?? profile.data.profile?.resumeId ?? null}
          resumeImportFields={
            acceptedResumeImport?.fields ?? profile.data.profile?.resumeImportFields ?? []
          }
          onDirty={() => {
            setDirty(true);
            onDirty(true);
            setSaved(false);
          }}
          onReload={reload}
          onSaved={(record) => {
            setProposal(undefined);
            setAcceptedResumeImport(undefined);
            cache.setQueryData(ownerKey(owner, 'profile'), record);
            cache.setQueryData(ownerKey(owner, 'profile-accessibility'), {
              reducedMotion: record.profile?.accessibility?.reducedMotion ?? false,
            });
            setDirty(false);
            onDirty(false);
            setSaved(true);
          }}
        />
      )}
      {saved && (
        <p className="saved" role="status">
          Profile saved.
        </p>
      )}
    </section>
  );
}
