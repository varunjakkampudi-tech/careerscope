import { z } from 'zod';
import type { ProfileRecord } from './profile.js';

const evidenceSchema = z
  .object({
    field: z.enum([
      'preferences.titles',
      'preferences.techStack',
      'candidate.portfolio',
      'application.yearsOfExperience',
      'application.noticePeriodDays',
    ]),
    value: z.string().max(160),
  })
  .strict();

export const preparationReportSchema = z
  .object({
    method: z.literal('rules-v1'),
    profileRevision: z.number().int().nonnegative(),
    status: z.enum(['profile-required', 'review-required']),
    limitations: z.array(z.string().max(240)).max(4),
    checks: z
      .array(
        z
          .object({
            id: z.string().max(60),
            title: z.string().max(120),
            state: z.enum(['review', 'not-assessed']),
            detail: z.string().max(300),
            evidence: z.array(evidenceSchema).max(5),
          })
          .strict(),
      )
      .max(6),
    questions: z
      .array(
        z
          .object({
            id: z.string().max(60),
            kind: z.enum(['clarification', 'practice']),
            question: z.string().max(300),
            evidence: z.array(evidenceSchema).max(5),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

export type PreparationReport = z.infer<typeof preparationReportSchema>;

export function prepareProfile(record: ProfileRecord | null): PreparationReport {
  const report: PreparationReport = {
    method: 'rules-v1',
    profileRevision: record?.revision ?? 0,
    status: record ? 'review-required' : 'profile-required',
    limitations: [
      'Rules-based preparation, not an AI assessment or hiring prediction.',
      'Saved profile statements are self-reported, not verified qualifications.',
      'Resume formatting, work history, achievements and job-specific fit are not assessed.',
    ],
    checks: [],
    questions: [],
  };
  if (!record) return preparationReportSchema.parse(report);
  const { profile } = record;
  const evidence = (field: z.infer<typeof evidenceSchema>['field'], value: string) => ({
    field,
    value: value.slice(0, 160),
  });
  const roles = profile.preferences.titles
    .slice(0, 5)
    .map((value) => evidence('preferences.titles', value));
  report.checks = [
    {
      id: 'target',
      title: 'Target role',
      state: 'review',
      detail: 'Confirm your resume emphasizes evidence relevant to your target role.',
      evidence: roles,
    },
    {
      id: 'experience',
      title: 'Experience and availability',
      state: 'review',
      detail:
        'Confirm experience and notice period. Zero can be a valid answer or a saved default.',
      evidence: [
        evidence('application.yearsOfExperience', String(profile.application.yearsOfExperience)),
        evidence('application.noticePeriodDays', String(profile.application.noticePeriodDays)),
      ],
    },
    {
      id: 'work-evidence',
      title: 'Examples of your work',
      state: 'review',
      detail:
        profile.candidate.portfolio || profile.candidate.github
          ? 'Review your work links for relevance and accuracy. Their contents have not been inspected.'
          : 'Consider adding a work sample where relevant. A public portfolio is optional.',
      evidence: [],
    },
    {
      id: 'resume',
      title: 'Resume evidence and layout',
      state: 'not-assessed',
      detail:
        'Review dates, responsibilities, measurable outcomes and PDF layout in the original resume. This report does not inspect the document.',
      evidence: [],
    },
  ];
  report.questions = [
    {
      id: 'role',
      kind: 'clarification',
      question: 'Which target role is your priority, and what evidence in your resume supports it?',
      evidence: roles,
    },
    {
      id: 'experience',
      kind: 'clarification',
      question:
        'Are your saved years of experience and notice period accurate, including any zero values?',
      evidence: report.checks[1]!.evidence,
    },
    {
      id: 'outcome',
      kind: 'practice',
      question:
        'Describe a real project: what was your responsibility, what decision did you make, and what outcome can you substantiate?',
      evidence: [],
    },
    {
      id: 'tradeoff',
      kind: 'practice',
      question:
        'Describe a technical trade-off you made. What alternatives did you consider, and what would you change now?',
      evidence: [],
    },
    ...profile.preferences.techStack.slice(0, 5).map((skill, index) => ({
      id: `skill-${index + 1}`,
      kind: 'practice' as const,
      question:
        'For this listed skill, describe an example you personally worked on, how you tested it, and what you learned. If you have no example, clarify your level.',
      evidence: [evidence('preferences.techStack', skill)],
    })),
  ];
  return preparationReportSchema.parse(report);
}
