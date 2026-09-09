import { expect, it, vi } from 'vitest';
import { Leads } from './Leads';
import { renderApp, screen, userEvent } from '../test/utils';

const useLeads = vi.hoisted(() =>
  vi.fn(() => ({
    data: { pages: [{ items: [{ id: 'fixture-lead' }], total: 1 }] },
  })),
);

vi.mock('../lib/queries', () => ({
  useLeads,
  useSources: () => ({ data: { sources: [] } }),
  useBulkUpdateLeads: () => ({}),
  useExportLeads: () => ({}),
  useLeadCounts: () => ({ data: { total: 1 } }),
  useSkillGap: () => ({}),
}));
vi.mock('../components/FilterRail', () => ({ FilterRail: () => null }));
vi.mock('../components/LeadDrawer', () => ({ LeadDrawer: () => null }));
vi.mock('../components/LeadTable', () => ({
  LeadTable: ({ onToggleSelect }: { onToggleSelect: (id: string) => void }) => (
    <button onClick={() => onToggleSelect('fixture-lead')}>Select fixture lead</button>
  ),
}));

it('clears selection and stale filters when opening fresh matches', async () => {
  const user = userEvent.setup();
  renderApp(<Leads />, { route: '/leads?company=Old&q=stale&run=old-run&lead=fixture-lead' });
  await user.click(screen.getByRole('button', { name: 'Select fixture lead' }));
  expect(screen.getByText('1 selected')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Fresh matches' }));
  expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  expect(useLeads).toHaveBeenLastCalledWith(
    expect.objectContaining({
      minScore: 0.85,
      postedWithinDays: 1,
      statuses: ['new', 'saved'],
      sort: 'postedAt',
      order: 'desc',
      company: undefined,
      search: undefined,
      runId: undefined,
    }),
  );
});

it('opens the saved shortlist without retaining freshness or score restrictions', async () => {
  const user = userEvent.setup();
  renderApp(<Leads />, { route: '/leads?posted=1&minScore=0.99&statuses=new' });
  await user.click(screen.getByRole('button', { name: 'Select fixture lead' }));
  await user.click(screen.getByRole('button', { name: 'Saved shortlist' }));
  expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  expect(useLeads).toHaveBeenLastCalledWith(
    expect.objectContaining({
      minScore: 0,
      statuses: ['saved'],
      postedWithinDays: undefined,
      sort: 'score',
    }),
  );
});
