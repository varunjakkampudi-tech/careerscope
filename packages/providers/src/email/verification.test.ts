import { describe, expect, it, vi } from 'vitest';
import { createGmailVerificationReader, verificationCode } from './verification.js';
import type { GmailMessage } from './gmail.js';

const now = Date.parse('2026-09-10T10:00:00Z');
const request = {
  sender: 'accounts@employer.example',
  recipient: 'candidate@example.com',
  after: now - 60_000,
};
function message(text = 'Your verification code is 123456'): GmailMessage {
  return {
    id: 'message',
    internalDate: String(now - 1000),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: request.sender },
        { name: 'To', value: request.recipient },
      ],
      body: { data: Buffer.from(text).toString('base64url') },
    },
  };
}

describe('application verification mail', () => {
  it('accepts one fresh code only for the exact sender and recipient', () => {
    expect(verificationCode([message()], request, now)).toBe('123456');
    expect(
      verificationCode([message()], { ...request, sender: 'other@employer.example' }, now),
    ).toBeNull();
    expect(
      verificationCode([message()], { ...request, recipient: 'other@example.com' }, now),
    ).toBeNull();
    expect(
      verificationCode([{ ...message(), internalDate: String(now - 700_000) }], request, now),
    ).toBeNull();
    expect(
      verificationCode([{ ...message(), internalDate: String(now + 1000) }], request, now),
    ).toBeNull();
  });

  it('refuses ambiguous messages, reset/payment codes and unlabelled numbers', () => {
    expect(verificationCode([message(), message()], request, now)).toBeNull();
    for (const text of [
      '123456',
      'Reset your password. Verification code: 123456',
      'Payment OTP: 123456',
      'OTP: 123456 OTP: 654321',
    ]) {
      expect(verificationCode([message(text)], request, now)).toBeNull();
    }
  });

  it('does not contact Gmail when unconfigured or given an injected query', async () => {
    const fetcher = vi.fn();
    expect(await createGmailVerificationReader({}, { fetch: fetcher }).read(request)).toBeNull();
    const reader = createGmailVerificationReader(
      { GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 'secret', GMAIL_REFRESH_TOKEN: 'refresh' },
      { fetch: fetcher, now: () => now },
    );
    expect(
      await reader.read({ ...request, sender: 'accounts@example.com OR from:anyone' }),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses bounded read-only requests and suppresses token-bearing failures', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'message' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(message())));
    const reader = createGmailVerificationReader(
      { GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 'secret', GMAIL_REFRESH_TOKEN: 'refresh' },
      { fetch: fetcher, now: () => now, accessToken: async () => 'private-token' },
    );
    expect(await reader.read(request)).toBe('123456');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get('q')).toContain(
      `from:${request.sender} to:${request.recipient}`,
    );
    fetcher.mockRejectedValue(new Error('private-token'));
    expect(await reader.read(request)).toBeNull();
  });
});
