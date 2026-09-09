import { describe, expect, it, vi } from 'vitest';
import { PortalSearchLinks } from './PortalSearchLinks';
import { renderApp, screen, userEvent } from '../test/utils';

vi.mock('../lib/queries', () => ({
  useProfile: () => ({
    data: {
      preferences: {
        titles: ['Frontend Engineer', 'React & TypeScript'],
        locations: ['Hyderabad', 'Bengaluru'],
        remoteOnly: false,
      },
    },
  }),
}));

describe('portal search links', () => {
  it('uses the profile role and location in public search URLs', () => {
    renderApp(<PortalSearchLinks />);
    expect(screen.getByRole('link', { name: 'Naukri' })).toHaveAttribute(
      'href',
      'https://www.naukri.com/frontend-engineer-jobs-in-hyderabad',
    );
    const linkedin = new URL(screen.getByRole('link', { name: 'LinkedIn' }).getAttribute('href')!);
    expect(linkedin.searchParams.get('keywords')).toBe('Frontend Engineer');
    expect(linkedin.searchParams.get('location')).toBe('Hyderabad');
  });

  it('encodes a chosen role and removes the location constraint for Anywhere', async () => {
    renderApp(<PortalSearchLinks />);
    await userEvent.selectOptions(screen.getByLabelText('Target role'), 'React & TypeScript');
    await userEvent.selectOptions(screen.getByLabelText('Portal location'), '');
    const indeed = new URL(screen.getByRole('link', { name: 'Indeed' }).getAttribute('href')!);
    expect(indeed.searchParams.get('q')).toBe('React & TypeScript');
    expect(indeed.searchParams.has('l')).toBe(false);
    expect(screen.getByRole('link', { name: 'Naukri' })).toHaveAttribute(
      'href',
      'https://www.naukri.com/react-typescript-jobs',
    );
  });
});
