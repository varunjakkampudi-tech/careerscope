import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, LoaderCircle, RefreshCw, Save } from 'lucide-react';
import type { WritableProfile } from '@careerscope/core';
import { api, ApiError } from '../lib/api';
import ResumePanel, { type ResumeProposal } from './resume-panel';

type ProfileResponse = {
  revision: number;
  profile: WritableProfile | null;
  updatedAt: string | null;
};
const employmentOptions = [
  ['fulltime', 'Full-time'],
  ['parttime', 'Part-time'],
  ['contract', 'Contract'],
  ['internship', 'Internship'],
  ['temporary', 'Temporary'],
] as const;

function ProfileForm({
  record,
  proposal,
  csrf,
  onSaved,
  onDirty,
  onReload,
}: {
  record: ProfileResponse;
  proposal?: ResumeProposal;
  csrf: string;
  onSaved: (record: ProfileResponse) => void;
  onDirty: () => void;
  onReload: () => void;
}) {
  const save = useMutation({
    mutationFn: (profile: WritableProfile) =>
      api<ProfileResponse>('/profile', {
        method: 'PUT',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ revision: record.revision, profile }),
      }),
    onSuccess: onSaved,
  });
  const candidate = {
    ...record.profile?.candidate,
    ...(proposal
      ? Object.fromEntries(
          ['fullName', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio'].flatMap(
            (field) => {
              const value = proposal[field as keyof ResumeProposal];
              return typeof value === 'string' && value ? [[field, value]] : [];
            },
          ),
        )
      : {}),
  };
  const preferences = {
    ...record.profile?.preferences,
    ...(proposal?.techStack.length ? { techStack: proposal.techStack } : {}),
    ...(proposal?.titles.length ? { titles: proposal.titles } : {}),
  };
  const application = {
    ...record.profile?.application,
    ...(proposal?.yearsOfExperience != null
      ? { yearsOfExperience: proposal.yearsOfExperience }
      : {}),
  };
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
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
    const employmentTypes = employmentOptions
      .map(([value]) => value)
      .filter((value) => data.has(`employment:${value}`));
    if (!employmentTypes.length) {
      const field = form.elements.namedItem('employment:fulltime') as HTMLInputElement;
      field.setCustomValidity('Select at least one employment type.');
      field.reportValidity();
      return;
    }
    save.mutate({
      candidate: {
        fullName: text('fullName'),
        email: text('email'),
        phone: text('phone'),
        location: text('location'),
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
        employmentTypes,
        excludeKeywords: list('excludeKeywords'),
        excludeCompanies: list('excludeCompanies'),
      },
      application: {
        currentCtc: text('currentCtc'),
        expectedCtc: text('expectedCtc'),
        noticePeriodDays: Number(text('noticePeriodDays')),
        yearsOfExperience: Number(text('yearsOfExperience')),
        willingToRelocate: data.has('willingToRelocate'),
      },
    });
  }
  return (
    <form
      className="profile-form"
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
      <fieldset disabled={save.isPending}>
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
      </fieldset>
      <fieldset disabled={save.isPending}>
        <legend>Job Preferences</legend>
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
          <label>
            Minimum Annual Salary
            <input
              name="minSalary"
              type="number"
              min={0}
              step={1}
              defaultValue={preferences?.minSalary ?? ''}
            />
          </label>
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
      <fieldset disabled={save.isPending}>
        <legend>Application Details</legend>
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
            Notice Period (Days)
            <input
              name="noticePeriodDays"
              type="number"
              required
              min={0}
              max={365}
              step={1}
              defaultValue={application?.noticePeriodDays ?? 0}
            />
          </label>
          <label>
            Years of Experience
            <input
              name="yearsOfExperience"
              type="number"
              required
              min={0}
              max={60}
              step={0.1}
              defaultValue={application?.yearsOfExperience ?? 0}
            />
          </label>
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
      <div className="profile-actions">
        <button className="primary" disabled={save.isPending}>
          {save.isPending ? <LoaderCircle className="spin" size={18} /> : <Save size={18} />}Save
          Profile
        </button>
        {save.error instanceof ApiError && save.error.status === 409 && (
          <button type="button" onClick={onReload}>
            <RefreshCw size={16} />
            Discard Edits and Reload
          </button>
        )}
      </div>
      {save.error && <p role="alert">{save.error.message}</p>}
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
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [proposal, setProposal] = useState<ResumeProposal>();
  useEffect(() => {
    if (!dirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [dirty]);
  const profile = useQuery({
    queryKey: ['profile'],
    queryFn: ({ signal }) => api<ProfileResponse>('/profile', { signal }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  async function reload() {
    const result = await profile.refetch();
    if (result.isSuccess) {
      setProposal(undefined);
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
        onReview={(derived) => {
          if (dirty && !window.confirm('Replace unsaved edits with the resume draft?')) return;
          setProposal(derived);
          setGeneration((value) => value + 1);
          setDirty(true);
          onDirty(true);
          setSaved(false);
        }}
      />
      {profile.isPending ? (
        <p role="status">Loading profile...</p>
      ) : profile.isError ? (
        <div role="alert">
          <p>{profile.error.message}</p>
          <button onClick={reload}>
            <RefreshCw size={16} />
            Retry
          </button>
        </div>
      ) : (
        <ProfileForm
          key={`${profile.data.revision}:${generation}`}
          record={profile.data}
          proposal={proposal}
          csrf={csrf}
          onDirty={() => {
            setDirty(true);
            onDirty(true);
            setSaved(false);
          }}
          onReload={reload}
          onSaved={(record) => {
            setProposal(undefined);
            cache.setQueryData(['profile'], record);
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
