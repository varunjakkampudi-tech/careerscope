import { describe, expect, it, vi } from 'vitest';
import { Settings } from './Settings';
import { renderApp, screen } from '../test/utils';
import { request } from '../lib/api';

const saved = vi.hoisted(() => ({ resumeId: 'attached' as string | null }));

vi.mock('../lib/api', () => ({
  request: vi.fn(async () => ({ intervalMinutes: 1440, lastScheduledAt: null, lastAttempt: null })),
}));
vi.mock('../lib/queries', () => ({
  useProfile: () => ({
    data: { resumeId: saved.resumeId, candidate: { fullName: 'Test Candidate' } },
  }),
  useResumes: () => ({
    data: [
      { id: 'newest', filename: 'Newer_unattached_resume.pdf', sizeBytes: 1024 },
      {
        id: 'attached',
        filename: 'The_attached_resume_with_a_very_long_filename_for_mobile_layout.pdf',
        sizeBytes: 2048,
      },
    ],
  }),
  useSources: () => ({ data: { sources: [], capabilities: {} } }),
  useDeleteProfile: () => ({}),
  useExportLeads: () => ({}),
}));

describe('settings resume summary', () => {
  it('shows why a scheduled attempt paused and links to Search', async () => {
    vi.mocked(request).mockResolvedValue({
      intervalMinutes: 1440,
      lastScheduledAt: '2026-09-09T10:00:00Z',
      lastAttempt: {
        at: '2026-09-09T10:00:00Z',
        status: 'paused',
        message: 'Selected source unavailable.',
        runId: null,
      },
    });
    renderApp(<Settings />);
    expect(await screen.findByText('Last scheduled attempt paused')).toBeInTheDocument();
    expect(screen.getByText('Selected source unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review search' })).toHaveAttribute('href', '/search');
  });
  it('shows the attached resume instead of the most recent upload', async () => {
    saved.resumeId = 'attached';
    renderApp(<Settings />);
    await screen.findByDisplayValue('Every day');
    expect(screen.getByText(/The_attached_resume/)).toHaveClass('break-words');
    expect(screen.queryByText(/Newer_unattached/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit profile' })).toHaveAttribute('href', '/profile');
  });

  it('distinguishes stored uploads from an attached resume', async () => {
    saved.resumeId = null;
    renderApp(<Settings />);
    await screen.findByDisplayValue('Every day');
    expect(screen.getByText(/No resume attached/)).toBeInTheDocument();
    expect(screen.getByText(/2 uploaded/)).toBeInTheDocument();
  });
});
