'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson, apiParsed } from '../lib/api';
import { ownerKey, useOwner } from '../lib/session';
import { compareResumeKeywords } from '../lib/resume-keywords';
import { analyzeResumeFormatting, compareResumeSkills } from '../lib/resume-analysis';
import {
  parseResumeDraft,
  parseResumeDraftList,
  type ResumeDraft,
  type ResumeDraftContent,
} from '../lib/api-schemas';
import { ErrorState, EmptyState } from './ui-states';
import styles from './resume-builder.module.css';

type DraftFields = Pick<ResumeDraft, 'title' | 'targetRole' | 'template' | 'content'>;

const blankContent: ResumeDraftContent = {
  fullName: '',
  email: null,
  phone: null,
  location: null,
  summary: '',
  experience: [],
  education: [],
  skills: [],
};
const blankDraft: DraftFields = {
  title: '',
  targetRole: null,
  template: 'classic',
  content: blankContent,
};

function serializeDraft(value: DraftFields) {
  return JSON.stringify(value);
}

function ResumePreview({ draft, print = false }: { draft: DraftFields; print?: boolean }) {
  const { content } = draft;
  return (
    <article
      className={`${styles.preview} ${styles[draft.template]} ${print ? styles.printView : ''}`}
    >
      <header>
        <h2>{content.fullName || 'Your name'}</h2>
        <p>
          {[content.email, content.phone, content.location].filter(Boolean).join(' · ') ||
            'Contact details you choose to include'}
        </p>
        {draft.targetRole && <p className={styles.targetRole}>{draft.targetRole}</p>}
      </header>
      {content.summary && (
        <section>
          <h3>Summary</h3>
          <p>{content.summary}</p>
        </section>
      )}
      {content.experience.length > 0 && (
        <section>
          <h3>Experience</h3>
          {content.experience.map((item) => (
            <div className={styles.previewEntry} key={item.id}>
              <h4>{item.role || 'Role title'}</h4>
              <p>
                {[item.company || 'Company', item.location, item.startDate, item.endDate]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {item.bullets.length > 0 && (
                <ul>
                  {item.bullets.map((bullet, index) => (
                    <li key={`${item.id}-${index}`}>{bullet}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      )}
      {content.education.length > 0 && (
        <section>
          <h3>Education</h3>
          {content.education.map((item) => (
            <div className={styles.previewEntry} key={item.id}>
              <h4>{item.qualification || 'Qualification'}</h4>
              <p>
                {[item.institution || 'Institution', item.location, item.endDate]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
          ))}
        </section>
      )}
      {content.skills.length > 0 && (
        <section>
          <h3>Skills</h3>
          <p>{content.skills.join(' · ')}</p>
        </section>
      )}
    </article>
  );
}

export default function ResumeBuilder({ csrf }: { csrf: string }) {
  const cache = useQueryClient();
  const owner = useOwner();
  const drafts = useQuery({
    queryKey: ownerKey(owner, 'resume-drafts'),
    queryFn: ({ signal }) => apiParsed('/resume-drafts', parseResumeDraftList, { signal }),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fields, setFields] = useState<DraftFields>(blankDraft);
  const [baseline, setBaseline] = useState(() => serializeDraft(blankDraft));
  const [isNew, setIsNew] = useState(false);
  const [variantOfId, setVariantOfId] = useState<string | null>(null);
  const [jobDescription, setJobDescription] = useState('');
  const [showBefore, setShowBefore] = useState(false);
  const selected = drafts.data?.items.find((item) => item.id === selectedId) ?? null;
  const activeDraft = selected;
  const dirty = isNew || serializeDraft(fields) !== baseline;

  function loadDraft(draft: ResumeDraft) {
    const next = {
      title: draft.title,
      targetRole: draft.targetRole,
      template: draft.template,
      content: draft.content,
    } satisfies DraftFields;
    setSelectedId(draft.id);
    setFields(next);
    setBaseline(serializeDraft(next));
    setIsNew(false);
    setVariantOfId(null);
    setShowBefore(false);
  }

  function setContent<K extends keyof ResumeDraftContent>(key: K, value: ResumeDraftContent[K]) {
    setFields((current) => ({ ...current, content: { ...current.content, [key]: value } }));
  }

  const refresh = (draft: ResumeDraft) => {
    cache.setQueryData(
      ownerKey(owner, 'resume-drafts'),
      (current: { items: ResumeDraft[] } | undefined) => ({
        items: [draft, ...(current?.items ?? []).filter((item) => item.id !== draft.id)],
      }),
    );
    loadDraft(draft);
  };

  const create = useMutation({
    mutationFn: () =>
      apiParsed('/resume-drafts', parseResumeDraft, {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ ...fields, variantOfId }),
      }),
    onSuccess: refresh,
  });
  const save = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('Choose a resume draft first.');
      return apiParsed(`/resume-drafts/${selected.id}`, parseResumeDraft, {
        method: 'PUT',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ ...fields, revision: selected.revision }),
      });
    },
    onSuccess: refresh,
  });
  const approve = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('Choose a resume draft first.');
      return apiParsed(`/resume-drafts/${selected.id}/approve`, parseResumeDraft, {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ revision: selected.revision }),
      });
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('Choose a resume draft first.');
      return apiJson(`/resume-drafts/${selected.id}`, {
        method: 'DELETE',
        headers: { 'x-csrf-token': csrf },
      });
    },
    onSuccess: () => {
      cache.setQueryData(
        ownerKey(owner, 'resume-drafts'),
        (current: { items: ResumeDraft[] } | undefined) => ({
          items: (current?.items ?? []).filter((item) => item.id !== selectedId),
        }),
      );
      setSelectedId(null);
      setFields(blankDraft);
      setBaseline(serializeDraft(blankDraft));
      void cache.invalidateQueries({ queryKey: ownerKey(owner, 'resume-drafts') });
    },
  });

  const keywordResults = useMemo(() => {
    return compareResumeKeywords(
      jobDescription,
      [
        fields.content.fullName,
        fields.content.summary,
        ...fields.content.skills,
        ...fields.content.experience.flatMap((item) => [item.role, item.company, ...item.bullets]),
        ...fields.content.education.flatMap((item) => [item.qualification, item.institution]),
      ].join(' '),
    );
  }, [fields.content, jobDescription]);
  const skillResults = useMemo(
    () =>
      compareResumeSkills(
        jobDescription,
        [
          fields.content.skills.join(' '),
          fields.content.summary,
          ...fields.content.experience.flatMap((item) => [item.role, ...item.bullets]),
        ].join(' '),
      ),
    [fields.content, jobDescription],
  );
  const formatChecks = analyzeResumeFormatting(fields.content, fields.targetRole);
  const busy = create.isPending || save.isPending || approve.isPending || remove.isPending;

  function startNew() {
    if (dirty && !window.confirm('Discard unsaved resume edits and start a new draft?')) return;
    setSelectedId(null);
    setFields(blankDraft);
    setBaseline('');
    setIsNew(true);
    setVariantOfId(null);
    setShowBefore(false);
  }

  function startVariant() {
    if (!selected) return;
    if (dirty && !window.confirm('Discard unsaved resume edits and create a role variant?')) return;
    setSelectedId(null);
    setFields({
      title: `${selected.title.slice(0, 110)} (variant)`,
      targetRole: null,
      template: selected.template,
      content: structuredClone(selected.content),
    });
    setBaseline('');
    setIsNew(true);
    setVariantOfId(selected.id);
    setShowBefore(false);
  }

  function experienceUpdate(
    index: number,
    patch: Partial<ResumeDraftContent['experience'][number]>,
  ) {
    setContent(
      'experience',
      fields.content.experience.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    );
  }

  function educationUpdate(index: number, patch: Partial<ResumeDraftContent['education'][number]>) {
    setContent(
      'education',
      fields.content.education.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    );
  }

  return (
    <section className={styles.builder} aria-labelledby="resume-builder-heading">
      <div className={styles.heading}>
        <div>
          <h2 id="resume-builder-heading">Resume Builder</h2>
          <p>Build a role-specific resume from facts you enter and review each change yourself.</p>
        </div>
        <button type="button" onClick={startNew} disabled={busy}>
          New resume
        </button>
        {selected && !isNew && (
          <button type="button" onClick={startVariant} disabled={busy}>
            Create role variant
          </button>
        )}
      </div>
      {drafts.isPending ? (
        <p role="status">Loading resume drafts…</p>
      ) : drafts.isError ? (
        <ErrorState
          variant="inline"
          what="Could not load resume drafts."
          detail={drafts.error.message}
        />
      ) : drafts.data.items.length === 0 && !isNew ? (
        <EmptyState
          variant="inline"
          reason="nothing-yet"
          message="No editable resume drafts yet. Start a new resume to begin."
        />
      ) : (
        <>
          {drafts.data.items.length > 0 && (
            <nav className={styles.draftList} aria-label="Resume drafts">
              {drafts.data.items.map((draft) => (
                <button
                  key={draft.id}
                  type="button"
                  aria-pressed={selectedId === draft.id}
                  onClick={() => {
                    if (!dirty || window.confirm('Discard unsaved resume edits?')) {
                      loadDraft(draft);
                    }
                  }}
                >
                  {draft.title} · {draft.targetRole ?? 'General'} · v{draft.revision}
                  {draft.variantOfId ? ' · Variant' : ''}
                  {draft.approvedAt ? ' · Approved' : ''}
                </button>
              ))}
            </nav>
          )}
          {!selected && !isNew && drafts.data.items.length > 0 && (
            <p role="status">Select a resume draft to edit.</p>
          )}
          {(activeDraft || isNew) && (
            <div className={styles.workspace}>
              <form
                className={styles.editor}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (isNew) create.mutate();
                  else save.mutate();
                }}
              >
                <div className={styles.controls}>
                  <label>
                    Resume name
                    <input
                      required
                      maxLength={120}
                      value={fields.title}
                      onChange={(event) => setFields({ ...fields, title: event.target.value })}
                    />
                  </label>
                  <label>
                    Target role
                    <input
                      required={Boolean(variantOfId)}
                      maxLength={80}
                      value={fields.targetRole ?? ''}
                      onChange={(event) =>
                        setFields({
                          ...fields,
                          targetRole: event.target.value.trim() ? event.target.value : null,
                        })
                      }
                    />
                  </label>
                  <label>
                    Template
                    <select
                      value={fields.template}
                      onChange={(event) =>
                        setFields({
                          ...fields,
                          template: event.target.value as DraftFields['template'],
                        })
                      }
                    >
                      <option value="classic">Classic</option>
                      <option value="modern">Modern</option>
                      <option value="compact">Compact</option>
                    </select>
                  </label>
                </div>
                <h3>Contact</h3>
                <div className={styles.controls}>
                  <label>
                    Full name
                    <input
                      required
                      maxLength={120}
                      value={fields.content.fullName}
                      onChange={(event) => setContent('fullName', event.target.value)}
                    />
                  </label>
                  <label>
                    Email
                    <input
                      type="email"
                      maxLength={254}
                      value={fields.content.email ?? ''}
                      onChange={(event) => setContent('email', event.target.value || null)}
                    />
                  </label>
                  <label>
                    Phone
                    <input
                      maxLength={40}
                      value={fields.content.phone ?? ''}
                      onChange={(event) => setContent('phone', event.target.value || null)}
                    />
                  </label>
                  <label>
                    Location
                    <input
                      maxLength={120}
                      value={fields.content.location ?? ''}
                      onChange={(event) => setContent('location', event.target.value || null)}
                    />
                  </label>
                </div>
                <label>
                  Professional summary
                  <textarea
                    maxLength={2400}
                    rows={4}
                    value={fields.content.summary}
                    onChange={(event) => setContent('summary', event.target.value)}
                  />
                </label>
                <div className={styles.sectionHeading}>
                  <h3>Experience</h3>
                  <button
                    type="button"
                    onClick={() =>
                      setContent('experience', [
                        ...fields.content.experience,
                        {
                          id: crypto.randomUUID(),
                          role: '',
                          company: '',
                          location: null,
                          startDate: null,
                          endDate: null,
                          bullets: [],
                        },
                      ])
                    }
                  >
                    Add role
                  </button>
                </div>
                {fields.content.experience.map((item, index) => (
                  <fieldset key={item.id} className={styles.entry}>
                    <legend>Role {index + 1}</legend>
                    <div className={styles.controls}>
                      <label>
                        Role title
                        <input
                          required
                          maxLength={120}
                          value={item.role}
                          onChange={(event) =>
                            experienceUpdate(index, { role: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Company
                        <input
                          required
                          maxLength={120}
                          value={item.company}
                          onChange={(event) =>
                            experienceUpdate(index, { company: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Location
                        <input
                          maxLength={120}
                          value={item.location ?? ''}
                          onChange={(event) =>
                            experienceUpdate(index, { location: event.target.value || null })
                          }
                        />
                      </label>
                      <label>
                        Start date
                        <input
                          maxLength={32}
                          value={item.startDate ?? ''}
                          onChange={(event) =>
                            experienceUpdate(index, { startDate: event.target.value || null })
                          }
                        />
                      </label>
                      <label>
                        End date
                        <input
                          maxLength={32}
                          value={item.endDate ?? ''}
                          onChange={(event) =>
                            experienceUpdate(index, { endDate: event.target.value || null })
                          }
                        />
                      </label>
                    </div>
                    <label>
                      Achievement bullets (one per line)
                      <textarea
                        rows={4}
                        value={item.bullets.join('\n')}
                        onChange={(event) =>
                          experienceUpdate(index, {
                            bullets: event.target.value
                              .split('\n')
                              .map((line) => line.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setContent(
                          'experience',
                          fields.content.experience.filter((entry) => entry.id !== item.id),
                        )
                      }
                    >
                      Remove role
                    </button>
                  </fieldset>
                ))}
                <div className={styles.sectionHeading}>
                  <h3>Education</h3>
                  <button
                    type="button"
                    onClick={() =>
                      setContent('education', [
                        ...fields.content.education,
                        {
                          id: crypto.randomUUID(),
                          institution: '',
                          qualification: '',
                          location: null,
                          endDate: null,
                        },
                      ])
                    }
                  >
                    Add education
                  </button>
                </div>
                {fields.content.education.map((item, index) => (
                  <fieldset key={item.id} className={styles.entry}>
                    <legend>Education {index + 1}</legend>
                    <div className={styles.controls}>
                      <label>
                        Institution
                        <input
                          required
                          maxLength={160}
                          value={item.institution}
                          onChange={(event) =>
                            educationUpdate(index, { institution: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Qualification
                        <input
                          required
                          maxLength={120}
                          value={item.qualification}
                          onChange={(event) =>
                            educationUpdate(index, { qualification: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        Location
                        <input
                          maxLength={120}
                          value={item.location ?? ''}
                          onChange={(event) =>
                            educationUpdate(index, { location: event.target.value || null })
                          }
                        />
                      </label>
                      <label>
                        Completion date
                        <input
                          maxLength={32}
                          value={item.endDate ?? ''}
                          onChange={(event) =>
                            educationUpdate(index, { endDate: event.target.value || null })
                          }
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setContent(
                          'education',
                          fields.content.education.filter((entry) => entry.id !== item.id),
                        )
                      }
                    >
                      Remove education
                    </button>
                  </fieldset>
                ))}
                <label>
                  Skills (comma-separated)
                  <input
                    value={fields.content.skills.join(', ')}
                    onChange={(event) =>
                      setContent(
                        'skills',
                        event.target.value
                          .split(',')
                          .map((skill) => skill.trim())
                          .filter(Boolean),
                      )
                    }
                  />
                </label>
                <div className={styles.actions}>
                  <button type="submit" disabled={busy || !dirty}>
                    {busy
                      ? 'Saving…'
                      : isNew
                        ? variantOfId
                          ? 'Create role variant'
                          : 'Create resume'
                        : 'Save changes'}
                  </button>
                  {!isNew && activeDraft && !dirty && !activeDraft.approvedAt && (
                    <button type="button" onClick={() => approve.mutate()} disabled={busy}>
                      Approve this version
                    </button>
                  )}
                  {activeDraft && (
                    <button type="button" onClick={() => window.print()}>
                      Print or save as PDF
                    </button>
                  )}
                  {activeDraft && (
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('Delete this resume draft?')) remove.mutate();
                      }}
                      disabled={busy}
                    >
                      Delete draft
                    </button>
                  )}
                </div>
                {activeDraft?.approvedAt && (
                  <p role="status">
                    Approved by you on {new Date(activeDraft.approvedAt).toLocaleString()} ·
                    revision {activeDraft.revision}
                  </p>
                )}
                {dirty && activeDraft?.approvedAt && (
                  <p role="status">Editing clears your previous approval when you save.</p>
                )}
                {create.error && (
                  <ErrorState
                    variant="inline"
                    what="Could not create the resume draft."
                    detail={create.error.message}
                  />
                )}
                {save.error && (
                  <ErrorState
                    variant="inline"
                    what="Could not save the resume draft."
                    detail={save.error.message}
                  />
                )}
                {approve.error && (
                  <ErrorState
                    variant="inline"
                    what="Could not approve this resume version."
                    detail={approve.error.message}
                  />
                )}
                {remove.error && (
                  <ErrorState
                    variant="inline"
                    what="Could not delete the resume draft."
                    detail={remove.error.message}
                  />
                )}
              </form>
              <aside className={styles.analysis} aria-label="Resume review tools">
                <div className={styles.sectionHeading}>
                  <h3>Preview</h3>
                  {activeDraft && (
                    <button
                      type="button"
                      onClick={() => setShowBefore((value) => !value)}
                      disabled={!dirty}
                    >
                      {showBefore ? 'Show current edits' : 'Compare with saved version'}
                    </button>
                  )}
                </div>
                <ResumePreview
                  draft={
                    showBefore && activeDraft
                      ? {
                          title: activeDraft.title,
                          targetRole: activeDraft.targetRole,
                          template: activeDraft.template,
                          content: activeDraft.content,
                        }
                      : fields
                  }
                  print
                />
                <section aria-labelledby="format-review-heading">
                  <h3 id="format-review-heading">Formatting review</h3>
                  <p>Rule-based guidance only. This is not an ATS score or guarantee.</p>
                  <ul>
                    {formatChecks.map((check) => (
                      <li key={check.label}>
                        {check.passed ? 'Ready' : 'Review'} · {check.label}
                      </li>
                    ))}
                  </ul>
                </section>
                <section aria-labelledby="keyword-review-heading">
                  <h3 id="keyword-review-heading">Job keyword comparison</h3>
                  <label>
                    Paste job description
                    <textarea
                      rows={5}
                      value={jobDescription}
                      onChange={(event) => setJobDescription(event.target.value)}
                    />
                  </label>
                  {jobDescription && (
                    <>
                      <p>
                        Literal token and adjacent-phrase comparison; plural normalization is
                        conservative.
                      </p>
                      <p>
                        Matched terms:{' '}
                        {keywordResults.matched.join(', ') || 'None found in your resume text.'}
                      </p>
                      <p>
                        Terms to review:{' '}
                        {keywordResults.missing.slice(0, 30).join(', ') ||
                          'No unmatched terms found.'}
                      </p>
                      <p>Known skills from the job description to review in your resume:</p>
                      <ul>
                        {skillResults.toReview.map((skill) => (
                          <li key={skill}>{skill}</li>
                        ))}
                        {skillResults.toReview.length === 0 && <li>No unmatched known skills.</li>}
                      </ul>
                      <p>Only add a skill if it accurately describes your experience.</p>
                    </>
                  )}
                  <p>
                    This is a text comparison, not a qualification judgment. Add only skills and
                    facts that are true for you.
                  </p>
                </section>
                <section className={styles.aiGate} aria-label="AI writing assistance">
                  <h3>AI writing assistance</h3>
                  <p>
                    AI bullet rewriting, cover letters, and application-answer assistance are not
                    enabled. No provider is called and no AI-generated claims are inserted.
                  </p>
                </section>
              </aside>
            </div>
          )}
        </>
      )}
    </section>
  );
}
