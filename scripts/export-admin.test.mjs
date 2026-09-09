import { adminLeads, configuredPassphrase } from './export-admin.mjs';

test('local env config requires a non-placeholder passphrase and supports hidden input', () => {
  assert.equal(configuredPassphrase(''), null);
  assert.throws(() => configuredPassphrase('test-only12'), /at least 12 characters/);
  assert.equal(configuredPassphrase('test-only123'), 'test-only123');
  assert.throws(() => configuredPassphrase('admin'));
  assert.throws(() => configuredPassphrase('replace-me-with-a-secret'));
  assert.equal(configuredPassphrase('synthetic-test-passphrase'), 'synthetic-test-passphrase');
});
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('private snapshot uses an explicit field allowlist and retains leads without safe links', () => {
  const rows = [
    {
      title: 'Engineer',
      company: 'Example',
      location: 'India',
      source: 'linkedin',
      posted_at: null,
      source_url: 'https://www.linkedin.com/jobs/view/123?tracking=secret',
      score: 0.9,
      status: 'saved',
      note: 'PRIVATE NOTE',
      resume: 'PRIVATE RESUME',
    },
  ];
  const [lead] = adminLeads(rows);
  assert.deepEqual(
    Object.keys(lead).sort(),
    ['title', 'company', 'location', 'source', 'postedAt', 'url', 'score', 'status'].sort(),
  );
  assert.equal(lead.url, 'https://www.linkedin.com/jobs/view/123');
  assert.equal(adminLeads([{ ...rows[0], source_url: 'javascript:alert(1)' }])[0].url, null);
  assert.equal(lead.score, 0.9);
});
