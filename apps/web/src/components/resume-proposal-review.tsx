'use client';

import { useEffect, useRef, useState } from 'react';
import {
  localizedText,
  localizedValue,
  useInterfaceLocale,
  type InterfaceMessage,
} from '../lib/locale';
import type { ResumeProposal } from '../lib/api-schemas';
import styles from './resume-proposal-review.module.css';

export type AcceptedResumeProposal = Partial<Omit<ResumeProposal, 'experienceClaims'>> & {
  experience?: string[];
};

type ProposalField = {
  id:
    | 'fullName'
    | 'email'
    | 'phone'
    | 'location'
    | 'linkedin'
    | 'github'
    | 'portfolio'
    | 'techStack'
    | 'titles'
    | 'yearsOfExperience'
    | 'education'
    | 'experience';
  value: string;
  kind: 'text' | 'list' | 'number';
  evidence: string[];
};

function proposalFields(proposal: ResumeProposal): ProposalField[] {
  const evidenceFor = (field: string) =>
    proposal.extractionEvidence
      .filter((entry) => entry.field === field)
      .map((entry) => entry.sourceText);
  const fields: ProposalField[] = [];
  for (const id of [
    'fullName',
    'email',
    'phone',
    'location',
    'linkedin',
    'github',
    'portfolio',
  ] as const) {
    const value = proposal[id];
    if (value) fields.push({ id, value, kind: 'text', evidence: [] });
  }
  const skills = [...new Set([...proposal.techStack, ...proposal.recentSkills])];
  if (skills.length)
    fields.push({
      id: 'techStack',
      value: skills.join('\n'),
      kind: 'list',
      evidence: [...evidenceFor('techStack'), ...evidenceFor('recentSkills')],
    });
  if (proposal.titles.length)
    fields.push({
      id: 'titles',
      value: proposal.titles.join('\n'),
      kind: 'list',
      evidence: evidenceFor('titles'),
    });
  if (proposal.yearsOfExperience !== null)
    fields.push({
      id: 'yearsOfExperience',
      value: String(proposal.yearsOfExperience),
      kind: 'number',
      evidence: evidenceFor('yearsOfExperience'),
    });
  const education = proposal.educationClaims.length
    ? proposal.educationClaims.map((claim) => claim.normalizedText)
    : proposal.education;
  if (education.length)
    fields.push({
      id: 'education',
      value: education.join('\n'),
      kind: 'list',
      evidence: [
        ...proposal.educationClaims.map((claim) => claim.sourceText),
        ...evidenceFor('education'),
      ],
    });
  if (proposal.experienceClaims.length)
    fields.push({
      id: 'experience',
      value: proposal.experienceClaims.map((claim) => claim.normalizedText).join('\n'),
      kind: 'list',
      evidence: [
        ...proposal.experienceClaims.map((claim) => claim.sourceText),
        ...evidenceFor('experience'),
      ],
    });
  return fields;
}

