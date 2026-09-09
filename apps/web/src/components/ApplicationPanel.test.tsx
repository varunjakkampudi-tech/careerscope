import { expect, it, vi } from 'vitest';
import { ApplicationPanel, ApplicationProgress } from './ApplicationPanel';
import { renderApp, screen, userEvent } from '../test/utils';
import { request } from '../lib/api';
import type { ApplicationRun } from '../lib/applications';

vi.mock('../lib/api', () => ({ request: vi.fn().mockResolvedValue({}) }));

const run: ApplicationRun = {
  id: 'run',
  leadId: 'lead',
  status: 'ready',
  createdAt: '2026-09-09T10:00:00Z',
  updatedAt: '2026-09-09T10:00:00Z',
  events: [{ at: '2026-09-09T10:00:00Z', message: 'Ready for final review.' }],
  currentUrl: null,
  question: 'Submit application to Example?',
  requestId: 'approval-one',
  confirmation: null,
  outcomeUnknown: false,
  retryOf: null,
};

it('starts with one Apply action after explicit job-scoped sharing and submission authorization', async () => {
  vi.mocked(request).mockImplementation(async (path) => {
    if (path === '/applications/capability') return { available: true, reason: null };
    return { active: null, runs: [] };
  });
  renderApp(<ApplicationPanel leadId="selected-job" />);
  const button = await screen.findByRole('button', { name: 'Apply with Copilot' });
  expect(button).toBeDisabled();
  await userEvent.click(screen.getByRole('checkbox', { name: /Share my saved profile/ }));
  const automatic = screen.getByRole('checkbox', { name: /Authorize automatic submission/ });
  expect(automatic).not.toBeChecked();
  await userEvent.click(automatic);
  await userEvent.click(button);
  expect(request).toHaveBeenCalledWith('/applications', {
    method: 'POST',
    body: { leadId: 'selected-job', consent: true, autoSubmit: true },
  });
});

it('requires a distinct final approval and sends the single-use request ID', async () => {
  renderApp(<ApplicationProgress run={run} />);
  expect(request).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Approve submission' }));
  expect(request).toHaveBeenCalledWith('/applications/run/respond', {
    method: 'POST',
    body: { requestId: 'approval-one', answer: 'Approved', approved: true },
  });
});

it('blocks uncertain retries until this attempt is acknowledged', async () => {
  vi.mocked(request).mockImplementation(async (path) => {
    if (path === '/applications/capability') return { available: true, reason: null };
    return { active: null, runs: [{ ...run, status: 'failed', outcomeUnknown: true }] };
  });
  renderApp(<ApplicationPanel leadId="lead" />);
  await screen.findByText('Submission outcome unknown');
  await userEvent.click(screen.getByRole('checkbox', { name: /Share my saved profile/ }));
  const button = screen.getByRole('button', { name: 'Apply with Copilot' });
  expect(button).toBeDisabled();
  await userEvent.click(screen.getByRole('checkbox', { name: /I checked the employer portal/ }));
  await userEvent.click(button);
  expect(request).toHaveBeenCalledWith('/applications', {
    method: 'POST',
    body: { leadId: 'lead', consent: true, autoSubmit: false, retryOf: run.id },
  });
});

it('shows an uncertain outcome without another submit button', () => {
  renderApp(
    <ApplicationProgress
      run={{
        ...run,
        status: 'failed',
        events: [{ at: run.createdAt, message: 'Submission outcome unknown.' }],
      }}
    />,
  );
  expect(screen.getByText('Submission outcome unknown.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Approve submission' })).not.toBeInTheDocument();
});

it('refreshes lead status when automatic submission is confirmed', () => {
  const { queryClient, rerender } = renderApp(
    <ApplicationProgress run={{ ...run, status: 'submitting' }} />,
  );
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  expect(invalidate).not.toHaveBeenCalled();
  rerender(
    <ApplicationProgress
      run={{ ...run, status: 'submitted', confirmation: 'Application received.' }}
    />,
  );
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['leads'] });
  expect(screen.getByText('Application received.')).toBeInTheDocument();
});
