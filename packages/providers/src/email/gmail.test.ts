import { describe, expect, it, vi } from 'vitest';
import { collect, context, query } from '../harness.fixtures.js';
import { createGmailProvider, jobLink, parseGmailMessage, type GmailMessage } from './gmail.js';

const credentials = {
  GMAIL_CLIENT_ID: 'client',
  GMAIL_CLIENT_SECRET: 'secret',
  GMAIL_REFRESH_TOKEN: 'refresh',
};
const html = `<table>
  <tr><td><a href="https://www.linkedin.com/jobs/view/1234567890/?trackingId=private">Senior Engineer</a>
    <p>Acme</p><p>Location: Bengaluru</p><p>Salary: 30 LPA</p><p>React, TypeScript; 5+ years</p>
    <a href="https://www.linkedin.com/jobs/view/1234567890/">Apply now</a></td></tr>
  <tr><td><a href="https://www.naukri.com/job-listings-platform-engineer-beta-123456789012">Platform Engineer at Beta</a>
    <p>Location: Hyderabad</p><p>Python, AWS</p></td></tr>
  </table><p>Private account footer</p><a href="https://example.com/unsubscribe">Unsubscribe</a>`;

function message(body = html, from = 'Job alerts <jobs-noreply@linkedin.com>'): GmailMessage {
  return {
    id: 'message-1',
    internalDate: String(Date.parse('2026-09-08T08:00:00Z')),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [{ name: 'From', value: from }],
      parts: [{ mimeType: 'text/html', body: { data: Buffer.from(body).toString('base64url') } }],
    },
  };
}

describe('Gmail alert parsing', () => {
  it('separates digest jobs, strips tracking, and never marks snippets as full descriptions', () => {
    const jobs = parseGmailMessage(message());
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      source: 'gmail',
      sourcePublisher: 'LinkedIn',
      sourceJobId: 'linkedin:1234567890',
      title: 'Senior Engineer',
      companyName: 'Acme',
      location: 'Bengaluru',
      salaryRaw: '30 LPA',
      applyUrl: 'https://www.linkedin.com/jobs/view/1234567890/',
      hasFullDescription: false,
    });
    expect(jobs[0]?.description).not.toContain('Python');
    expect(jobs[0]?.description).not.toContain('Private account');
    expect(jobs[1]).toMatchObject({ title: 'Platform Engineer', companyName: 'Beta' });
    expect(jobs[0]?.postedAt).toBeUndefined();
  });

  it('ignores unrelated mail and lookalike sender domains', () => {
    expect(parseGmailMessage(message(html, 'friend@example.com'))).toEqual([]);
    expect(parseGmailMessage(message(html, 'alerts@linkedin.com.evil.test'))).toEqual([]);
    expect(parseGmailMessage(message(html, 'LinkedIn <attacker@example.com>'))).toEqual([]);
  });

  it('ignores attachments and unsafe or unrelated links', () => {
    const attached = message();
    attached.payload!.parts![0]!.filename = 'private.html';
    expect(parseGmailMessage(attached)).toEqual([]);
    for (const url of [
      'http://linkedin.com/jobs/view/123/',
      'https://linkedin.com.evil.test/jobs/view/123/',
      'https://user:secret@linkedin.com/jobs/view/123/',
      'https://localhost/jobs/view/123/',
      'javascript:alert(1)',
      'https://linkedin.com/feed/',
    ])
      expect(jobLink(url)).toBeNull();
    expect(jobLink('https://in.indeed.com/rc/clk?jk=abc123&tracking=private')).toEqual({
      url: 'https://www.indeed.com/viewjob?jk=abc123',
      publisher: 'Indeed',
      id: 'abc123',
    });
  });
});

describe('Gmail provider', () => {
  it('reads recent messages with authorization, paginates and deduplicates across emails', async () => {
    const calls: string[] = [];
    const ctx = context(async (url, init) => {
      calls.push(url);
      expect(init.method).toBe('GET');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer access');
      if (url.includes('format=full')) return Response.json(message());
      const params = new URL(url).searchParams;
      expect(params.get('q')).toContain('from:linkedin.com');
      expect(params.get('q')).toContain('after:');
      return Response.json(
        params.has('pageToken')
          ? { messages: [{ id: 'two' }] }
          : { messages: [{ id: 'one' }], nextPageToken: 'next' },
      );
    });
    const provider = createGmailProvider({ credentials, accessToken: async () => 'access' });
    expect(await collect(provider.search(query(), ctx))).toHaveLength(2);
    expect(calls).toHaveLength(4);
    expect(ctx.events.at(-1)?.message).toContain('capped at 80%');
  });

  it('respects the result limit and skips expired messages', async () => {
    const ctx = context(async (url) =>
      Response.json(
        url.includes('format=full') ? message() : { messages: [{ id: 'one' }, { id: 'two' }] },
      ),
    );
    const provider = createGmailProvider({ credentials, accessToken: async () => 'access' });
    expect(await collect(provider.search(query({ maxResults: 1 }), ctx))).toHaveLength(1);
    const future = createGmailProvider({
      credentials,
      accessToken: async () => 'access',
      now: () => Date.parse('2027-01-01'),
    });
    expect(await collect(future.search(query({ postedWithinDays: 7 }), ctx))).toEqual([]);
  });

  it('does not access Gmail when unconfigured or cancelled', async () => {
    const fetch = vi.fn();
    const ctx = context(fetch);
    expect(await collect(createGmailProvider().search(query(), ctx))).toEqual([]);
    const accessToken = vi.fn();
    expect(
      await collect(
        createGmailProvider({ credentials, accessToken }).search(query(), {
          ...ctx,
          signal: AbortSignal.abort(),
        }),
      ),
    ).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(accessToken).not.toHaveBeenCalled();
  });

  it('never exposes OAuth secrets or response bodies in failures', async () => {
    const provider = createGmailProvider({
      credentials,
      accessToken: async () => {
        throw new Error('private-token');
      },
    });
    await expect(collect(provider.search(query(), context(vi.fn())))).rejects.toThrow(
      'Gmail could not be read',
    );
    await expect(collect(provider.search(query(), context(vi.fn())))).rejects.not.toThrow(
      'private-token',
    );
  });
});
