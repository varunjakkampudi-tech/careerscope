/**
 * Delivers one-time codes by email through Resend, with an optional failover provider. Used by the
 * API sign-in and email-change routes; the codes themselves come from `email-otp.ts`.
 */

import { z } from 'zod';

/** Input validators. The sender may be `Name <address>` and must contain no line breaks (header injection). */
const emailSchema = z.string().trim().email().max(254);
const codeSchema = z.string().regex(/^\d{6}$/);
const idempotencyKeySchema = z.string().uuid();
const senderSchema = z
  .string()
  .max(254)
  .refine((value) => {
    if (/[\r\n]/.test(value)) return false;
    const display = /^([^<>]+) <([^<>]+)>$/.exec(value.trim());
    return emailSchema.safeParse(display?.[2] ?? value.trim()).success;
  });
const resendEndpoint = 'https://api.resend.com/emails';

/** One delivery. `idempotencyKey` lets the provider drop a duplicate if a send is retried. */
export type EmailOtpDeliveryMessage = {
  email: string;
  code: string;
  idempotencyKey: string;
  purpose?: 'sign-in' | 'email-change-current' | 'email-change-new';
};

/** A mail backend that either sends or throws `EmailOtpProviderError`. */
export interface EmailOtpProvider {
  send(message: EmailOtpDeliveryMessage): Promise<void>;
}

/** Safe provider failure: carries only whether a retry or the fallback might succeed, never the response, address or code. */
export class EmailOtpProviderError extends Error {
  constructor(readonly retryable: boolean) {
    super('Email OTP provider request failed');
    this.name = 'EmailOtpProviderError';
  }
}

/** Thrown when no provider could send; the message is deliberately generic. */
export class EmailOtpDeliveryUnavailable extends Error {
  constructor() {
    super('Email OTP delivery is temporarily unavailable');
    this.name = 'EmailOtpDeliveryUnavailable';
  }
}

/** Resend adapter using the official HTTPS email-send endpoint. */
export class ResendEmailOtpProvider implements EmailOtpProvider {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (apiKey.trim().length === 0 || apiKey.length > 512)
      throw new Error('Invalid email provider configuration');
    if (!senderSchema.safeParse(from).success)
      throw new Error('Invalid email provider configuration');
  }

  /**
   * Sends the code with a five-second timeout and one retry. Provider response bodies are never read or
   * surfaced, since they can include recipient data; redirects are refused so the API key cannot be forwarded.
   */
  async send(message: EmailOtpDeliveryMessage): Promise<void> {
    const email = emailSchema.parse(message.email).toLowerCase();
    const code = codeSchema.parse(message.code);
    const idempotencyKey = idempotencyKeySchema.parse(message.idempotencyKey);
    const purpose = message.purpose ?? 'sign-in';
    const copy =
      purpose === 'sign-in'
        ? {
            intro: 'Use this verification code to sign in:',
            text: 'Your CareerScope verification code is',
          }
        : purpose === 'email-change-current'
          ? {
              intro:
                'A request was made to change the sign-in email on your CareerScope account. Use this code to verify access to your current email address. The change will not take effect unless the new address is verified too.',
              text: 'Your CareerScope current-address verification code is',
            }
          : {
              intro:
                'A request was made to use this address for a CareerScope account. Use this code to verify the new address. The change will not take effect unless the current address is verified too.',
              text: 'Your CareerScope new-address verification code is',
            };
    const body = JSON.stringify({
      from: this.from,
      to: [email],
      subject:
        purpose === 'sign-in'
          ? 'Your CareerScope verification code'
          : 'Verify your CareerScope email change',
      text: `${copy.text} ${code}. It expires in 5 minutes. Never share this code. If you did not request it, ignore this email.`,
      html: `<main style="margin:0 auto;max-width:560px;padding:32px 20px;font-family:Arial,Helvetica,sans-serif;color:#0b1f44;line-height:1.5"><h1 style="font-size:24px;margin:0 0 20px">CareerScope</h1><p>${copy.intro}</p><p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">${code}</p><p>This code expires in 5 minutes. Never share it with anyone.</p><p>If you did not request it, you can ignore this email.</p></main>`,
    });

    // A single bounded retry is safe because Resend honors Idempotency-Key for
    // the POST /emails operation. Reuse the exact body and key on retry.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(resendEndpoint, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body,
        });
      } catch {
        // Fetch errors can contain request/response internals. The request body
        // contains both the address and OTP, so expose only a typed safe error.
        if (attempt === 0) continue;
        throw new EmailOtpProviderError(true);
      }

      if (response.ok) return;
      // Do not read or propagate provider response bodies; they may contain
      // recipient or request metadata. 409 is safely retried with the same
      // request key to cover Resend's concurrent-idempotency response.
      const retryable =
        response.status === 408 ||
        response.status === 409 ||
        response.status === 429 ||
        response.status >= 500;
      if (!retryable || attempt === 1) throw new EmailOtpProviderError(retryable);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * Sends through one configured primary and then an injected fallback provider.
 * The fallback vendor remains a composition choice; this class does not assume
 * credentials or create an account for it.
 */
export class FailoverEmailOtpDelivery {
  constructor(
    private readonly primary: EmailOtpProvider,
    private readonly fallback: EmailOtpProvider,
  ) {}

  /** Tries the primary, then the fallback only when the primary failure was retryable. Returns which one sent. */
  async send(message: EmailOtpDeliveryMessage): Promise<'primary' | 'fallback'> {
    try {
      await this.primary.send(message);
      return 'primary';
    } catch (error) {
      if (!(error instanceof EmailOtpProviderError) || !error.retryable)
        throw new EmailOtpDeliveryUnavailable();
    }

    try {
      await this.fallback.send(message);
      return 'fallback';
    } catch {
      throw new EmailOtpDeliveryUnavailable();
    }
  }
}
