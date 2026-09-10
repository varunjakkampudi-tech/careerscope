import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { buildMcpServer } from './server.js';
import { buildTestApp } from '../routes/routes.fixtures.js';

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
