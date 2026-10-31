import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

// Canary for the local test-access gate. `testAccessAllowed` refuses any request that carries
// X-Forwarded-For, Forwarded or X-Real-IP, and the browser's /api calls reach the API through
// Next's rewrite proxy. That proxy must add none of those headers, so this test reads the installed
// Next source and fails when a Next upgrade starts forwarding them.
test('the Next rewrite proxy adds no peer-forwarding headers', () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(
    require.resolve('next/dist/server/lib/router-utils/proxy-request.js'),
    'utf8',
  );
  assert.equal(
    /xfwd/.test(source),
    false,
    'Next enabled httpxy xfwd, which adds forwarding headers',
  );
  assert.match(source, /headers: \{\s*'x-forwarded-host': req\.headers\.host/);
});
