import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserRequestFailureCategory,
  browserWarningPaths,
  browserWarningCategory,
  sameOriginBrowserPath,
  staleEarlierRouteRead,
  staleSavedRead,
  staleSearchRead,
} from './ui-requests.js';

test('settlement drops only saved-job reads belonging to an earlier route', () => {
  assert.equal(staleSavedRead('GET', '/api/leads', 1, 2), true);
  assert.equal(staleSavedRead('GET', '/api/leads/synthetic/history', 1, 2), true);
  // Current dashboard reads still count, even though the endpoint is shared.
  assert.equal(staleSavedRead('GET', '/api/leads', 2, 2), false);
  assert.equal(staleSavedRead('GET', '/api/leads/synthetic/history', 2, 2), false);
  // Writes and unrelated requests must never disappear from the barrier.
  assert.equal(staleSavedRead('POST', '/api/leads', 1, 2), false);
  assert.equal(staleSavedRead('PUT', '/api/leads/synthetic', 1, 2), false);
  assert.equal(staleSavedRead('GET', '/api/searches', 1, 2), false);
  assert.equal(staleSavedRead('GET', '/api/profile', 1, 2), false);
});

test('settlement drops only search list/detail reads belonging to an earlier route', () => {
  assert.equal(staleSearchRead('GET', '/api/searches', 1, 2), true);
  assert.equal(staleSearchRead('GET', '/api/searches/synthetic-run-id', 1, 2), true);
  assert.equal(staleSearchRead('GET', '/api/searches', 2, 2), false);
  assert.equal(staleSearchRead('GET', '/api/searches/synthetic-run-id', 2, 2), false);
  assert.equal(staleSearchRead('POST', '/api/searches', 1, 2), false);
  assert.equal(staleSearchRead('GET', '/api/searches/synthetic-run-id/events', 1, 2), false);
  assert.equal(staleSearchRead('GET', '/api/profile', 1, 2), false);
});

test('settlement drops only fetch and script reads belonging to an earlier route', () => {
  // The shell and settings reads, a router prefetch and a chunk load that a navigation cancelled.
  assert.equal(staleEarlierRouteRead('GET', 'fetch', 1, 2), true);
  assert.equal(staleEarlierRouteRead('GET', 'script', 1, 2), true);
  // The current route's read still counts, so a real hang on this route is still caught.
  assert.equal(staleEarlierRouteRead('GET', 'fetch', 2, 2), false);
  assert.equal(staleEarlierRouteRead('GET', 'script', 2, 2), false);
  // Writes never disappear from the barrier.
  assert.equal(staleEarlierRouteRead('PUT', 'fetch', 1, 2), false);
  assert.equal(staleEarlierRouteRead('POST', 'fetch', 1, 2), false);
  assert.equal(staleEarlierRouteRead('DELETE', 'fetch', 1, 2), false);
  // Neither do documents, images or other resource types.
  assert.equal(staleEarlierRouteRead('GET', 'document', 1, 2), false);
  assert.equal(staleEarlierRouteRead('GET', 'image', 1, 2), false);
});

test('browser diagnostics retain only same-origin normalized paths', () => {
  const origin = 'http://localhost:5280';
  assert.equal(
    sameOriginBrowserPath(
      'http://localhost:5280/_next/static/chunks/app-12345678-1234-1234-1234-1234567890ab.js?token=secret',
      origin,
    ),
    '/_next/static/chunks/app-12345678-1234-1234-1234-1234567890ab.js',
  );
  assert.equal(sameOriginBrowserPath('https://attacker.example/path?token=secret', origin), null);
  assert.equal(sameOriginBrowserPath('not a URL', origin), null);
  assert.equal(
    sameOriginBrowserPath('http://localhost:5280/profile/varun@example.com?token=secret', origin),
    '/profile/:segment',
  );
  assert.equal(sameOriginBrowserPath('http://localhost:5280/private-user', origin), '/:segment');
});

test('warning diagnostics extract only same-origin Next chunk paths and drop query data', () => {
  assert.deepEqual(
    browserWarningPaths(
      'resource “http://localhost:5280/_next/static/chunks/page-abc123.js?secret=private” was unused; https://attacker.example/chunk.js',
      'http://localhost:5280/_next/static/chunks/runtime-def456.js?secret=private',
      'http://localhost:5280',
    ),
    ['/_next/static/chunks/runtime-def456.js', '/_next/static/chunks/page-abc123.js'],
  );
  assert.equal(
    browserWarningCategory('resource preload was not used within a few seconds'),
    'unused-preload',
  );
  assert.equal(browserWarningCategory('GET failed with NS_BINDING_ABORTED'), 'aborted-request');
  assert.equal(browserWarningCategory('Loading failed for a script resource'), 'loading-failed');
  assert.equal(browserWarningCategory('text containing unrelated details'), 'other');
  assert.equal(browserRequestFailureCategory('NS_BINDING_ABORTED'), 'aborted');
  assert.equal(browserRequestFailureCategory('net::ERR_CONNECTION_RESET'), 'network-failure');
  assert.equal(browserRequestFailureCategory('private arbitrary detail'), 'unclassified');
});
