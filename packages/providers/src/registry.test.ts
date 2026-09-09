/**
 * The registry — the seam between the API layer and twelve very different boards.
 *
 * These tests are deliberately about *policy*, not plumbing. Each adapter has
 * its own suite for mapping and pagination; what is worth pinning here is the
 * set of promises the API layer relies on and would otherwise discover the hard
 * way: that an unkeyed source is listed rather than hidden, that enabling a
 * source cannot conjure a key, and that a source named in `ALL_SOURCES` is
 * actually built.
 *
 * That last one is the whole reason `missingProviders` exists. `ALL_SOURCES` is
 * the vocabulary the database, the UI filters and the XLSX export all share, so
 * a source declared there but never constructed shows up as a filter chip that
 * silently matches nothing — a confusing bug to chase from the UI end, and a
 * trivial one to catch here.
 */

import { ALL_SOURCES, type SourceId } from '@job-radar/shared';
import { describe, expect, it } from 'vitest';
import {
  createProviders,
  describeProviders,
  missingProviders,
  resolveProviders,
} from './registry.js';

/** Every key the keyed aggregators need, so a fully-armed registry is buildable. */
const ALL_KEYS = {
  ADZUNA_APP_ID: 'app-id',
  ADZUNA_APP_KEY: 'app-key',
  JOOBLE_API_KEY: 'jooble-key',
  RAPIDAPI_KEY: 'rapid-key',
};

describe('createProviders', () => {
  it('lists Gmail as unavailable until read-only credentials are configured', () => {
    const gmail = describeProviders(createProviders()).find((source) => source.id === 'gmail');

    expect(gmail?.available).toBe(false);
    expect(gmail?.unavailableReason).toContain('GMAIL');
  });

  it('builds every source the rest of the app can name', () => {
    // `foundit` and `cutshort` are expected: they exist only as provenance on
    // the imported seed leads, so the vocabulary knows their names but no
    // provider backs them. Asserted exactly, so porting a source and forgetting
    // to register it fails here rather than in the UI.
    expect(missingProviders(createProviders())).toEqual(['foundit', 'cutshort']);
  });

  it('lists a source it cannot run instead of hiding it', () => {
    const sources = describeProviders(createProviders({ credentials: {} }));

    const adzuna = sources.find((source) => source.id === 'adzuna');
    expect(adzuna?.available).toBe(false);
    // The difference between "we found nothing" and "we did not look". Hiding
    // it would leave the user wondering whether the app supports the board.
    expect(adzuna?.unavailableReason).toContain('ADZUNA_APP_ID');
  });

  it('runs the keyless sources with no configuration at all', () => {
    const available = resolveProviders(createProviders()).map((provider) => provider.id);

    // The out-of-the-box promise: a first run finds real jobs before the user
    // has signed up for anything.
    expect(available).toEqual([
      'greenhouse',
      'lever',
      'ashby',
      'workable',
      'smartrecruiters',
      'recruitee',
      'remotive',
      'remoteok',
      'himalayas',
    ]);
  });

  it('turns the keyed aggregators on once their keys are present', () => {
    const available = resolveProviders(createProviders({ credentials: ALL_KEYS })).map(
      (provider) => provider.id,
    );

    expect(available).toContain('adzuna');
    expect(available).toContain('jooble');
    expect(available).toContain('jsearch');
  });

  it('enables one aggregator without the others', () => {
    const providers = createProviders({ credentials: { ADZUNA_APP_ID: 'a', ADZUNA_APP_KEY: 'b' } });
    const available = resolveProviders(providers).map((provider) => provider.id);

    expect(available).toContain('adzuna');
    expect(available).not.toContain('jsearch');
  });

  it('puts the ATS boards ahead of the aggregators', () => {
    const ids = createProviders({ credentials: ALL_KEYS }).map((provider) => provider.id);

    // Not cosmetic. A run that hits its result ceiling should hit it on leads
    // with a full description and a direct apply link, not on snippets.
    expect(ids.indexOf('greenhouse')).toBeLessThan(ids.indexOf('adzuna'));
    expect(ids.indexOf('remotive')).toBeLessThan(ids.indexOf('jsearch'));
  });

  it('reports a kind for every source, so the UI can group the toggles', () => {
    const byId = new Map(describeProviders(createProviders()).map((s) => [s.id, s.kind]));

    expect(byId.get('greenhouse')).toBe('ats');
    expect(byId.get('remotive')).toBe('remote');
    expect(byId.get('adzuna')).toBe('api');
    expect(byId.get('naukri')).toBe('scrape');
  });

  it('keeps the browser-backed sources dark unless they are switched on', () => {
    const off = describeProviders(createProviders());

    for (const id of ['linkedin', 'naukri', 'indeed'] as const) {
      const source = off.find((s) => s.id === id);
      // Listed, not hidden — the settings screen has to be able to explain why
      // a source the app supports produced nothing.
      expect(source?.available).toBe(false);
      expect(source?.unavailableReason).toContain('ENABLE_SCRAPERS');
    }
  });

  it('reads no ambient configuration of its own', () => {
    // A test that sets process.env would leak into every other test in the
    // file; that the registry takes credentials as an argument is what makes
    // the suite above possible at all.
    process.env.ADZUNA_APP_ID = 'from-the-environment';
    try {
      const providers = createProviders();
      const adzuna = providers.find((provider) => provider.id === 'adzuna');
      expect(adzuna?.unavailableReason).toContain('ADZUNA_APP_ID');
    } finally {
      delete process.env.ADZUNA_APP_ID;
    }
  });
});

