import { leadSchema, MATCH_WEIGHTS, type Job } from '@job-radar/shared';
import { describe, expect, it, vi } from 'vitest';
import { LeadTable } from './LeadTable';
import { renderApp, screen, userEvent } from '../test/utils';

vi.mock('@tanstack/react-virtual', () => ({
  useWindowVirtualizer: () => ({
    getVirtualItems: () => [{ index: 0, start: 0 }],
    getTotalSize: () => 240,
    measureElement: vi.fn(),
    measure: vi.fn(),
  }),
}));

function setup(company: Partial<Job['company']> = {}) {
  const lead = leadSchema.parse({
    id: 'lead-1',
    runId: null,
    status: 'new',
    createdAt: '2026-09-09',
    updatedAt: '2026-09-09',
    job: {
      id: 'job-1',
      fingerprint: 'job-1',
      source: 'linkedin',
      sourceJobId: '1',
      title: 'Frontend Engineer',
      company: { id: 'acme', name: 'Acme', ...company },
      location: 'Remote',
      employmentType: null,
      salary: {
        raw: null,
        min: null,
        max: null,
        currency: null,
        period: null,
        annualMin: null,
        annualMax: null,
      },
      postedAt: null,
      descriptionText: '',
      techStack: [],
      requiredYears: { min: null, max: null },
      applyUrl: 'https://example.com/job',
      sourceUrl: 'https://example.com/job',
      firstSeenAt: '2026-09-09',
      lastSeenAt: '2026-09-09',
    },
    match: {
      score: 0.8,
      heuristicScore: 0.8,
      confidence: 'low',
      matchedSkills: [],
      missingSkills: [],
      dimensions: Object.fromEntries(
        Object.entries(MATCH_WEIGHTS).map(([name, weight]) => [
          name,
          { score: 0.8, weight, reason: 'Fixture' },
        ]),
      ),
    },
  });
  const onOpen = vi.fn();
  renderApp(
    <LeadTable
      leads={[lead]}
      threshold={0.85}
      activeId={null}
      selection={new Set()}
      onOpen={onOpen}
      onToggleSelect={vi.fn()}
      onToggleSelectAll={vi.fn()}
      sort="score"
      order="desc"
      onSort={vi.fn()}
      hasNextPage={false}
      isFetchingNextPage={false}
      onLoadMore={vi.fn()}
    />,
  );
  return { onOpen };
}

describe('company links in leads', () => {
  it('opens distinct website and careers links without opening the drawer', async () => {
    const { onOpen } = setup({
      website: 'https://acme.example',
      careersUrl: 'https://acme.example/careers',
    });
    const website = screen.getByRole('link', { name: 'Acme website' });
    const careers = screen.getByRole('link', { name: 'Acme careers' });
    expect(website).toHaveAttribute('href', 'https://acme.example');
    expect(careers).toHaveAttribute('href', 'https://acme.example/careers');
    expect(website).toHaveAttribute('rel', 'noopener noreferrer');
    expect(careers).toHaveAttribute('target', '_blank');
    await userEvent.click(website);
    await userEvent.click(careers);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('uses an observed ATS portal when a separate careers page is absent', () => {
    setup({ atsPortalUrl: 'https://jobs.lever.co/acme' });
    expect(screen.getByRole('link', { name: 'Acme careers' })).toHaveAttribute(
      'href',
      'https://jobs.lever.co/acme',
    );
    expect(screen.queryByRole('link', { name: 'Acme website' })).not.toBeInTheDocument();
  });

  it('does not invent links when neither URL is known', () => {
    setup();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Website: Unknown')).toBeInTheDocument();
  });
});
