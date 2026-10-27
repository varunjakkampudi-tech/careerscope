import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EmailOtpDeliveryUnavailable,
  EmailOtpProviderError,
  FailoverEmailOtpDelivery,
  ResendEmailOtpProvider,
  type EmailOtpProvider,
} from './email-otp-delivery.js';

const message = {
  email: 'Candidate@Example.Test',
  code: '042731',
  idempotencyKey: 'f3040401-c357-4d17-8000-000000000001',
};

test('Resend adapter sends a minimal OTP message to the fixed HTTPS endpoint', async () => {
  let requestUrl = '';
  let request: RequestInit | undefined;
  const provider = new ResendEmailOtpProvider(
    'synthetic-key',
    'CareerScope <auth@example.test>',
    async (input, init) => {
      requestUrl = String(input);
      request = init;
      return new Response(null, { status: 200 });
    },
  );

  await provider.send(message);

  assert.equal(requestUrl, 'https://api.resend.com/emails');
  assert.equal(request?.method, 'POST');
  assert.equal(request?.redirect, 'error');
  assert.equal(new Headers(request?.headers).get('authorization'), 'Bearer synthetic-key');
  assert.equal(new Headers(request?.headers).get('idempotency-key'), message.idempotencyKey);
  const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
  assert.deepEqual(body.to, ['candidate@example.test']);
  assert.equal(body.from, 'CareerScope <auth@example.test>');
  assert.equal(body.subject, 'Your CareerScope verification code');
  assert.match(String(body.text), /042731/);
  assert.match(String(body.text), /5 minutes/);
  assert.match(String(body.text), /Never share/);
  assert.match(String(body.html), /042731/);
  assert.match(String(body.html), /5 minutes/);
  assert.match(String(body.html), /Never share/);
  assert.doesNotMatch(String(body.html), /https?:\/\/|<img\b/i);
  assert.deepEqual(Object.keys(body).sort(), ['from', 'html', 'subject', 'text', 'to']);
});

test('email-change verification email is an explicit notice without exposing account metadata', async () => {
  let request: RequestInit | undefined;
  const provider = new ResendEmailOtpProvider(
    'synthetic-key',
    'CareerScope <auth@example.test>',
    async (_input, init) => {
      request = init;
      return new Response(null, { status: 200 });
    },
  );

  await provider.send({ ...message, purpose: 'email-change-current' });

  const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
  assert.equal(body.subject, 'Verify your CareerScope email change');
  assert.match(String(body.text), /current-address verification code/);
  assert.match(String(body.html), /request was made to change the sign-in email/);
  assert.match(String(body.html), /new address is verified too/);
  assert.doesNotMatch(String(body.text), /candidate@example|ownerId|session/i);
  assert.doesNotMatch(String(body.html), /https?:\/\/|<img\b/i);
});

test('Resend rejects malformed input before making a request', async () => {
  let calls = 0;
  const provider = new ResendEmailOtpProvider('synthetic-key', 'auth@example.test', async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  });

  await assert.rejects(provider.send({ ...message, code: 'not-an-otp' }), zodError);
  await assert.rejects(provider.send({ ...message, email: 'not-an-email' }), zodError);
  await assert.rejects(provider.send({ ...message, idempotencyKey: 'not-a-uuid' }), zodError);
  assert.equal(calls, 0);
});

test('Resend sender configuration rejects malformed and newline-containing values', () => {
  assert.throws(
    () => new ResendEmailOtpProvider('synthetic-key', 'auth@example.test\r\nBcc: x@y.z'),
  );
  assert.throws(() => new ResendEmailOtpProvider('synthetic-key', 'CareerScope <not-an-email>'));
});

test('Resend failures expose no provider response body and classify only retryable statuses', async () => {
  let attempts = 0;
  const provider = new ResendEmailOtpProvider('synthetic-key', 'auth@example.test', async () => {
    attempts += 1;
    return new Response('private provider body must not escape', { status: 503 });
  });
  await assert.rejects(provider.send(message), (error: unknown) => {
    assert.ok(error instanceof EmailOtpProviderError);
    assert.equal(error.retryable, true);
    assert.equal(error.message, 'Email OTP provider request failed');
    assert.equal(error.message.includes('private provider body'), false);
    return true;
  });
  assert.equal(attempts, 2);

  const bodies: string[] = [];
  const keys: string[] = [];
  let retry = 0;
  const idempotent = new ResendEmailOtpProvider(
    'synthetic-key',
    'auth@example.test',
    async (_input, init) => {
      retry += 1;
      bodies.push(String(init?.body));
      keys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      return new Response(null, { status: retry === 1 ? 503 : 200 });
    },
  );
  await idempotent.send(message);
  assert.equal(retry, 2);
  assert.equal(bodies[0], bodies[1], 'retry must use the exact original payload');
  assert.deepEqual(keys, [message.idempotencyKey, message.idempotencyKey]);

  const invalidConfiguration = new ResendEmailOtpProvider(
    'synthetic-key',
    'auth@example.test',
    async () => new Response('private provider body must not escape', { status: 401 }),
  );
  await assert.rejects(invalidConfiguration.send(message), (error: unknown) => {
    assert.ok(error instanceof EmailOtpProviderError);
    assert.equal(error.retryable, false);
    return true;
  });

  let permanentCalls = 0;
  const rejected = new ResendEmailOtpProvider('synthetic-key', 'auth@example.test', async () => {
    permanentCalls += 1;
    return new Response('private provider detail', { status: 401 });
  });
  await assert.rejects(rejected.send(message), EmailOtpProviderError);
  assert.equal(permanentCalls, 1, 'permanent provider rejection must not retry');
});

const zodError = (error: unknown) => error instanceof Error && error.name === 'ZodError';

test('failover uses the fallback only after a retryable primary failure', async () => {
  const calls: string[] = [];
  const primary: EmailOtpProvider = {
    async send() {
      calls.push('primary');
      throw new EmailOtpProviderError(true);
    },
  };
  const fallback: EmailOtpProvider = {
    async send(received) {
      calls.push('fallback');
      assert.deepEqual(received, message);
    },
  };

  assert.equal(await new FailoverEmailOtpDelivery(primary, fallback).send(message), 'fallback');
  assert.deepEqual(calls, ['primary', 'fallback']);
});

test('failover does not hide permanent primary configuration errors', async () => {
  let fallbackCalls = 0;
  const primary: EmailOtpProvider = {
    async send() {
      throw new EmailOtpProviderError(false);
    },
  };
  const fallback: EmailOtpProvider = {
    async send() {
      fallbackCalls += 1;
    },
  };

  await assert.rejects(
    new FailoverEmailOtpDelivery(primary, fallback).send(message),
    EmailOtpDeliveryUnavailable,
  );
  assert.equal(fallbackCalls, 0);
});

test('both provider failures map to one sanitized unavailable error', async () => {
  const failing: EmailOtpProvider = {
    async send() {
      throw new Error('synthetic transport detail with message address and OTP');
    },
  };
  const delivery = new FailoverEmailOtpDelivery(
    {
      async send() {
        throw new EmailOtpProviderError(true);
      },
    },
    failing,
  );

  await assert.rejects(delivery.send(message), (error: unknown) => {
    assert.ok(error instanceof EmailOtpDeliveryUnavailable);
    assert.equal(error.message, 'Email OTP delivery is temporarily unavailable');
    assert.equal(error.message.includes('synthetic transport detail'), false);
    return true;
  });
});
