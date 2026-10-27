import { describe, expect, it } from 'vitest';
import {
  candidateSeniority,
  levelOf,
  levelToLabel,
  seniorityOf,
  yearsToLevel,
} from './seniority.js';

describe('seniorityOf', () => {
  it('reads the plain labels', () => {
    expect(seniorityOf('Senior Software Engineer')).toBe('senior');
    expect(seniorityOf('Junior Developer')).toBe('junior');
    expect(seniorityOf('Principal Engineer')).toBe('principal');
    expect(seniorityOf('Software Engineering Intern')).toBe('intern');
  });

  it('takes the highest rung when a title names two', () => {
    // "Senior Staff" is a staff-level title, not a senior one.
    expect(seniorityOf('Senior Staff Software Engineer')).toBe('staff');
    expect(seniorityOf('Principal Staff Architect')).toBe('principal');
  });

  it('reads Amazon-style ladder titles', () => {
    expect(seniorityOf('SDE I')).toBe('junior');
    expect(seniorityOf('SDE II')).toBe('senior');
    expect(seniorityOf('SDE III')).toBe('staff');
  });

  it('treats architect and head-of as principal', () => {
    expect(seniorityOf('Solutions Architect')).toBe('principal');
    expect(seniorityOf('Head of Engineering')).toBe('principal');
  });

  it('reads "lead" and "manager" only as engineering leadership titles', () => {
    expect(seniorityOf('Lead Software Engineer')).toBe('staff');
    expect(seniorityOf('Tech Lead')).toBe('staff');
    expect(seniorityOf('Engineering Manager')).toBe('staff');
    expect(seniorityOf('Backend Engineer, Lead')).toBe('staff');
    expect(seniorityOf('Lead Generation Executive')).toBeNull();
    expect(seniorityOf('Account Manager')).toBeNull();
    expect(seniorityOf('Lead Nurturing Specialist')).toBeNull();
  });

  it('reads "fellow" as principal only when it is a title word', () => {
    expect(seniorityOf('Distinguished Fellow')).toBe('principal');
    expect(seniorityOf('Engineering Fellow')).toBe('principal');
    expect(seniorityOf('Fellow, Machine Learning')).toBe('principal');
    expect(seniorityOf('Fellowship Program Coordinator')).toBeNull();
    expect(seniorityOf('Support Engineer for Fellow Travellers App')).toBeNull();
  });

  it('returns null when the title says nothing about level', () => {
    expect(seniorityOf('Software Engineer')).toBeNull();
    expect(seniorityOf('Full Stack Developer')).toBeNull();
  });
});

describe('yearsToLevel', () => {
  it('maps the conventional ladder', () => {
    expect(yearsToLevel(0.5)).toBe('intern');
    expect(yearsToLevel(2)).toBe('junior');
    expect(yearsToLevel(4)).toBe('mid');
    expect(yearsToLevel(7)).toBe('senior');
    expect(yearsToLevel(11)).toBe('staff');
    expect(yearsToLevel(20)).toBe('principal');
  });
});

describe('candidateSeniority', () => {
  it('lets experience raise a modest title', () => {
    // Consultancies hand "Associate" to people with six years behind them.
    expect(candidateSeniority(['Associate Engineer'], 7)).toBe('senior');
  });

  it('lets a title outrank thin experience', () => {
    expect(candidateSeniority(['Staff Engineer'], 3)).toBe('staff');
  });

  it('falls back to years when no title carries a level', () => {
    expect(candidateSeniority(['Full Stack Software Engineer'], 4)).toBe('mid');
  });

  it('handles an empty title list', () => {
    expect(candidateSeniority([], 4)).toBe('mid');
  });

  it('returns unknown when neither title nor experience is known', () => {
    expect(candidateSeniority([], null)).toBeNull();
  });

  it('uses an explicitly stated title when years are unknown', () => {
    expect(candidateSeniority(['Senior Engineer'], null)).toBe('senior');
  });
});

describe('levelToLabel / levelOf', () => {
  it('round-trips every rung', () => {
    for (const label of ['intern', 'junior', 'mid', 'senior', 'staff', 'principal'] as const) {
      expect(levelToLabel(levelOf(label))).toBe(label);
    }
  });

  it('clamps out-of-range levels rather than returning undefined', () => {
    expect(levelToLabel(-4)).toBe('intern');
    expect(levelToLabel(99)).toBe('principal');
  });
});
