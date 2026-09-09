import { describe, expect, it } from 'vitest';
import {
  extractSkills,
  isRelatedSkill,
  normalizeSkill,
  normalizeSkillList,
  skillRarity,
} from './skills.js';

describe('normalizeSkill', () => {
  it('collapses the spellings boards actually use', () => {
    expect(normalizeSkill('react.js')).toBe('React');
    expect(normalizeSkill('ReactJS')).toBe('React');
    expect(normalizeSkill('nodejs')).toBe('Node.js');
    expect(normalizeSkill('k8s')).toBe('Kubernetes');
    expect(normalizeSkill('postgres')).toBe('PostgreSQL');
    expect(normalizeSkill('golang')).toBe('Go');
    expect(normalizeSkill('asp.net')).toBe('.NET');
  });

  it('returns null for things it does not know', () => {
    expect(normalizeSkill('telepathy')).toBeNull();
    expect(normalizeSkill('  ')).toBeNull();
  });

  it('keeps unknown entries when normalising a user list', () => {
    expect(normalizeSkillList(['reactjs', 'React', 'InternalTool', 'nodejs'])).toEqual([
      'React',
      'InternalTool',
      'Node.js',
    ]);
  });
});

describe('extractSkills', () => {
  it('finds skills in a realistic job description', () => {
    const jd = `We are looking for a Senior Full Stack Engineer.
      Required: 4+ years with React, TypeScript and Node.js. Strong SQL (PostgreSQL).
      Nice to have: Docker, Kubernetes, and experience with GraphQL APIs.`;
    const found = extractSkills(jd);
    expect(found).toEqual(
      expect.arrayContaining([
        'React',
        'TypeScript',
        'Node.js',
        'SQL',
        'PostgreSQL',
        'Docker',
        'Kubernetes',
        'GraphQL',
      ]),
    );
  });

  it('does not match a skill name inside a longer word', () => {
    // "reactive" must not register React, and "javascripting" is not JavaScript.
    expect(extractSkills('We favour reactive streams and declarative config')).not.toContain(
      'React',
    );
    expect(extractSkills('nodes in the cluster')).not.toContain('Node.js');
  });

  it('requires context before accepting ambiguous short names', () => {
    // The single most common false positive: "go" as an ordinary verb.
    expect(extractSkills('You will go to market with the team and go beyond')).not.toContain('Go');
    expect(extractSkills('We move fast and scala…')).not.toContain('Scala');
    expect(extractSkills('Languages: Java, Go, Rust')).toEqual(
      expect.arrayContaining(['Java', 'Go', 'Rust']),
    );
    expect(extractSkills('Looking for a Go developer')).toContain('Go');
    expect(extractSkills('Services written in Go and deployed on k8s')).toContain('Go');
  });

  it('handles punctuation-bearing names that \\b cannot', () => {
    expect(extractSkills('Strong C++ and C# background')).toEqual(
      expect.arrayContaining(['C++', 'C#']),
    );
    expect(extractSkills('Built on ASP.NET Core')).toContain('.NET');
    expect(extractSkills('Uses Next.js and Tailwind CSS')).toEqual(
      expect.arrayContaining(['Next.js', 'Tailwind CSS']),
    );
  });

  it('is empty for empty input', () => {
    expect(extractSkills('')).toEqual([]);
  });
});

describe('rarity and families', () => {
  it('weights differentiating skills above ubiquitous ones', () => {
    expect(skillRarity('Temporal')).toBeGreaterThan(skillRarity('JavaScript'));
    expect(skillRarity('Kubernetes')).toBeGreaterThan(skillRarity('Git'));
  });

  it('gives unknown skills a mid weight rather than dropping them', () => {
    expect(skillRarity('SomeInternalFramework')).toBeGreaterThan(1);
  });

  it('relates skills that substitute for each other', () => {
    expect(isRelatedSkill('React', 'Vue')).toBe(true);
    expect(isRelatedSkill('PostgreSQL', 'MySQL')).toBe(true);
    expect(isRelatedSkill('React', 'PostgreSQL')).toBe(false);
    expect(isRelatedSkill('React', 'React')).toBe(false);
  });
});
