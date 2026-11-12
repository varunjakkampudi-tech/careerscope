import assert from 'node:assert/strict';
import test from 'node:test';
import { derivedResumeSchema } from '@careerscope/shared';
import { assessResumeQuality } from './resume-quality.js';

const emptyDerived = derivedResumeSchema.parse({
  techStack: [],
  recentSkills: [],
  titles: [],
  yearsOfExperience: null,
  education: [],
  educationClaims: [],
  experienceClaims: [],
  extractionEvidence: [],
});

test('resume quality report labels parser omissions without assigning a quality score', () => {
  const report = assessResumeQuality('  extracted text  ', emptyDerived);

  assert.equal(report.extractedCharacters, 14);
  assert.deepEqual(
    report.checks.map(({ section, detected }) => [section, detected]),
    [
      ['skills', false],
      ['experience', false],
      ['education', false],
    ],
  );
  assert.equal('score' in report, false);
});

test('resume quality report recognizes parser evidence for each section', () => {
  const derived = derivedResumeSchema.parse({
    ...emptyDerived,
    techStack: ['TypeScript'],
    titles: ['Software Engineer'],
    yearsOfExperience: 0,
    education: ['BSc Computer Science'],
  });
  const report = assessResumeQuality('Resume text', derived);

  assert.equal(report.extractedCharacters, 11);
  assert.deepEqual(
    report.checks.map(({ detected }) => detected),
    [true, true, true],
  );
});

test('resume quality report treats claims as detections even when normalized lists are empty', () => {
  const derived = derivedResumeSchema.parse({
    ...emptyDerived,
    educationClaims: [
      {
        normalizedText: 'BSc Computer Science',
        sourceText: 'Bachelor of Science in Computer Science',
        sourceSection: 'education',
        extractionConfidence: 'unverified',
        credentialStatus: 'unverified',
      },
    ],
    experienceClaims: [
      {
        normalizedText: 'Software Engineer at Example Co',
        sourceText: 'Software Engineer at Example Co 2020 - 2023',
        sourceSection: 'experience',
        extractionConfidence: 'unverified',
        claimStatus: 'unverified',
        startDate: Date.UTC(2020, 0, 1),
        endDate: Date.UTC(2023, 0, 1),
      },
    ],
  });

  assert.deepEqual(
    assessResumeQuality('Experience and education', derived).checks.map(({ detected }) => detected),
    [false, true, true],
  );
});
