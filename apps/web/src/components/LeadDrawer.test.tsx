import { leadSchema, MATCH_WEIGHTS } from '@job-radar/shared';
import { expect, it, vi } from 'vitest';
import { LeadDrawer } from './LeadDrawer';
import { request } from '../lib/api';
import { renderApp, screen, userEvent } from '../test/utils';

vi.mock('../lib/api', () => ({ request: vi.fn() }));

it('focuses application options from Apply without starting a run', async () => {
  const lead = leadSchema.parse({
    id: 'lead-1',
    runId: null,
    status: 'new',
    createdAt: '2026-09-10',
    updatedAt: '2026-09-10',
    job: {
      id: 'job-1',
      fingerprint: 'job-1',
      source: 'linkedin',
      sourceJobId: '1',
      title: 'Frontend Engineer',
      company: { id: 'acme', name: 'Acme' },
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
      firstSeenAt: '2026-09-10',
      lastSeenAt: '2026-09-10',
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
  vi.mocked(request).mockResolvedValue({ lead, company: null, active: null, runs: [] });
  renderApp(<LeadDrawer leadId={lead.id} threshold={0.85} onClose={vi.fn()} />);
  const apply = await screen.findByRole('button', { name: 'Apply with Copilot' });
  const options = document.getElementById(apply.getAttribute('aria-controls')!);
  expect(options).not.toBeNull();
  const scroll = vi.fn();
  Object.defineProperty(options, 'scrollIntoView', { value: scroll, configurable: true });
  await userEvent.click(apply);
  expect(options).toHaveFocus();
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
  expect(screen.getByRole('combobox', { name: 'Apply via' })).toHaveValue('source-first');
  expect(screen.getByRole('link', { name: 'Open posting' })).toHaveAttribute(
    'href',
    lead.job.applyUrl,
  );
  expect(vi.mocked(request).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
    false,
  );
});
