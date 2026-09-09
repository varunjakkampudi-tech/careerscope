import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicJobs, publicJobUrl } from './export-mobile.mjs';

test('exports only explicitly allowed public job fields', () => {
  const jobs = publicJobs([
    {
      title: '<script>bad</script>',
      company: 'Example',
      location: 'India',
      source: 'linkedin',
      source_url: 'https://www.linkedin.com/jobs/view/123?trackingId=secret#private',
      email: 'private@example.com',
      score: 0.9,
      note: 'private note',
      resume: 'private resume',
      status: 'applied',
    },
  ]);
  assert.deepEqual(Object.keys(jobs[0]), [
    'title',
    'company',
    'location',
    'source',
    'postedAt',
    'url',
  ]);
  assert.equal(jobs[0].url, 'https://www.linkedin.com/jobs/view/123');
  assert.ok(!JSON.stringify(jobs).includes('private'));
});

test('rejects private, credential-bearing and tracking destinations', () => {
  for (const url of [
    'javascript:alert(1)',
    'http://linkedin.com/jobs/1',
    'https://localhost/job',
    'https://127.0.0.1/job',
    'https://linkedin.com.evil.example/job',
    'https://user:secret@linkedin.com/jobs/1',
    'https://linkedin.com/safety/go?url=secret',
  ])
    assert.equal(publicJobUrl(url), null);
  assert.equal(
    publicJobUrl('https://indeed.com/viewjob?jk=abc123&email=secret'),
    'https://indeed.com/viewjob?jk=abc123',
  );
});
