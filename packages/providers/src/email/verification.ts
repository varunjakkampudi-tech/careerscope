import { OAuth2Client } from 'google-auth-library';
import { htmlToText } from '../html.js';
import type { GmailMessage } from './gmail.js';

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

export interface VerificationRequest {
  sender: string;
  recipient: string;
  after: number;
}

function addresses(value: string): string[] {
  return (value.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) ?? []).map(
    (address) => address.toLowerCase(),
  );
}

function messageText(part: GmailMessage['payload']): string {
  if (!part || part.filename) return '';
  const body = part.body?.data ? Buffer.from(part.body.data, 'base64url').toString('utf8') : '';
  return [
    part.mimeType === 'text/html' ? htmlToText(body) : part.mimeType === 'text/plain' ? body : '',
    ...(part.parts ?? []).map(messageText),
  ].join('\n');
}

export function verificationCode(
  messages: GmailMessage[],
  request: VerificationRequest,
  now = Date.now(),
): string | null {
  if (!EMAIL.test(request.sender) || !EMAIL.test(request.recipient)) return null;
  const candidates = messages.filter((message) => {
    const headers = message.payload?.headers ?? [];
    const header = (name: string) =>
      headers.filter((entry) => entry.name.toLowerCase() === name).map((entry) => entry.value);
    const sentAt = Number(message.internalDate);
    return (
      sentAt >= Math.max(request.after, now - 600_000) &&
      sentAt <= now &&
      header('from').length === 1 &&
      addresses(header('from')[0]!).join(',') === request.sender.toLowerCase() &&
      header('to').flatMap(addresses).includes(request.recipient.toLowerCase())
    );
  });
  if (candidates.length !== 1) return null;
  const text = messageText(candidates[0]!.payload);
  if (/password\s*reset|reset\s*(your\s*)?password|payment|transaction/i.test(text)) return null;
  const codes = new Set(
    [
      ...text.matchAll(
        /(?:verification\s+code|one[- ]time\s+(?:code|password)|security\s+code|OTP)\s*(?:is\s*)?[:=-]?\s*(\d{6,8})\b/gi,
      ),
    ].map((match) => match[1]!),
  );
  return codes.size === 1 ? [...codes][0]! : null;
}

export function createGmailVerificationReader(
  credentials: Readonly<Record<string, string | undefined>>,
  options: { accessToken?: () => Promise<string>; fetch?: typeof fetch; now?: () => number } = {},
) {
  const configured = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'].every(
    (key) => credentials[key],
  );
  return {
    available: configured,
    async read(request: VerificationRequest): Promise<string | null> {
      if (!configured || !EMAIL.test(request.sender) || !EMAIL.test(request.recipient)) return null;
      const now = options.now?.() ?? Date.now();
      if (!Number.isFinite(request.after) || request.after < now - 600_000 || request.after > now)
        return null;
      try {
        const auth = new OAuth2Client({
          clientId: credentials.GMAIL_CLIENT_ID,
          clientSecret: credentials.GMAIL_CLIENT_SECRET,
          transporterOptions: { timeout: 20_000 },
        });
        auth.setCredentials({ refresh_token: credentials.GMAIL_REFRESH_TOKEN });
        const token = options.accessToken
          ? await options.accessToken()
          : (await auth.getAccessToken()).token;
        if (!token) return null;
        const url = new URL(API);
        url.searchParams.set(
          'q',
          `from:${request.sender} to:${request.recipient} after:${Math.floor(request.after / 1000)} -in:trash -in:spam -in:sent -in:drafts`,
        );
        url.searchParams.set('maxResults', '10');
        const readJson = async (target: string) => {
          const response = await (options.fetch ?? fetch)(target, {
            headers: { authorization: `Bearer ${token}`, 'cache-control': 'no-store' },
            signal: AbortSignal.timeout(20_000),
            redirect: 'error',
          });
          if (!response.ok) throw new Error('Verification mail unavailable.');
          return response.json();
        };
        const page = (await readJson(url.href)) as {
          messages?: { id: string }[];
          nextPageToken?: string;
        };
        if (page.nextPageToken || (page.messages?.length ?? 0) > 10) return null;
        const messages: GmailMessage[] = [];
        for (const message of page.messages ?? []) {
          messages.push(
            (await readJson(
              `${API}/${encodeURIComponent(message.id)}?format=full`,
            )) as GmailMessage,
          );
        }
        return verificationCode(messages, request, options.now?.() ?? Date.now());
      } catch {
        return null;
      }
    },
  };
}