describe('resolveProviders', () => {
  const providers = createProviders({ credentials: ALL_KEYS });
  /** Everything runnable with keys but without the opt-in scraper flag. */
  const runnable = providers.filter((provider) => provider.unavailableReason === null);

  it('treats an empty selection as "everything available"', () => {
    // "Available", not "built": the right default for a first run is every
    // source that can actually answer, which excludes the scrapers until
    // someone turns them on.
    expect(resolveProviders(providers, []).length).toBe(runnable.length);
    expect(resolveProviders(providers, undefined).length).toBe(runnable.length);
  });

  it('runs only what the user asked for', () => {
    const ids = resolveProviders(providers, ['greenhouse', 'lever']).map((p) => p.id);

    expect(ids).toEqual(['greenhouse', 'lever']);
  });

  it('cannot be talked into running a source with no key', () => {
    const unkeyed = createProviders({ credentials: {} });

    // A stale enabled-list in the database is the realistic path here: the user
    // enables Adzuna, the key is later removed, and the row survives. This must
    // not produce a provider that throws on its first request.
    expect(resolveProviders(unkeyed, ['adzuna', 'greenhouse']).map((p) => p.id)).toEqual([
      'greenhouse',
    ]);
  });

  it('returns nothing when the selection names only unavailable sources', () => {
    const scrapers: SourceId[] = ['linkedin', 'naukri'];

    // Not an error — the run simply has no work, and the orchestrator reports
    // that to the user rather than failing.
    expect(resolveProviders(createProviders(), scrapers)).toEqual([]);
  });

  it('ignores a source id that no longer exists', () => {
    const ids = resolveProviders(providers, ['greenhouse', 'monster' as SourceId]).map((p) => p.id);

    expect(ids).toEqual(['greenhouse']);
  });
});

describe('describeProviders', () => {
  it('describes every source, available or not', () => {
    const sources = describeProviders(createProviders());

    // Every source but the two seed-only ones — see `missingProviders` above.
    expect(sources).toHaveLength(ALL_SOURCES.length - 2);
    expect(sources.every((source) => source.label.length > 0)).toBe(true);
  });

  it('never echoes a credential value', () => {
    const secret = 'sk-live-do-not-print';
    const sources = describeProviders(createProviders({ credentials: { ADZUNA_APP_ID: secret } }));

    // `/api/sources` is rendered verbatim in the settings screen, so a reason
    // that quoted the value would put a live key on the page.
    const rendered = JSON.stringify(sources);
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain('ADZUNA_APP_KEY');
  });
});