export default function ResumeProposalReview({
  proposal,
  sourceName,
  onApply,
  onDirty,
  onCancel,
}: {
  proposal: ResumeProposal;
  sourceName: string;
  onApply: (accepted: AcceptedResumeProposal) => void;
  onDirty: () => void;
  onCancel: () => void;
}) {
  const locale = useInterfaceLocale();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fields = proposalFields(proposal);
  const [values, setValues] = useState(() =>
    Object.fromEntries(fields.map((field) => [field.id, field.value])),
  );
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const selectedCount = Object.values(accepted).filter(Boolean).length;
  const invalidNumber = fields.some((field) => {
    if (field.id !== 'yearsOfExperience' || !accepted[field.id]) return false;
    const value = values[field.id]?.trim() ?? '';
    return (
      value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 60)
    );
  });

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  function apply() {
    const corrected: AcceptedResumeProposal = {};
    for (const field of fields) {
      if (!accepted[field.id]) continue;
      const value = values[field.id] ?? '';
      if (field.id === 'yearsOfExperience') {
        corrected.yearsOfExperience = value.trim() ? Number(value) : null;
      } else if (field.kind === 'list') {
        const entries = value
          .split('\n')
          .map((entry) => entry.trim())
          .filter(Boolean);
        if (field.id === 'techStack') corrected.techStack = entries;
        else if (field.id === 'titles') corrected.titles = entries;
        else if (field.id === 'education') corrected.education = entries;
        else if (field.id === 'experience') corrected.experience = entries;
      } else {
        switch (field.id) {
          case 'fullName':
            corrected.fullName = value;
            break;
          case 'email':
            corrected.email = value;
            break;
          case 'phone':
            corrected.phone = value;
            break;
          case 'location':
            corrected.location = value;
            break;
          case 'linkedin':
            corrected.linkedin = value;
            break;
          case 'github':
            corrected.github = value;
            break;
          case 'portfolio':
            corrected.portfolio = value;
            break;
        }
      }
    }
    onApply(corrected);
  }

  return (
    <section aria-labelledby="resume-proposal-heading" className={styles.review}>
      <h2 ref={headingRef} id="resume-proposal-heading" tabIndex={-1}>
        {localizedText(locale, 'resumeReviewHeading')}
      </h2>
      <p className={styles.source}>
        {localizedValue(locale, 'resumeReviewSelectedSource', sourceName)}
      </p>
      <p>{localizedText(locale, 'resumeReviewDescription')}</p>
      <p className={styles.notice}>{localizedText(locale, 'resumeReviewNotice')}</p>
      {fields.length === 0 ? (
        <p role="status">{localizedText(locale, 'resumeReviewEmpty')}</p>
      ) : (
        <div className={styles.fields}>
          {fields.map((field) => {
            const label = localizedText(
              locale,
              `resumeReviewField_${field.id}` as InterfaceMessage,
            );
            const value = values[field.id] ?? '';
            const inputId = `resume-review-${field.id}`;
            const evidence = [...new Set(field.evidence)];
            return (
              <fieldset className={styles.field} key={field.id}>
                <legend>{label}</legend>
                <label className={styles.accept}>
                  <input
                    type="checkbox"
                    checked={accepted[field.id] ?? false}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setAccepted((current) => ({
                        ...current,
                        [field.id]: checked,
                      }));
                      onDirty();
                    }}
                  />
                  {localizedText(locale, 'resumeReviewUseField')}
                </label>
                {field.kind === 'list' ? (
                  <textarea
                    id={inputId}
                    aria-label={localizedValue(locale, 'resumeReviewCorrectField', label)}
                    rows={Math.min(Math.max(value.split('\n').length, 2), 6)}
                    value={value}
                    onChange={(event) => {
                      const correctedValue = event.currentTarget.value;
                      setValues((current) => ({
                        ...current,
                        [field.id]: correctedValue,
                      }));
                      onDirty();
                    }}
                  />
                ) : (
                  <input
                    id={inputId}
                    aria-label={localizedValue(locale, 'resumeReviewCorrectField', label)}
                    type={field.kind === 'number' ? 'number' : 'text'}
                    min={field.kind === 'number' ? 0 : undefined}
                    max={field.kind === 'number' ? 60 : undefined}
                    step={field.kind === 'number' ? 0.5 : undefined}
                    value={value}
                    onChange={(event) => {
                      const correctedValue = event.currentTarget.value;
                      setValues((current) => ({
                        ...current,
                        [field.id]: correctedValue,
                      }));
                      onDirty();
                    }}
                  />
                )}
                {evidence.length > 0 && (
                  <details>
                    <summary>{localizedText(locale, 'resumeReviewSource')}</summary>
                    <ul>
                      {evidence.map((source, index) => (
                        <li key={`${index}:${source}`}>{source}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </fieldset>
            );
          })}
        </div>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className="primary"
          onClick={apply}
          disabled={selectedCount === 0 || invalidNumber}
        >
          {localizedText(locale, 'resumeReviewApply')}
        </button>
        <button type="button" onClick={onCancel}>
          {localizedText(locale, 'resumeReviewCancel')}
        </button>
      </div>
    </section>
  );
}
