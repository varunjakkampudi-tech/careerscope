import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { buildMcpServer } from './server.js';
import { buildTestApp } from '../routes/routes.fixtures.js';

it('rejects every mutating tool on a read-only MCP connection', async () => {
  const fixture = await buildTestApp();
  const server = buildMcpServer(fixture.container, { readOnly: true });
  const client = new Client({ name: 'read-only-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const enqueue = vi.spyOn(fixture.container.queue, 'enqueue');
  const cancel = vi.spyOn(fixture.container.queue, 'cancel');
  const update = vi.spyOn(fixture.container.repos.leads, 'update');
  const store = vi.spyOn(fixture.container.repos.resumes, 'store');
  const requests = [
    { name: 'set_profile', arguments: { profile: {} } },
    { name: 'parse_resume', arguments: { path: 'must-not-read.pdf' } },
    { name: 'search_jobs', arguments: { sources: ['greenhouse'] } },
    { name: 'cancel_run', arguments: { runId: 'must-not-cancel' } },
    { name: 'update_lead', arguments: { leadId: 'must-not-update', note: 'unchanged' } },
    { name: 'export_leads', arguments: { path: 'must-not-write.csv', format: 'csv' } },
  ];
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const request of requests) {
      const result = await client.callTool(request);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('This MCP connection is read-only.');
    }
    expect(enqueue).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect((await client.callTool({ name: 'list_sources', arguments: {} })).isError).not.toBe(true);
  } finally {
    await client.close();
    await server.close();
    await fixture.close();
  }
});

it('maps MCP source and status filters to repository queries without dropping other filters', async () => {
  const fixture = await buildTestApp();
  const server = buildMcpServer(fixture.container);
  const client = new Client({ name: 'filter-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const page = vi.spyOn(fixture.container.repos.leads, 'page');
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'list_leads',
      arguments: {
        source: 'naukri',
        status: 'new',
        company: 'Example',
        minScore: 0.7,
        remoteOnly: false,
        limit: 8,
        offset: 2,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(page).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sources: ['naukri'],
        statuses: ['new'],
        company: 'Example',
        minScore: 0.7,
        remoteOnly: false,
        limit: 8,
        offset: 2,
      }),
    );
    await client.callTool({ name: 'list_leads', arguments: {} });
    expect(page).toHaveBeenLastCalledWith(
      expect.objectContaining({ minScore: 0, limit: 50, offset: 0 }),
    );
    expect(page.mock.calls.at(-1)?.[0].sources).toBeUndefined();
    expect(page.mock.calls.at(-1)?.[0].statuses).toBeUndefined();
  } finally {
    await client.close();
    await server.close();
    await fixture.close();
  }
});
