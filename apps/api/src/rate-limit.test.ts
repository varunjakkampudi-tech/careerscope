import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app.js';
import type { Database } from '@careerscope/core';

test('legacy password registration is unavailable regardless of its old flag', async () => {
  let databaseTouched = false;
  const database = {
    pool: {
      query: async () => {
        databaseTouched = true;
        throw new Error('unexpected database query');
      },
    },
  } as unknown as Database;
  const app = await createApp(database, 'http://localhost:5280', async () => true, {
    registrationEnabled: true,
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/register',
      headers: { origin: 'http://localhost:5280' },
      payload: { email: 'candidate@example.test', password: 'synthetic-password-123' },
    });

    assert.equal(response.statusCode, 404);
    const body = response.json();
    assert.equal(body.error, 'Registration unavailable');
    assert.match(body.requestId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId']);
    assert.equal(databaseTouched, false);
    assert.doesNotMatch(response.body, /candidate@example\.test/);
  } finally {
    await app.close();
  }
});

test('email OTP signup remains unavailable without complete legal policy configuration', async () => {
  let databaseTouched = false;
  let emailSent = false;
  const database = {
    pool: {
      query: async () => {
        databaseTouched = true;
        throw new Error('unexpected database query');
      },
    },
  } as unknown as Database;
  const app = await createApp(database, 'http://localhost:5280', async () => true, {
    emailOtp: {
      secret: Buffer.alloc(32, 7),
      provider: {
        send: async () => {
          emailSent = true;
        },
      },
    },
    registrationEnabled: true,
  });

  try {
    const legacyPassword = await app.inject({
      method: 'POST',
      url: '/api/register',
      headers: { origin: 'http://localhost:5280' },
      payload: { email: 'candidate@example.test', password: 'synthetic-password-123' },
    });
    assert.equal(legacyPassword.statusCode, 404);
    const signupRequest = await app.inject({
      method: 'POST',
      url: '/api/otp/request',
      headers: { origin: 'http://localhost:5280' },
      payload: {
        email: 'candidate@example.test',
        intent: 'sign-up',
        termsAccepted: true,
        privacyAcknowledged: true,
        marketingOptIn: false,
        dateOfBirth: '1990-01-01',
      },
    });

    assert.equal(signupRequest.statusCode, 404);
    assert.equal(emailSent, false);
    assert.equal(databaseTouched, false);
  } finally {
    await app.close();
  }
});

test('readiness fails closed when the required shared Redis dependency is unavailable', async () => {
  let databaseChecked = false;
  const database = {
    pool: {
      query: async () => {
        databaseChecked = true;
        return { rows: [{ '?column?': 1 }] };
      },
    },
  } as unknown as Database;
  const app = await createApp(database, 'http://localhost:5280', async () => true, {
    readiness: async () => {
      throw new Error('synthetic private Redis failure');
    },
  });

  try {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    assert.equal(databaseChecked, true);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(Object.keys(response.json()).sort(), ['error', 'requestId']);
    assert.doesNotMatch(response.body, /synthetic private Redis failure/);
  } finally {
    await app.close();
  }
});

test('readiness returns healthy only after the configured critical dependency check succeeds', async () => {
  let databaseChecked = false;
  let redisChecked = false;
  const database = {
    pool: {
      query: async () => {
        databaseChecked = true;
        return { rows: [{ '?column?': 1 }] };
      },
    },
  } as unknown as Database;
  const app = await createApp(database, 'http://localhost:5280', async () => true, {
    readiness: async () => {
      redisChecked = true;
    },
  });

  try {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    assert.equal(databaseChecked, true);
    assert.equal(redisChecked, true);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
  } finally {
    await app.close();
  }
});

test('OTP request fails closed with a sanitized 503 when the shared limiter is unavailable', async () => {
  let emailSent = false;
  const database = {
    pool: {
      query: async () => {
        throw new Error('unexpected database query');
      },
    },
  } as unknown as Database;
  const app = await createApp(
    database,
    'http://localhost:5280',
    async () => {
      throw new Error('private Redis failure');
    },
    {
      emailOtp: {
        secret: Buffer.alloc(32, 9),
        provider: {
          send: async () => {
            emailSent = true;
          },
        },
      },
    },
  );

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/otp/request',
      headers: { origin: 'http://localhost:5280' },
      payload: { email: 'candidate@example.test' },
    });

    assert.equal(response.statusCode, 503);
    assert.deepEqual(Object.keys(response.json()).sort(), ['error', 'requestId']);
    assert.doesNotMatch(response.body, /candidate@example\.test|private Redis failure/);
    assert.equal(emailSent, false);
  } finally {
    await app.close();
  }
});

test('OTP verification fails closed with a sanitized 503 when the shared limiter is unavailable', async () => {
  const database = {
    pool: {
      query: async () => {
        throw new Error('unexpected database query');
      },
    },
  } as unknown as Database;
  const app = await createApp(
    database,
    'http://localhost:5280',
    async () => {
      throw new Error('private Redis failure');
    },
    {
      emailOtp: {
        secret: Buffer.alloc(32, 9),
        provider: { send: async () => undefined },
      },
    },
  );

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/otp/verify',
      headers: { origin: 'http://localhost:5280' },
      payload: { email: 'candidate@example.test', code: '123456' },
    });

    assert.equal(response.statusCode, 503);
    assert.deepEqual(Object.keys(response.json()).sort(), ['error', 'requestId']);
    assert.doesNotMatch(response.body, /candidate@example\.test|private Redis failure/);
  } finally {
    await app.close();
  }
});
