import { expect, it, vi } from 'vitest';
import { Applications } from './Applications';
import { renderApp, screen } from '../test/utils';

vi.mock('../lib/applications', () => ({
  useApplications: () => ({ data: { runs: [{ id: 'run-one', leadId: 'lead-one' }] } }),
}));
vi.mock('../lib/queries', () => ({ useLead: () => ({ data: null }) }));
vi.mock('../components/ApplicationPanel', () => ({ ApplicationProgress: () => null }));

it('opens the original lead from application history without starting a new application', () => {
  renderApp(<Applications />);
  expect(screen.getByRole('link', { name: 'Review lead' })).toHaveAttribute(
    'href',
    '/leads?lead=lead-one',
  );
});
