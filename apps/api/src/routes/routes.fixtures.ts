/**
 * Builders for the route tests.
 *
 * `buildTestApp` produces the *real* app — real plugins, real auth hook, real
 * repositories, real serialisation — over an in-memory database and a stub HTTP
 * client. Nothing is mocked out except the network and the disk, so a test that
 * passes here exercises the code that will run in production.
 *
 * Every request goes through `app.inject()`, which drives Fastify's full
 * lifecycle without opening a socket. That matters for the auth tests in
 * particular: a handler called directly would skip the `onRequest` hook that
 * rejects an unauthenticated request, and the test would prove nothing.
 */

import { HttpClient } from '@job-radar/providers';
import { profileSchema } from '@job-radar/shared';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createContainer, type Container } from '../container.js';
import { makeBreakdown, makeJob, NOW, storeJob } from '../db/repo/repo.fixtures.js';
import { parseEnv, type Env } from '../env.js';

/** Long enough to satisfy the 24-character minimum `env.ts` enforces. */
export const TEST_API_KEY = 'test-key-0123456789abcdefghij';

export interface TestApp {
  app: FastifyInstance;
  container: Container;
  env: Env;
  dataDir: string;
  /** Headers carrying a valid key, spread into an `inject()` call. */
  auth: Record<string, string>;
  close(): Promise<void>;
}

export async function buildTestApp(overrides: NodeJS.ProcessEnv = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'job-radar-api-'));

  // A bare source object, not `process.env` with additions — the shell running
  // the suite may well have real `ADZUNA_*` or `ANTHROPIC_API_KEY` values in it,
  // and a test whose provider list changes with the developer's shell is worse
  // than no test.
  const env = parseEnv({
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    APP_API_KEY: TEST_API_KEY,
    LOG_LEVEL: 'fatal',
    LOGIN_ENABLED: 'false',
    ...overrides,
  });

  const container = createContainer(env, {
    databasePath: ':memory:',
    logger: pino({ level: 'silent' }),
    // Constructed but never reached: no test starts a run, and the queue only
    // touches the network once a run executes.
    http: new HttpClient({ userAgent: 'job-radar-test/1.0' }),
  });

  const app = await buildApp(container);
  await app.ready();

  return {
    app,
    container,
    env,
    dataDir,
    auth: { 'x-api-key': TEST_API_KEY },
    async close() {
      await app.close();
      await container.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * A throwaway `dist/` holding an index.html, for the `SERVE_WEB` tests.
 *
 * `serveWeb` only checks that the directory has an `index.html` it can read, and
 * what the file says is irrelevant to whether a request was allowed to reach it —
 * so a one-line document is enough, and the marker in it is what the assertions
 * look for.
 */
export function webDistFixture(): { dir: string; html: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'job-radar-web-'));
  const html = '<!doctype html><html><body><div id="root"></div></body></html>';
  writeFileSync(join(dir, 'index.html'), html, 'utf8');

  return {
    dir,
    html,
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A minimal valid profile body for `POST /api/profile`.
 *
 * Deliberately not the full shape: the point of most route tests is the route,
 * and a fixture that spells out every optional field makes it hard to see which
 * fields a given test actually depends on.
 */
export function profileBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidate: {
      fullName: 'Test Candidate',
      email: 'test@example.com',
      location: 'Hyderabad, India',
    },
    preferences: {
      titles: ['Senior Software Engineer'],
      techStack: ['TypeScript', 'React', 'Node.js'],
      locations: ['Hyderabad'],
    },
    // CTC is a *string* in `applicationSchema`, not a number — people write
    // "45 LPA" or "₹45,00,000" and normalising that at the form boundary would
    // throw away what they meant.
    application: { yearsOfExperience: 6, expectedCtc: '45 LPA' },
    ...overrides,
  };
}

/** A multipart body, built by hand so no test depends on a form-data library. */
export function multipartBody(
  filename: string,
  bytes: Uint8Array,
  contentType = 'application/pdf',
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----jobradartestboundary';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  return {
    payload: Buffer.concat([head, Buffer.from(bytes), tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/**
 * Writes leads straight through the repositories.
 *
 * The alternative — starting a real run — would put the network, twelve
 * providers and the scoring engine inside a test about a query string. These
 * write the same rows a run would, which is what the routes read.
 *
 * Each entry gets its own fingerprint, because `leads` is unique on
 * (`profile_id`, `job_id`) and jobs are unique on `fingerprint`: two fixtures
 * that forgot to differ would silently collapse into one row and the count
 * assertions would be testing nothing.
 */
export function seedLeads(
  t: TestApp,
  entries: readonly { score: number; company?: string; title?: string; location?: string }[],
): void {
  const { repos } = t.container;
  repos.profiles.save(profileSchema.parse(profileBody()), NOW);

  entries.forEach((entry, index) => {
    const job = makeJob({
      fingerprint: `fp-seed-${index}`,
      id: `fp-seed-${index}`,
      sourceJobId: `gh-seed-${index}`,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.location === undefined ? {} : { location: entry.location }),
      ...(entry.company === undefined
        ? {}
        : {
            company: { id: entry.company.toLowerCase().replaceAll(' ', '-'), name: entry.company },
          }),
    });
    storeJob(repos, job, NOW);
    repos.leads.upsert({ runId: null, jobId: job.id, breakdown: makeBreakdown(entry.score) }, NOW);
  });
}
