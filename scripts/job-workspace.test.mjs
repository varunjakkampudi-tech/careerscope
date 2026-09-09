import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRecentJob,
  publicJobView,
  readSavedJobs,
  writeSavedJobs,
  savedJobsKey,
} from '../mobile-site/job-workspace.mjs';

const now = Date.parse('2026-09-09T12:00:00Z');
const jobs = [
  {
    title: 'React engineer',
    company: 'Zen',
    location: 'India',
    source: 'lever',
    url: 'https://jobs.lever.co/one',
    postedAt: '2026-09-09T10:00:00Z',
  },
  {
    title: 'Frontend engineer',
    company: 'Acme',
    location: 'Remote',
    source: 'ashby',
    url: 'https://jobs.ashbyhq.com/two',
    postedAt: '2026-09-07T10:00:00Z',
  },
  {
    title: 'React lead',
    company: 'Beta',
    location: 'India',
    source: 'lever',
    url: 'https://jobs.lever.co/three',
    postedAt: null,
  },
];

test('freshness excludes missing, invalid and future dates and includes the boundary', () => {
  assert.equal(isRecentJob({ postedAt: '2026-09-08T12:00:00Z' }, 1, now), true);
  for (const postedAt of [null, '', 'invalid', '2026-09-08T11:59:59Z', '2026-09-10T12:00:00Z']) {
    assert.equal(isRecentJob({ postedAt }, 1, now), false);
  }
  assert.equal(isRecentJob({ postedAt: null }, 0, now), true);
});

test('public filters compose without mutating the snapshot', () => {
  assert.deepEqual(publicJobView(jobs, { query: 'REACT', source: 'lever', days: 1 }, now), [
    jobs[0],
  ]);
  assert.deepEqual(publicJobView(jobs, { savedOnly: true, saved: new Set([jobs[1].url]) }, now), [
    jobs[1],
  ]);
  assert.deepEqual(publicJobView(jobs, { savedOnly: true }, now), []);
  assert.deepEqual(
    publicJobView(jobs, { sort: 'company' }, now).map((job) => job.company),
    ['Acme', 'Beta', 'Zen'],
  );
  assert.deepEqual(publicJobView([...jobs].reverse(), { sort: 'newest' }, now), jobs);
  assert.equal(jobs[0].company, 'Zen');
});

test('saved public jobs persist only URLs and reject malformed or unsafe entries', () => {
  let value = null;
  const storage = {
    getItem: () => value,
    setItem: (key, next) => {
      assert.equal(key, savedJobsKey);
      value = next;
    },
  };
  assert.deepEqual([...readSavedJobs(storage)], []);
  writeSavedJobs(storage, new Set([jobs[0].url]));
  assert.deepEqual([...readSavedJobs(storage)], [jobs[0].url]);
  assert.ok(!value.includes('React'));
  value = JSON.stringify([
    jobs[0].url,
    jobs[0].url,
    'javascript:alert(1)',
    'https://user:password@example.com',
    null,
  ]);
  assert.deepEqual([...readSavedJobs(storage)], [jobs[0].url]);
  value = '{}';
  assert.throws(() => readSavedJobs(storage));
  assert.throws(() =>
    writeSavedJobs(
      {
        setItem() {
          throw new Error('Quota');
        },
      },
      new Set(),
    ),
  );
});
