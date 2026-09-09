import { describe, expect, it, vi } from 'vitest';
import { Search } from './Search';
import { renderApp, screen } from '../test/utils';

const saved = vi.hoisted(() => ({ maxResults: 1000, postedWithinDays: 30 }));

vi.mock('../lib/queries', () => ({
  useProfile: () => ({ data: null }),
  useSources: () => ({ data: { sources: [], capabilities: { llmRerank: false } } }),
  useProfileStatus: () => ({ data: { exists: true, hasResume: true } }),
  useLastSearchRequest: () => ({
    data: { ...saved, sources: [], minScore: 0.85, useLlmRerank: false },
  }),
  useActiveRun: () => ({ data: null }),
  useStartSearch: () => ({ isPending: false }),
  useCancelRun: () => ({}),
}));

describe('saved search settings', () => {
  it('shows the supported 1,000 result limit', () => {
    saved.maxResults = 1000;
    saved.postedWithinDays = 30;
    renderApp(<Search />);
    expect(screen.getByLabelText('Listings to fetch')).toHaveValue('1000');
  });

  it('preserves custom valid settings saved through the API', () => {
    saved.maxResults = 350;
    saved.postedWithinDays = 21;
    renderApp(<Search />);
    expect(screen.getByLabelText('Listings to fetch')).toHaveValue('350');
    expect(screen.getByLabelText('Posted within')).toHaveValue('21');
  });
});
