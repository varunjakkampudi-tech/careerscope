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
  await userEvent.click(screen.getByRole('radio', { name: 'Local agent' }));
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

it('shows configured Gmail verification and starts in review-first mode', async () => {
  vi.mocked(request).mockImplementation(async (path) => {
    if (path === '/applications/capability')
      return { available: true, reason: null, emailVerificationAvailable: true };
    return { active: null, runs: [] };
  });
  renderApp(<ApplicationPanel leadId="selected-job" />);
  await userEvent.click(screen.getByRole('radio', { name: 'Local agent' }));
  await screen.findByText(/Gmail verification: configured/);
  expect(
    screen.getByRole('checkbox', { name: /Authorize automatic submission/ }),
  ).not.toBeChecked();
  await userEvent.click(screen.getByRole('checkbox', { name: /Share my saved profile/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Apply with Copilot' }));
  expect(request).toHaveBeenCalledWith('/applications', {
    method: 'POST',
    body: { leadId: 'selected-job', consent: true, autoSubmit: false },
  });
});

it('offers manual verification when Gmail is not configured', async () => {
  vi.mocked(request).mockImplementation(async (path) => {
    if (path === '/applications/capability')
      return { available: true, reason: null, emailVerificationAvailable: false };
    return { active: null, runs: [] };
  });
  renderApp(<ApplicationPanel leadId="selected-job" />);
  await userEvent.click(screen.getByRole('radio', { name: 'Local agent' }));
  await screen.findByText(/Gmail verification: not connected/);
});

it('copies a shared-browser request without starting the worker or checking CLI capability', async () => {
  const user = userEvent.setup();
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  vi.mocked(request).mockResolvedValue({ active: null, runs: [] });
  renderApp(<ApplicationPanel leadId="selected-job" />);
  await user.click(await screen.findByRole('button', { name: 'Copy browser request' }));
  expect(clipboard).toHaveBeenCalledWith(expect.stringContaining('"selected-job"'));
  expect(clipboard).toHaveBeenCalledWith(expect.stringContaining('shared Gmail tab'));
  expect(screen.getByRole('textbox', { name: 'Copilot chat request' })).toHaveAttribute('readonly');
  expect(screen.getByRole('radio', { name: 'Shared browser' })).toBeChecked();
  expect(request).not.toHaveBeenCalledWith('/applications/capability');
  expect(vi.mocked(request).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
    false,
  );
  expect(screen.queryByRole('button', { name: 'Apply with Copilot' })).not.toBeInTheDocument();
});

it('copies the selected source or careers route without starting an application', async () => {
  const user = userEvent.setup();
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  vi.mocked(request).mockResolvedValue({ active: null, runs: [] });
  renderApp(<ApplicationPanel leadId="selected-job" />);
  const destination = await screen.findByRole('combobox', { name: 'Apply via' });
  expect(destination).toHaveValue('source-first');
  await user.selectOptions(destination, 'careers');
  await user.click(screen.getByRole('button', { name: 'Copy browser request' }));
  expect(clipboard).toHaveBeenLastCalledWith(expect.stringContaining('Employer careers page:'));
  await user.selectOptions(destination, 'source');
  await user.click(screen.getByRole('button', { name: 'Copy browser request' }));
  expect(clipboard).toHaveBeenLastCalledWith(expect.stringContaining('Source portal:'));
  expect(
    (screen.getByRole('textbox', { name: 'Copilot chat request' }) as HTMLTextAreaElement).value,
  ).toContain('Source portal:');
  expect(vi.mocked(request).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
    false,
  );
});

it('leaves the request visible when clipboard permission is denied', async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
  vi.mocked(request).mockResolvedValue({ active: null, runs: [] });
  renderApp(<ApplicationPanel leadId="selected-job" />);
  await user.click(await screen.findByRole('button', { name: 'Copy browser request' }));
  expect(
    (screen.getByRole('textbox', { name: 'Copilot chat request' }) as HTMLTextAreaElement).value,
  ).toContain('"selected-job"');
  expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
});

it('does not offer a handoff for an active or uncertain prior application', async () => {
  vi.mocked(request).mockResolvedValue({ active: run, runs: [run] });
  const { unmount } = renderApp(<ApplicationPanel leadId="lead" />);
  await screen.findByText('An application is already active');
  expect(screen.queryByRole('button', { name: 'Copy browser request' })).not.toBeInTheDocument();
  unmount();
  vi.mocked(request).mockResolvedValue({
    active: null,
    runs: [{ ...run, status: 'failed', outcomeUnknown: true }],
  });
  renderApp(<ApplicationPanel leadId="lead" />);
  await screen.findByText('Check the employer portal before another attempt.');
  expect(screen.queryByRole('button', { name: 'Copy browser request' })).not.toBeInTheDocument();
});

it('updates the handoff when the selected lead changes', async () => {
  const user = userEvent.setup();
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  vi.mocked(request).mockResolvedValue({ active: null, runs: [] });
  const { rerender } = renderApp(<ApplicationPanel leadId="first-job" />);
  await user.click(await screen.findByRole('button', { name: 'Copy browser request' }));
  expect(clipboard).toHaveBeenLastCalledWith(expect.stringContaining('"first-job"'));
  rerender(<ApplicationPanel leadId="second-job" />);
  await user.click(await screen.findByRole('button', { name: 'Copy browser request' }));
  expect(clipboard).toHaveBeenLastCalledWith(expect.stringContaining('"second-job"'));
  expect(clipboard.mock.calls.at(-1)![0]).not.toContain('"first-job"');
});

it('does not offer a new shared-browser request after confirmed submission', async () => {
  vi.mocked(request).mockResolvedValue({ active: null, runs: [{ ...run, status: 'submitted' }] });
  renderApp(<ApplicationPanel leadId="lead" />);
  await screen.findByText('Application already submitted.');
  expect(screen.queryByRole('button', { name: 'Copy browser request' })).not.toBeInTheDocument();
});

it('requires an explicit action approval for Gmail without a code reply field', async () => {
  renderApp(
    <ApplicationProgress
      run={{
        ...run,
        status: 'needs_input',
        question: 'Approve Gmail verification for https://careers.example.com?',
      }}
    />,
  );
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Approve action' }));
  expect(request).toHaveBeenCalledWith('/applications/run/respond', {
    method: 'POST',
    body: { requestId: 'approval-one', answer: 'Approved', approved: true },
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
  await userEvent.click(screen.getByRole('radio', { name: 'Local agent' }));
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
