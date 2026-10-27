import assert from 'node:assert/strict';
import test from 'node:test';
import type { LeadRecord } from '@careerscope/core';
import { applicationsCsv } from './application-export.js';

test('application CSV exports candidate claims and escapes spreadsheet formulas', () => {
  const record: LeadRecord = {
    id: 'application-id',
    data: {
      fingerprint: 'job-fingerprint',
      title: '=HYPERLINK("https://attacker.test")',
      company: 'Acme, "Research"',
      location: 'Bengaluru\nIndia',
      description: 'Private source description is not exported',
      source: 'greenhouse',
      sourceUrl: 'https://jobs.example.test/role',
      applyUrl: 'https://jobs.example.test/apply',
      postedAt: null,
      match: null,
    },
    notes: ' +SUM(1,1)\r\nCandidate note',
    status: 'applied',
    applicationEvidence: {
      method: 'Employer site',
      appliedAt: '2026-10-20T12:00:00.000Z',
      confirmation: 'unknown',
      source: 'Candidate entry',
      confidence: 'medium',
    },
    livenessStatus: 'unknown',
    livenessCheckedAt: null,
    employerAcknowledgement: null,
    tags: [],
    revision: 2,
    createdAt: new Date('2026-10-19T00:00:00.000Z'),
    updatedAt: new Date('2026-10-20T12:30:00.000Z'),
  };

  const csv = applicationsCsv([record]);
  assert.match(csv, /^"Job title","Company","Location"/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/attacker\.test""\)"/);
  assert.match(csv, /"Acme, ""Research"""/);
  assert.match(csv, /"Bengaluru\nIndia"/);
  assert.match(csv, /"' \+SUM\(1,1\)\r\nCandidate note"/);
  assert.match(csv, /"Candidate-reported confirmation"/);
  assert.match(csv, /"unknown","medium","Candidate entry"/);
  assert.doesNotMatch(csv, /Private source description|application-id|job-fingerprint/);
  assert.equal(csv.endsWith('\r\n'), true);
});

test('empty application export contains only its stable CSV header', () => {
  const csv = applicationsCsv([]);
  assert.equal(csv.split('\r\n').length, 2);
  assert.match(csv, /^"Job title".*"Notes"\r\n$/);
});
