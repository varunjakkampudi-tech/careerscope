import assert from 'node:assert/strict';
import test from 'node:test';
import type { Database } from '@careerscope/core';
import { createApp } from './app.js';

const origin = 'http://localhost:5280';
const database = {
  pool: {
    query: async () => {
      throw new Error('unexpected database query');
    },
  },
} as unknown as Database;

test('an unsupported content type is a 415 with a generic message, not a 500', async () => {
  const app = await createApp(database, origin, async () => true);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/otp/request',
      headers: { origin, 'content-type': 'application/xml' },
      payload: '<email>candidate@example.test</email>',
    });
    assert.equal(response.statusCode, 415);
    const body = response.json();
    assert.equal(body.error, 'Unsupported media type');
    assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId']);
    assert.doesNotMatch(response.body, /candidate@example\.test/);
  } finally {
    await app.close();
  }
});

test('a body that is not valid JSON stays a 400', async () => {
  const app = await createApp(database, origin, async () => true);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/otp/request',
      headers: { origin, 'content-type': 'application/json' },
      payload: '{not json',
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'Invalid request');
  } finally {
    await app.close();
  }
});
