import { describe, it, expect } from 'vitest';
import { buildTestApp, seedLeads } from '../../routes/routes.fixtures.js';
import { ApplicationRepo } from './applications.js';

describe('application persistence', () => {
  it('prevents parallel applications and preserves restart uncertainty', async () => {
    const fixture = await buildTestApp();
    try {
      seedLeads(fixture, [{ score: 0.9 }]);
      const lead = fixture.container.repos.leads.forProfile()[0]!;
      const repo = new ApplicationRepo(fixture.container.db);
      const run = repo.create(lead.id, '2026-09-09');
      expect(() => repo.create(lead.id, '2026-09-09')).toThrow(/already active/);
      expect(() => repo.update(run.id, 'submitted', 'Done', '2026-09-09')).toThrow();
      repo.update(run.id, 'ready', 'Review', '2026-09-09');
      repo.update(run.id, 'submitting', 'Approved', '2026-09-09');
      repo.reap('2026-09-09');
      expect(repo.get(run.id)?.status).toBe('failed');
      expect(repo.get(run.id)?.events.at(-1)?.message).toMatch(/Outcome unknown/);
      expect(repo.get(run.id)?.outcomeUnknown).toBe(true);
      expect(repo.active()).toBeNull();
      expect(() => repo.create(lead.id, '2026-09-10')).toThrow(/outcome is unknown/);
      expect(() => repo.create(lead.id, '2026-09-10', 'stale')).toThrow(/outcome is unknown/);
      const retry = repo.create(lead.id, '2026-09-10', run.id);
      expect(retry.retryOf).toBe(run.id);
      expect(retry.outcomeUnknown).toBe(false);
      repo.update(retry.id, 'ready', 'Review', '2026-09-10');
      repo.update(retry.id, 'submitting', 'Approved', '2026-09-10');
      repo.update(retry.id, 'failed', 'Interrupted', '2026-09-10');
      expect(() => repo.create(lead.id, '2026-09-11', run.id)).toThrow(/outcome is unknown/);
    } finally {
      await fixture.close();
    }
  });
  it('allows retrying preparation failures without a submission acknowledgment', async () => {
    const fixture = await buildTestApp();
    try {
      seedLeads(fixture, [{ score: 0.9 }]);
      const lead = fixture.container.repos.leads.forProfile()[0]!;
      const repo = new ApplicationRepo(fixture.container.db);
      const run = repo.create(lead.id, '2026-09-09');
      repo.update(run.id, 'failed', 'Browser unavailable', '2026-09-09');
      expect(repo.get(run.id)?.outcomeUnknown).toBe(false);
      expect(() => repo.create(lead.id, '2026-09-10', run.id)).toThrow(/no longer current/);
      expect(repo.create(lead.id, '2026-09-10').retryOf).toBeNull();
    } finally {
      await fixture.close();
    }
  });
});
