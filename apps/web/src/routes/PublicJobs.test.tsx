import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { PublicJobs } from './PublicJobs';

afterEach(() => vi.unstubAllGlobals());

it('shows only the public snapshot, keeps multiple sources selectable, and links to owner login', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      updatedAt: '2026-09-09T07:00:00Z',
      jobs: [
        {
          title: 'React developer',
          company: 'First',
          location: 'India',
          source: 'linkedin',
          postedAt: null,
          url: 'https://www.linkedin.com/jobs/view/123',
        },
        {
          title: 'Backend developer',
          company: 'Second',
          location: 'Remote',
          source: 'lever',
          postedAt: null,
          url: 'https://jobs.lever.co/example/456',
        },
      ],
    }),
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <PublicJobs />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('link', { name: 'React developer' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  expect(screen.getByRole('link', { name: 'Owner login' })).toHaveAttribute('href', '/login');
  fireEvent.click(screen.getByRole('checkbox', { name: /linkedin/i }));
  expect(screen.queryByRole('link', { name: 'Backend developer' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: /lever/i }));
  expect(screen.getByRole('link', { name: 'Backend developer' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search jobs' }), {
    target: { value: 'React' },
  });
  await waitFor(() =>
    expect(screen.queryByRole('link', { name: 'Backend developer' })).not.toBeInTheDocument(),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).not.toContain('/api/');
  expect(fetchMock.mock.calls[0]?.[1]).toEqual({ credentials: 'omit' });
});
