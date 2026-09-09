import { describe, expect, it } from 'vitest';
import { ALL_SOURCES } from '@job-radar/shared';
import { DEFAULT_BOARDS, boardsFor, mergeBoards, type BoardRef } from './boards.js';

describe('DEFAULT_BOARDS', () => {
  it('has no duplicate slug within a source — a duplicate is a wasted board fetch', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const board of DEFAULT_BOARDS) {
      const key = `${board.source}:${board.slug.toLowerCase()}`;
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });

  it('names every board, since three of the six APIs never return a company name', () => {
    const unnamed = DEFAULT_BOARDS.filter((board) => board.company.trim().length === 0);
    expect(unnamed).toEqual([]);
  });

  it('only uses source ids the rest of the app knows about', () => {
    const unknown = DEFAULT_BOARDS.filter((board) => !ALL_SOURCES.includes(board.source));
    expect(unknown).toEqual([]);
  });

  it('carries slugs that are safe to interpolate into a URL', () => {
    const unsafe = DEFAULT_BOARDS.filter(
      (board) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(board.slug),
    );
    expect(unsafe).toEqual([]);
  });

  it('lists India-relevant boards first, so a truncated run still covers the home market', () => {
    const firstGlobal = DEFAULT_BOARDS.findIndex((board) => board.company === 'Stripe');
    const lastIndia = DEFAULT_BOARDS.map((board) => board.company).lastIndexOf('Newton School');
    expect(lastIndia).toBeGreaterThan(-1);
    expect(firstGlobal).toBeGreaterThan(lastIndia);
  });

  it('gives every ATS at least one board, or that provider is dead weight', () => {
    for (const source of [
      'greenhouse',
      'lever',
      'ashby',
      'workable',
      'smartrecruiters',
      'recruitee',
    ] as const) {
      expect(boardsFor(source).length, source).toBeGreaterThan(0);
    }
  });
});

describe('boardsFor', () => {
  it('returns only the named source', () => {
    const boards = boardsFor('lever');
    expect(boards.length).toBeGreaterThan(0);
    expect(boards.every((board) => board.source === 'lever')).toBe(true);
  });

  it('accepts an override list, which is how tests and discovery inject boards', () => {
    const custom: BoardRef[] = [{ source: 'ashby', slug: 'acme', company: 'Acme' }];
    expect(boardsFor('ashby', custom)).toEqual(custom);
    expect(boardsFor('lever', custom)).toEqual([]);
  });
});

describe('mergeBoards', () => {
  const curated: BoardRef[] = [{ source: 'lever', slug: 'epifi', company: 'Fi Money' }];

  it('keeps the curated name when a discovered board collides', () => {
    const merged = mergeBoards(curated, [{ source: 'lever', slug: 'epifi', company: 'Epifi' }]);
    expect(merged).toEqual([{ source: 'lever', slug: 'epifi', company: 'Fi Money' }]);
  });

  it('treats slug case as insignificant, since board tokens are case-insensitive', () => {
    const merged = mergeBoards(curated, [{ source: 'lever', slug: 'EpiFi', company: 'Epifi' }]);
    expect(merged).toHaveLength(1);
  });

  it('keeps the same slug on a different ATS — a company can migrate mid-run', () => {
    const merged = mergeBoards(curated, [{ source: 'ashby', slug: 'epifi', company: 'Fi' }]);
    expect(merged).toHaveLength(2);
  });

  it('appends genuinely new boards', () => {
    const merged = mergeBoards(curated, [{ source: 'lever', slug: 'zeta', company: 'Zeta' }]);
    expect(merged.map((board) => board.slug)).toEqual(['epifi', 'zeta']);
  });
});
