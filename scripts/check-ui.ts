import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  Auth,
  testUsers,
  Database,
  passwordHash,
  users,
  ProfileRepository,
  LeadRepository,
  matchingProfile,
  writableProfileSchema,
  PrivateFileResumeStorage,
  LocalQueue,
  publishPending,
  publishDueInterviewReminders,
} from '@careerscope/core';
import { createApp } from '../apps/api/src/app.js';
import { collect } from '../apps/workers/search/src/collect.js';
import { createRemoteOkProvider, type JobProvider } from '@careerscope/providers';
import { selectUiBrowsers } from './ui-browsers.js';
import {
  browserRequestFailureCategory,
  browserWarningCategory,
  browserWarningPaths,
  sameOriginBrowserPath,
  staleSavedRead,
  staleSearchRead,
} from './ui-requests.js';
import { JOB_SOURCE_PERMISSION_PENDING_MESSAGE } from '@careerscope/shared';
import { observeNotificationPage, observeNotificationServer } from './notification-lifecycle.js';

const notificationLifecycleOnly =
  process.env.CAREERSCOPE_UI_SCENARIO === 'notification-panel-close-before-mutation';
if (process.env.CAREERSCOPE_UI_SCENARIO && !notificationLifecycleOnly)
  throw new Error('Unknown focused browser scenario');
if (notificationLifecycleOnly) {
  assert.equal(process.env.CAREERSCOPE_UI_BROWSER, 'chromium');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DEPLOYMENT_ENVIRONMENT, 'development');
}

const requiredResponsiveWidths = [320, 360, 390, 768, 1024, 1280, 1440, 1920] as const;
const responsiveWidthsEndingAt = (lastWidth: (typeof requiredResponsiveWidths)[number]) => [
  ...requiredResponsiveWidths.filter((width) => width !== lastWidth),
  lastWidth,
];
const browserConsoleErrorKind = (message: { text(): string; location(): { url: string } }) => {
  const text = message.text();
  if (text === 'careerscope-runtime-guard-sentinel') return 'synthetic console sentinel';
  let path = 'unknown source';
  try {
    path = new URL(message.location().url).pathname.replace(
      /\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,
      '/:id',
    );
  } catch {
    // Do not expose raw browser URLs in CI diagnostics.
  }
  const networkError = text.match(/net::(ERR_[A-Z_]+)/)?.[1];
  if (networkError) return `network ${networkError}`;
  const failedResourceStatus = text.match(/status of (\d{3})/i)?.[1];
  if (/failed to load resource/i.test(text)) {
    return failedResourceStatus
      ? `resource HTTP ${failedResourceStatus} at ${path}`
      : `failed resource at ${path}`;
  }
  if (/content security policy|contentsecuritypolicy/i.test(text)) return 'CSP violation';
  if (/hydration/i.test(text)) return 'hydration error';
  if (/TypeError|ReferenceError|SyntaxError/.test(text)) {
    return text.match(/TypeError|ReferenceError|SyntaxError/)?.[0] ?? 'JavaScript error';
  }
  return `unclassified console error at ${path}`;
};
const installUnhandledRejectionGuard = (page: import('playwright').Page) =>
  page.addInitScript(() => {
    const target = window as Window & { __CAREERSCOPE_UNHANDLED_REJECTIONS__?: string[] };
    target.__CAREERSCOPE_UNHANDLED_REJECTIONS__ = [];
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      const knownErrorNames = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError']);
      const category =
        reason instanceof Error && knownErrorNames.has(reason.name) ? reason.name : typeof reason;
      target.__CAREERSCOPE_UNHANDLED_REJECTIONS__?.push(category);
      // The harness reports a bounded category rather than a potentially
      // sensitive rejection message; suppress the browser's raw console copy.
      event.preventDefault();
    });
  });
const unhandledRejections = (page: import('playwright').Page) =>
  page.evaluate(() => {
    const values = (window as Window & { __CAREERSCOPE_UNHANDLED_REJECTIONS__?: string[] })
      .__CAREERSCOPE_UNHANDLED_REJECTIONS__;
    return values ? [...values] : [];
  });
const expectedOtpFixtureConsoleErrors = new Set([
  'resource HTTP 401 at /api/otp/verify',
  'resource HTTP 502 at /api/notifications/preferences',
  'resource HTTP 503 at /api/notifications/preferences',
  // This browser flow intentionally stubs only authentication and email-change
  // contracts. Other authenticated-page reads use the fixture's explicit 404
  // fallback; a new API path is not silently allowlisted.
  'resource HTTP 404 at /api/profile',
  'resource HTTP 404 at /api/resumes',
  'resource HTTP 404 at /api/searches',
  'resource HTTP 404 at /api/leads',
  'resource HTTP 404 at /api/notifications',
  'resource HTTP 404 at /api/account/sessions',
  'resource HTTP 404 at /api/account/marketing-consent',
]);
const expectedAuthenticatedJourneyConsoleErrors = new Set([
  // These are deliberate negative API cases asserted by this browser suite:
  // outage, rate-limit, stale/deleted resource, validation, and conflict UX.
  // Changing the password invalidates every session; a request already in
  // flight during that explicit session revocation can therefore receive 401
  // while the authenticated shell clears private state and redirects.
  'resource HTTP 401 at /api/leads',
  // The reduced-motion preference is read by the authenticated shell; an
  // already-in-flight read can receive 401 after the password-change journey
  // revokes all sessions. The shell must route that through its shared expiry
  // handler, and the query must not retry an authentication failure.
  'resource HTTP 401 at /api/profile/accessibility',
  'resource HTTP 503 at /api/login',
  'resource HTTP 507 at /api/resumes',
  'resource HTTP 500 at /api/resumes',
  'resource HTTP 503 at /api/preparation',
  // Telugu/Hindi settings journeys deliberately return a sanitized 503 and
  // assert the localized status category without exposing response details.
  'resource HTTP 503 at /api/account/sessions/revoke-others',
  'resource HTTP 500 at /api/account/sessions/revoke-others',
  'resource HTTP 429 at /api/account/sessions/revoke-others',
  'resource HTTP 401 at /api/login',
  'resource HTTP 503 at /api/searches/:id/export',
  'resource HTTP 401 at /api/searches/:id/export',
  'resource HTTP 401 at /api/session/refresh',
  'resource HTTP 503 at /api/searches/:id/cancel',
  'resource HTTP 503 at /api/leads',
  'resource HTTP 409 at /api/leads/:id',
  'resource HTTP 409 at /api/profile',
  'resource HTTP 400 at /api/searches/not-a-uuid',
  'resource HTTP 404 at /api/searches/:id',
  'resource HTTP 400 at /api/leads/not-a-uuid',
  'resource HTTP 404 at /api/leads/:id',
  'resource HTTP 500 at /api/searches',
]);

const configured = process.env.DATABASE_URL;
assert.ok(configured);
const uiBrowsers = selectUiBrowsers(
  { chromium, firefox, webkit },
  process.env.CAREERSCOPE_UI_BROWSER,
);
const url = new URL(configured);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
const admin = new Database(configured);
const name = `test_${randomUUID().replaceAll('-', '')}`;
await admin.pool.query(`CREATE DATABASE "${name}"`);
url.pathname = `/${name}`;
const database = new Database(url.href);
const ownerId = randomUUID();
const password = randomUUID();
const origin = 'http://localhost:5280';
const resumeDirectory = await mkdtemp(join(tmpdir(), 'careerscope-resume-ui-'));
const keyFile = join(resumeDirectory, 'encryption.key');
const encryptionKey = randomBytes(32).toString('hex');
await writeFile(keyFile, encryptionKey, { mode: 0o600, flag: 'wx' });
const objectDirectory = join(resumeDirectory, 'objects');
const resumeStorage = new PrivateFileResumeStorage({ directory: objectDirectory, encryptionKey });
await resumeStorage.initialize();
const filesQueue = new LocalQueue(process.env.QUEUE_REDIS_URL!);
const filesQueueName = `test-files-${randomUUID()}`;
const syntheticPermittedSources = new Set(['greenhouse', 'lever', 'ashby', 'workable']);
const requestLifecycleAudit = new Map<
  string,
  {
    route: string;
    requestAt: number;
    responseAt: number | null;
    status: number | null;
    writableFinished: boolean | null;
  }
>();
let filesWorker: ReturnType<typeof spawn> | undefined;
const app = await createApp(database, origin, async () => true, {
  testHarnessPasswordLogin: true,
  registrationEnabled: true,
  registrationPolicy: {
    termsVersion: 'test-terms-1',
    termsUrl: 'https://careerscope.test/terms',
    privacyVersion: 'test-privacy-1',
    privacyUrl: 'https://careerscope.test/privacy',
    marketingVersion: 'test-marketing-1',
  },
  // The browser fixture uses only synthetic source data; production does not
  // inject this approval bypass and remains bound to recorded profiles.
  sourcePermitted: (source) => syntheticPermittedSources.has(source),
  resumeStorage,
});
if (notificationLifecycleOnly) {
  app.server.prependListener('request', (request, response) =>
    observeNotificationServer(request, response, 'fastify'),
  );
}
// Ephemeral test-only request correlation for the Chromium settlement failure.
// Never log request bodies, cookies, or application data.
app.addHook('onRequest', (request, _reply, done) => {
  const id = request.headers['x-careerscope-ui-lifecycle-id'];
  const path = new URL(request.url, origin).pathname;
  if (
    typeof id === 'string' &&
    /^[0-9a-f-]{36}$/i.test(id) &&
    request.method === 'GET' &&
    (path === '/api/profile/accessibility' || path === '/api/notifications')
  ) {
    requestLifecycleAudit.set(id, {
      route: path,
      requestAt: performance.now(),
      responseAt: null,
      status: null,
      writableFinished: null,
    });
  }
  done();
});
app.addHook('onResponse', (request, reply, done) => {
  const id = request.headers['x-careerscope-ui-lifecycle-id'];
  const record = typeof id === 'string' ? requestLifecycleAudit.get(id) : undefined;
  if (record) {
    record.responseAt = performance.now();
    record.status = reply.statusCode;
    record.writableFinished = reply.raw.writableFinished;
  }
  done();
});
try {
  await migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  });
  await filesQueue.initialize(filesQueueName);
  // A starting worker must never delete a temporary another process may still own.
  const pendingFile = join(objectDirectory, `${randomUUID()}.pending`);
  await writeFile(pendingFile, Buffer.alloc(4096));
  const aged = new Date(Date.now() - 86400000);
  await utimes(pendingFile, aged, aged);
  filesWorker = spawn(
    process.execPath,
    [fileURLToPath(new URL('../apps/workers/search/dist/files.js', import.meta.url))],
    {
      env: {
        ...process.env,
        DATABASE_URL: url.href,
        RESUME_STORAGE_DIRECTORY: objectDirectory,
        RESUME_STORAGE_KEY_FILE: keyFile,
        FILES_QUEUE_NAME: filesQueueName,
      },
      // Keep the readiness token machine-readable on stdout, while preserving
      // startup diagnostics in CI instead of replacing the worker's real error
      // with the generic early-exit message below.
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Synthetic files worker startup timed out')),
      30000,
    );
    filesWorker!.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('Synthetic files worker failed to start'));
    });
    filesWorker!.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error('Synthetic files worker exited before readiness'));
    });
    filesWorker!.stdout!.on('data', (chunk) => {
      if (String(chunk).includes('isolated files worker ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  await database.db
    .insert(users)
    .values({ id: ownerId, email: 'ui@example.test', passwordHash: await passwordHash(password) });
  assert.equal((await readFile(pendingFile)).length, 4096);
  assert.equal((await resumeStorage.inventory()).temporaries, 1);
  const search = await database.createSearch(ownerId, 'browser-fixture', {
    query: 'React',
    sources: ['remoteok', 'himalayas'],
  });
  const command = (await database.unpublished())[0]!.command;
  const fence = await database.claim(command.id);
  assert.ok(fence);
  const scored = await collect(
    // `origin` is required by the collect contract; the fixture omitted it and
    // nothing noticed, because this file is in no tsconfig.
    { query: 'React', origin: 'manual', sources: ['remoteok'] },
    new AbortController().signal,
    {
      ...createRemoteOkProvider(),
      async *search() {
        yield {
          source: 'remoteok' as const,
          sourceJobId: 'scored-fixture',
          title: 'Scored React Engineer',
          companyName: 'Flagged Technology',
          location: 'Remote',
          isRemote: true,
          description: 'Build React and TypeScript interfaces.',
          hasFullDescription: false,
          sourceUrl: 'https://remoteok.com/remote-jobs/scored',
          applyUrl: 'https://example.test/scored',
        };
      },
    },
    undefined,
    {
      profile: matchingProfile(
        writableProfileSchema.parse({
          candidate: {
            fullName: 'Synthetic Candidate',
            email: 'synthetic@example.test',
            location: 'Hyderabad',
          },
          preferences: {
            titles: ['React Engineer'],
            techStack: ['React', 'TypeScript'],
            excludeCompanies: ['Flagged Technology'],
          },
          application: {},
        }),
      ),
      now: Date.parse('2026-09-13T12:00:00Z'),
    },
  );
  assert.equal(scored.jobs.length, 1);
  const sourceOutcomes = [
    {
      source: 'remoteok' as const,
      status: 'completed' as const,
      accepted: 1,
      limited: false,
      errorCode: null,
    },
    {
      source: 'himalayas' as const,
      status: 'failed' as const,
      accepted: 1,
      limited: false,
      errorCode: 'source_permission_pending' as const,
    },
  ];
  await database.completeCollection(
    command,
    fence,
    [
      {
        fingerprint: 'browser-fixture',
        sourceJobId: 'browser-fixture',
        title: 'Senior React Engineer',
        company: 'Example Technology',
        location: 'Remote',
        description: 'Build accessible interfaces using React and TypeScript.',
        source: 'himalayas',
        sourceUrl: 'https://himalayas.app/jobs/synthetic',
        sourceLinks: [
          { source: 'himalayas', url: 'https://himalayas.app/jobs/synthetic' },
          { source: 'remoteok', url: 'https://remoteok.com/remote-jobs/synthetic' },
        ],
        applyUrl: 'https://example.test/apply',
        postedAt: null,
      },
      ...scored.jobs,
    ],
    sourceOutcomes,
  );
  // A separate approved-source failure keeps the retry control covered without
  // making the historical Himalayas fixture look retryable before rights are
  // recorded. Both the account and provider data are synthetic.
  const retryableSearch = await database.createSearch(ownerId, 'browser-retry-fixture', {
    query: 'Greenhouse Retry',
    sources: ['greenhouse'],
  });
  const retryableCommand = (await database.unpublished()).find(
    (entry) => entry.command.aggregateId === retryableSearch.id,
  )!.command;
  const retryableFence = await database.claim(retryableCommand.id);
  assert.ok(retryableFence);
  assert.equal(
    await database.completeCollection(
      retryableCommand,
      retryableFence,
      [],
      [
        {
          source: 'greenhouse',
          status: 'failed',
          accepted: 0,
          limited: false,
          errorCode: 'source_failed',
        },
      ],
    ),
    true,
  );
  // A second, entirely unrelated owner with a real run and a real saved lead.
  // `/jobs?run=` and `/saved?lead=` are attacker-supplied input: these two ids
  // are genuine and well-formed, so "unknown id" checks alone would not prove
  // owner isolation still holds once the ids became addressable at all.
  const foreignOwnerId = randomUUID();
  await database.db.insert(users).values({
    id: foreignOwnerId,
    email: 'foreign-owner@example.test',
    passwordHash: await passwordHash(password),
  });
  await new ProfileRepository(database).save(foreignOwnerId, {
    revision: 0,
    profile: {
      candidate: {
        fullName: 'Foreign Owner Candidate',
        email: 'foreign-owner@example.test',
        location: 'Remote',
      },
      preferences: { titles: ['Product Designer'], techStack: ['Figma'] },
      application: {},
      accessibility: { reducedMotion: false },
    },
  });
  const foreignRun = await database.createSearch(foreignOwnerId, 'foreign-owner-fixture', {
    query: 'Foreign Owner Secret Query',
    sources: ['remoteok'],
  });
  const foreignCommand = (await database.unpublished()).find(
    (entry) => entry.command.aggregateId === foreignRun.id,
  )!.command;
  const foreignFence = await database.claim(foreignCommand.id);
  assert.ok(foreignFence);
  assert.equal(
    await database.completeCollection(
      foreignCommand,
      foreignFence,
      [
        {
          fingerprint: 'foreign-owner-fixture',
          sourceJobId: 'foreign-owner-fixture',
          title: 'Foreign Owner Secret Role',
          company: 'Foreign Owner Company',
          location: 'Remote',
          description: 'Another owner’s private job data.',
          source: 'remoteok',
          sourceUrl: 'https://remoteok.com/remote-jobs/foreign',
          applyUrl: 'https://example.test/foreign',
          postedAt: null,
        },
      ],
      [
        {
          source: 'remoteok',
          status: 'completed',
          accepted: 1,
          limited: false,
          errorCode: null,
        },
      ],
    ),
    true,
  );
  const foreignJobId = (
    await database.pool.query<{ id: string }>(
      'SELECT id FROM search_jobs WHERE owner_id = $1 AND run_id = $2',
      [foreignOwnerId, foreignRun.id],
    )
  ).rows[0]!.id;
  const foreignLead = await new LeadRepository(database).save(foreignOwnerId, {
    jobId: foreignJobId,
  });
  assert.ok(foreignLead);
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await app.listen({ host: '127.0.0.1', port: 5390 });
  const axeSource = await readFile(
    fileURLToPath(new URL('../node_modules/axe-core/axe.min.js', import.meta.url)),
    'utf8',
  );
  /** Fails on any WCAG 2.1 A/AA violation at the given widths. */
  const accessible = async (
    page: import('playwright').Page,
    engine: string,
    view: string,
    heading: string | RegExp,
  ) => {
    // axe must sample the route it is supposed to be auditing, not the
    // outgoing one: during a client-side transition the previous route's DOM
    // and its <title> are both still present, so "the title is non-empty"
    // (which this used to wait for) is satisfied by the stale document — the
    // exact moment WebKit was observed sampling (axe `document-title`,
    // intermittently). Waiting for *this* view's own <h1> is a route-specific
    // signal that cannot be satisfied by the previous route. The title is
    // then still required to be non-empty, so a genuinely title-less page
    // fails loudly here (Playwright's 30s default) rather than inside axe.
    await page.getByRole('heading', { level: 1, name: heading }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.title.trim().length > 0);
    for (const width of responsiveWidthsEndingAt(1440)) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(axeSource);
      const audit = await page.evaluate(async () => {
        const runner = (
          globalThis as unknown as {
            axe: {
              run: (
                context: unknown,
                options: unknown,
              ) => Promise<{
                violations: { id: string; impact: string | null; nodes: { target: string[] }[] }[];
              }>;
            };
          }
        ).axe;
        return runner.run(document, {
          runOnly: {
            type: 'tag',
            // CS-15 AC1 says WCAG 2.2 AA. This list pinned 2.1 until 2026-09-25,
            // so the check that enforces the baseline was one WCAG version
            // behind the criterion it exists to enforce — axe-core 4.12 ships
            // the 2.2 rules (target size 2.5.8, focus not obscured 2.4.11) and
            // they were simply not requested.
            values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'],
          },
        });
      });
      assert.deepEqual(
        audit.violations.map(
          (violation) =>
            `${violation.id} [${violation.impact}] ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
        ),
        [],
        `${engine} ${view} at ${width}px has accessibility violations`,
      );
    }
  };
  for (const [engine, browserType] of uiBrowsers) {
    // Legacy password-account fixtures exercise existing data/session behavior.
    // The public test selector and its real allowlist are verified separately.
    const accountEmail = `signup-${engine}@example.test`;
    await new Auth(database).register(accountEmail, password);
    const otpEmail = `otp-${engine}@example.test`;
    await new Auth(database).register(otpEmail, password);
    // Each browser engine runs the same end-to-end scenario against the shared
    // temporary database. The scenario intentionally creates a saved lead and
    // then exercises its failure/retry path; without resetting only this
    // owner's lead rows, the next engine correctly hydrates that lead as
    // already saved and the assertion that starts from "Save Job" becomes
    // order-dependent. Keep the unrelated foreign-owner fixture intact so the
    // authorization checks still exercise a real cross-owner record.
    await database.pool.query('DELETE FROM interview_round_documents WHERE owner_id = $1', [
      ownerId,
    ]);
    await database.pool.query('DELETE FROM interview_rounds WHERE owner_id = $1', [ownerId]);
    await database.pool.query('DELETE FROM lead_history WHERE owner_id = $1', [ownerId]);
    await database.pool.query('DELETE FROM saved_leads WHERE owner_id = $1', [ownerId]);
    const browser = await browserType.launch();
    try {
      const rejectionGuardProbe = await browser.newPage();
      await installUnhandledRejectionGuard(rejectionGuardProbe);
      await rejectionGuardProbe.goto('about:blank');
      await rejectionGuardProbe.evaluate(() => {
        void Promise.reject(new TypeError('synthetic guard probe'));
      });
      await rejectionGuardProbe.waitForFunction(
        () =>
          (window as Window & { __CAREERSCOPE_UNHANDLED_REJECTIONS__?: string[] })
            .__CAREERSCOPE_UNHANDLED_REJECTIONS__?.length === 1,
      );
      assert.deepEqual(await unhandledRejections(rejectionGuardProbe), ['TypeError']);
      await rejectionGuardProbe.close();

      const otpPage = await browser.newPage();
      await installUnhandledRejectionGuard(otpPage);
      let otpRequestCount = 0;
      let otpVerified = false;
      let otpCurrentEmail = otpEmail;
      let otpEmailVerificationTimestamp: string | null = '2026-10-20T12:00:00.000Z';
      let emailChangeRequestCount = 0;
      const emailChangeVerifications: string[] = [];
      const otpPageErrors: string[] = [];
      const otpConsoleErrors: string[] = [];
      const otpInflight = new Set<import('playwright').Request>();
      otpPage.on('request', (request) => {
        if (request.resourceType() !== 'eventsource') otpInflight.add(request);
      });
      otpPage.on('requestfinished', (request) => otpInflight.delete(request));
      otpPage.on('requestfailed', (request) => otpInflight.delete(request));
      otpPage.on('pageerror', (error) => otpPageErrors.push(error.message));
      otpPage.on('crash', () => otpPageErrors.push('page crashed'));
      otpPage.on('console', (message) => {
        if (message.type() === 'error') otpConsoleErrors.push(browserConsoleErrorKind(message));
      });
      const otpConsoleSentinel = otpPage.waitForEvent(
        'console',
        (message) =>
          message.type() === 'error' && message.text() === 'careerscope-runtime-guard-sentinel',
      );
      await otpPage.evaluate(() => console.error('careerscope-runtime-guard-sentinel'));
      await otpConsoleSentinel;
      assert.deepEqual(otpConsoleErrors, ['synthetic console sentinel']);
      otpConsoleErrors.length = 0;
      const settleOtpRequests = async (label: string) => {
        const deadline = Date.now() + 15000;
        let quietSince = Date.now();
        while (Date.now() < deadline) {
          if (otpInflight.size > 0) quietSince = Date.now();
          else if (Date.now() - quietSince >= 250) return;
          await otpPage.waitForTimeout(25);
        }
        assert.fail(
          `${engine} ${label} left requests in flight: ${[...otpInflight]
            .map((request) => `${request.method()} ${request.url()}`)
            .join(', ')}`,
        );
      };
      // Deterministic browser contract test: real CareerScope UI, while the
      // network boundary is mocked so no real email or account is contacted.
      await otpPage.route('**/api/**', (route) =>
        route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: '{"error":"Not found"}',
        }),
      );
      await otpPage.route('**/api/profile/accessibility', (route) =>
        route.fulfill({ contentType: 'application/json', json: { reducedMotion: false } }),
      );
      await otpPage.route('**/api/session', (route) =>
        route.fulfill({
          contentType: 'application/json',
          json: otpVerified
            ? {
                authenticated: true,
                csrf: 'synthetic-csrf-token',
                email: otpCurrentEmail,
                emailVerifiedAt: otpEmailVerificationTimestamp,
                owner: 'a'.repeat(64),
                aiEnabled: false,
                emailOtpEnabled: true,
              }
            : {
                authenticated: false,
                registrationEnabled: true,
                emailOtpEnabled: true,
                testUsersEnabled: false,
                testAccounts: [],
                legalDocuments: {
                  termsVersion: 'test-terms-1',
                  termsUrl: 'https://careerscope.test/terms',
                  privacyVersion: 'test-privacy-1',
                  privacyUrl: 'https://careerscope.test/privacy',
                },
              },
        }),
      );
      let otpInterviewRemindersEnabled = true;
      let loseNextPreferenceResponse = false;
      let failNextPreferenceRead = false;
      await otpPage.route('**/api/notifications/preferences', (route) => {
        if (route.request().method() === 'GET') {
          if (failNextPreferenceRead) {
            failNextPreferenceRead = false;
            return route.fulfill({ status: 503, contentType: 'application/json', json: {} });
          }
          return route.fulfill({
            contentType: 'application/json',
            json: { interviewRemindersInAppEnabled: otpInterviewRemindersEnabled },
          });
        }
        if (route.request().method() !== 'PUT')
          return route.fulfill({ status: 405, contentType: 'application/json', json: {} });
        const body = route.request().postDataJSON() as {
          interviewRemindersInAppEnabled: boolean;
        };
        otpInterviewRemindersEnabled = body.interviewRemindersInAppEnabled;
        if (loseNextPreferenceResponse) {
          loseNextPreferenceResponse = false;
          // Model a gateway failure after the origin committed the write. The
          // UI must refresh instead of claiming the old value is still active.
          return route.fulfill({ status: 502, contentType: 'application/json', json: {} });
        }
        return route.fulfill({
          contentType: 'application/json',
          json: { interviewRemindersInAppEnabled: otpInterviewRemindersEnabled },
        });
      });
      await otpPage.route('**/api/otp/request', (route) => {
        otpRequestCount += 1;
        return route.fulfill({
          status: 202,
          contentType: 'application/json',
          json: {
            message: 'If the request can be completed, check your inbox for a verification code.',
            expiresInSeconds: 300,
            resendAfterSeconds: 60,
          },
        });
      });
      await otpPage.route('**/api/otp/verify', async (route) => {
        const body = route.request().postDataJSON() as { email: string; code: string };
        if (body.email !== otpEmail || body.code !== '123456')
          return route.fulfill({
            status: 401,
            contentType: 'application/json',
            json: { error: 'Invalid or expired verification code', requestId: randomUUID() },
          });
        otpVerified = true;
        return route.fulfill({ contentType: 'application/json', json: { authenticated: true } });
      });
      await otpPage.route('**/api/account/email-change/request', async (route) => {
        emailChangeRequestCount += 1;
        const body = route.request().postDataJSON() as { newEmail: string };
        assert.equal(body.newEmail, 'updated@example.test');
        return route.fulfill({
          status: 202,
          contentType: 'application/json',
          json: { message: 'If the request can be completed, check both email inboxes.' },
        });
      });
      await otpPage.route('**/api/account/email-change/verify', async (route) => {
        const body = route.request().postDataJSON() as { address: string; code: string };
        emailChangeVerifications.push(body.address);
        const emailChanged = emailChangeVerifications.length === 2;
        if (emailChanged) otpCurrentEmail = 'updated@example.test';
        return route.fulfill({
          contentType: 'application/json',
          json: { verified: body.address, emailChanged },
        });
      });
      await otpPage.goto(origin);
      await otpPage.getByRole('heading', { level: 1, name: 'Sign in to CareerScope' }).waitFor();
      await accessible(otpPage, engine, 'OTP request form', 'Sign in to CareerScope');
      await otpPage.getByLabel('Email address').fill(otpEmail);
      await otpPage.getByRole('button', { name: 'Send verification code' }).click();
      await otpPage.getByLabel('Six-digit verification code').waitFor();
      await accessible(otpPage, engine, 'OTP verification form', 'Sign in to CareerScope');
      for (const width of responsiveWidthsEndingAt(1440)) {
        await otpPage.setViewportSize({ width, height: 900 });
        assert.equal(
          await otpPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${engine} OTP form overflows horizontally at ${width}px`,
        );
      }
      assert.equal(
        await otpPage
          .getByLabel('Six-digit verification code')
          .evaluate((element) => element === document.activeElement),
        true,
      );
      assert.equal(
        await otpPage.getByRole('button', { name: /Resend code in/ }).isDisabled(),
        true,
      );
      await otpPage.getByLabel('Six-digit verification code').fill('000000');
      await otpPage.getByRole('button', { name: 'Verify and sign in' }).click();
      await otpPage.getByRole('alert').filter({ hasText: 'invalid or expired' }).waitFor();
      assert.equal(await otpPage.getByLabel('Six-digit verification code').inputValue(), '');
      await otpPage.getByLabel('Six-digit verification code').fill('123456');
      await otpPage.getByRole('button', { name: 'Verify and sign in' }).click();
      await otpPage.waitForURL((url) => url.pathname === '/dashboard');
      await settleOtpRequests('dashboard after OTP sign-in');
      assert.equal(otpRequestCount, 1, 'one explicit send action must issue one code request');
      assert.equal(
        await otpPage
          .evaluate(() => Object.values(localStorage).join(' '))
          .then((value) => value.includes('123456')),
        false,
        'OTP must not be persisted in browser storage',
      );
      await otpPage.goto(`${origin}/settings`);
      await otpPage.getByRole('heading', { name: 'Account security', exact: true }).waitFor();
      const otpReminderPreference = otpPage.getByRole('checkbox', {
        name: 'Show upcoming interview reminders in CareerScope',
      });
      await otpReminderPreference.waitFor();
      assert.equal(await otpReminderPreference.isChecked(), true);
      const otpPreferenceSaved = otpPage.waitForResponse(
        (response) =>
          response.url().endsWith('/api/notifications/preferences') &&
          response.request().method() === 'PUT',
      );
      await otpReminderPreference.evaluate((element: HTMLInputElement) => element.click());
      assert.equal((await otpPreferenceSaved).status(), 200);
      await otpPage.getByRole('status').getByText('Notification preference saved.').waitFor();
      assert.equal(await otpReminderPreference.isChecked(), false);
      assert.equal(otpInterviewRemindersEnabled, false);
      loseNextPreferenceResponse = true;
      failNextPreferenceRead = true;
      await otpReminderPreference.evaluate((element: HTMLInputElement) => element.click());
      await otpPage
        .getByRole('alert')
        .getByText('The saved value is not confirmed. Reload it before making another change.', {
          exact: true,
        })
        .waitFor();
      assert.equal(await otpReminderPreference.count(), 0);
      await otpPage.getByRole('button', { name: 'Retry' }).click();
      await otpPage
        .getByRole('checkbox', {
          name: 'Show upcoming interview reminders in CareerScope',
        })
        .waitFor();
      assert.equal(
        await otpPage
          .getByRole('checkbox', { name: 'Show upcoming interview reminders in CareerScope' })
          .isChecked(),
        true,
      );
      assert.equal(otpInterviewRemindersEnabled, true);
      await otpPage
        .getByRole('status')
        .filter({ hasText: /^Email verified on / })
        .waitFor();
      await settleOtpRequests('account security route after sign-in');
      otpEmailVerificationTimestamp = null;
      await otpPage.reload();
      await otpPage
        .getByRole('status')
        .filter({ hasText: /^Email verification is not recorded\.$/ })
        .waitFor();
      await settleOtpRequests('legacy account without recorded email verification');
      otpEmailVerificationTimestamp = '2026-10-20T12:00:00.000Z';
      await otpPage.reload();
      await otpPage
        .getByRole('status')
        .filter({ hasText: /^Email verified on / })
        .waitFor();
      await settleOtpRequests('account security restored verification status');
      await otpPage.getByLabel('New email address').fill('updated@example.test');
      await otpPage.getByRole('button', { name: 'Send verification codes' }).click();
      await otpPage.getByLabel('Code sent to current email').waitFor();
      await otpPage.getByLabel('Code sent to current email').fill('111111');
      await otpPage.getByRole('button', { name: 'Verify current email' }).click();
      await otpPage.getByText('Current address verified. Now verify the new address.').waitFor();
      await otpPage.getByLabel('Code sent to new email').fill('222222');
      await otpPage.getByRole('button', { name: 'Verify new email' }).click();
      await otpPage
        .getByText('Email address updated. The previous address received a verification notice.')
        .waitFor();
      await otpPage.getByText('Current email: updated@example.test', { exact: true }).waitFor();
      assert.equal(emailChangeRequestCount, 1);
      assert.deepEqual(emailChangeVerifications, ['current', 'new']);
      for (const width of responsiveWidthsEndingAt(1440)) {
        await otpPage.setViewportSize({ width, height: 900 });
        assert.equal(
          await otpPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${engine} email-change form overflows horizontally at ${width}px`,
        );
      }
      await accessible(otpPage, engine, 'dual-address email-change workflow', 'Account security');
      await settleOtpRequests('email-change workflow');
      assert.deepEqual(otpPageErrors, [], `${engine} email OTP UI produced browser errors`);
      assert.deepEqual(
        otpConsoleErrors.filter((error) => !expectedOtpFixtureConsoleErrors.has(error)),
        [],
        `${engine} email OTP UI produced unexpected console errors`,
      );
      assert.deepEqual(
        await unhandledRejections(otpPage),
        [],
        `${engine} email OTP UI produced an unhandled promise rejection`,
      );
      await otpPage.close();

      const signupPage = await browser.newPage();
      await installUnhandledRejectionGuard(signupPage);
      let signupAuthenticated = false;
      let signupRequestCount = 0;
      let signupVerificationCount = 0;
      let signupRequestBody: Record<string, unknown> | undefined;
      let signupVerificationBody: Record<string, unknown> | undefined;
      await signupPage.route('**/api/**', (route) =>
        route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: '{"error":"Not found"}',
        }),
      );
      await signupPage.route('**/api/session', (route) =>
        route.fulfill({
          contentType: 'application/json',
          json: signupAuthenticated
            ? {
                authenticated: true,
                csrf: 'synthetic-signup-csrf',
                email: otpEmail,
                owner: 'b'.repeat(64),
                aiEnabled: false,
              }
            : {
                authenticated: false,
                registrationEnabled: true,
                emailOtpEnabled: true,
                testUsersEnabled: false,
                testAccounts: [],
                legalDocuments: {
                  termsVersion: 'test-terms-1',
                  termsUrl: 'https://careerscope.test/terms',
                  privacyVersion: 'test-privacy-1',
                  privacyUrl: 'https://careerscope.test/privacy',
                },
              },
        }),
      );
      await signupPage.route('**/api/otp/request', (route) => {
        signupRequestCount += 1;
        signupRequestBody = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill({
          status: 202,
          contentType: 'application/json',
          json: {
            message: 'If the request can be completed, check your inbox for a verification code.',
            expiresInSeconds: 300,
            resendAfterSeconds: 60,
          },
        });
      });
      await signupPage.route('**/api/otp/verify', (route) => {
        signupVerificationCount += 1;
        signupVerificationBody = route.request().postDataJSON() as Record<string, unknown>;
        signupAuthenticated = true;
        return route.fulfill({ contentType: 'application/json', json: { authenticated: true } });
      });
      await signupPage.goto(origin);
      await signupPage.getByRole('button', { name: 'Create an account', exact: true }).click();
      await accessible(
        signupPage,
        engine,
        'signup acceptance form',
        'Create your CareerScope account',
      );
      const signupEmail = `signup-${engine}@example.test`;
      await signupPage.getByLabel('Email address').fill(signupEmail);
      await signupPage.getByLabel('Date of birth').fill('1990-01-01');
      await signupPage.getByText(/We use this only to check age eligibility/).waitFor();
      await signupPage.getByRole('button', { name: 'Send verification code', exact: true }).click();
      assert.equal(
        signupRequestCount,
        0,
        'signup cannot request a code without required acceptance',
      );
      await signupPage.getByLabel(/I accept the Terms of Service/).check();
      await signupPage.getByLabel(/I acknowledge the Privacy Notice/).check();
      assert.equal(
        await signupPage.getByLabel(/optional CareerScope product updates/).isChecked(),
        false,
      );
      for (const width of responsiveWidthsEndingAt(1440)) {
        await signupPage.setViewportSize({ width, height: 900 });
        assert.equal(
          await signupPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${engine} signup acceptance form overflows at ${width}px`,
        );
      }
      await signupPage.getByRole('button', { name: 'Send verification code', exact: true }).click();
      await signupPage.getByLabel('Six-digit verification code').waitFor();
      assert.deepEqual(signupRequestBody, {
        email: signupEmail,
        intent: 'sign-up',
        termsAccepted: true,
        privacyAcknowledged: true,
        marketingOptIn: false,
        dateOfBirth: '1990-01-01',
      });
      assert.equal(
        await signupPage
          .evaluate(() =>
            [...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n'),
          )
          .then((stored) => stored.includes('1990-01-01')),
        false,
        'age input is not persisted in browser storage',
      );
      await signupPage.getByLabel('Six-digit verification code').fill('123456');
      await signupPage
        .getByRole('button', { name: 'Verify and create account', exact: true })
        .click();
      await signupPage.waitForURL((url) => url.pathname === '/dashboard');
      assert.equal(signupVerificationCount, 1);
      assert.deepEqual(signupVerificationBody, {
        email: signupEmail,
        code: '123456',
        intent: 'sign-up',
      });
      assert.equal(
        Object.hasOwn(signupVerificationBody, 'dateOfBirth'),
        false,
        'the birth date is not sent to OTP verification',
      );
      assert.deepEqual(
        await unhandledRejections(signupPage),
        [],
        `${engine} signup UI produced an unhandled promise rejection`,
      );
      await signupPage.close();

      const page = await browser.newPage();
      if (notificationLifecycleOnly) await observeNotificationPage(page, origin);
      await installUnhandledRejectionGuard(page);
      const browserLifecycleAudit = new Map<
        string,
        { route: string; events: string[]; cdpEvents: string[]; cdpRequestIds: string[] }
      >();
      const browserLifecycleAuditByRequest = new WeakMap<import('playwright').Request, string>();
      const cdp = engine === 'chromium' ? await page.context().newCDPSession(page) : undefined;
      const cdpRequestIds = new Map<string, string>();
      const cdpTargetRequests = new Set<string>();
      const maxCdpLifecycleRecords = 128;
      let cdpLifecycleOverflow = 0;
      const cdpFingerprintKey = randomBytes(32);
      const cdpRequestDetails = new Map<
        string,
        {
          method: string;
          path: string;
          fingerprint: string;
          initiatorType: string;
          events: string[];
          active: boolean;
        }
      >();
      const cdpEventsPendingCorrelation = new Map<string, string[]>();
      const cdpExtraInfoPendingRequest = new Map<string, string>();
      const correlationIdFromHeaders = (headers: Record<string, string>) =>
        Object.entries(headers).find(
          ([key]) => key.toLowerCase() === 'x-careerscope-ui-lifecycle-id',
        )?.[1];
      const safeRequestFingerprint = (method: string, url: string) =>
        createHmac('sha256', cdpFingerprintKey)
          .update(`${method}\n${url}`)
          .digest('hex')
          .slice(0, 16);
      const flushCdpEvents = (requestId: string, auditId: string) => {
        const pending = cdpEventsPendingCorrelation.get(requestId) ?? [];
        browserLifecycleAudit.get(auditId)?.cdpEvents.push(...pending);
        cdpEventsPendingCorrelation.delete(requestId);
      };
      const recordCdpEvent = (requestId: string, event: string) => {
        const auditId = cdpRequestIds.get(requestId);
        const audit = auditId ? browserLifecycleAudit.get(auditId) : undefined;
        if (audit) audit.cdpEvents.push(event);
        else if (cdpTargetRequests.has(requestId)) {
          const pending = cdpEventsPendingCorrelation.get(requestId) ?? [];
          pending.push(event);
          cdpEventsPendingCorrelation.set(requestId, pending);
        }
      };
      const recordCdpCorrelation = (requestId: string, headers: Record<string, unknown>) => {
        const id = Object.entries(headers).find(
          ([key, value]) =>
            key.toLowerCase() === 'x-careerscope-ui-lifecycle-id' && typeof value === 'string',
        )?.[1];
        if (typeof id !== 'string' || !browserLifecycleAudit.has(id)) return;
        cdpRequestIds.set(requestId, id);
        const audit = browserLifecycleAudit.get(id);
        if (audit && !audit.cdpRequestIds.includes(requestId)) audit.cdpRequestIds.push(requestId);
        flushCdpEvents(requestId, id);
      };
      if (cdp) {
        await cdp.send('Network.enable');
        cdp.on('Network.requestWillBeSent', (event) => {
          recordCdpCorrelation(event.requestId, event.request.headers);
          const path = new URL(event.request.url).pathname;
          if (
            path === '/api/profile/accessibility' ||
            path === '/api/notifications' ||
            ['/dashboard', '/jobs', '/applications', '/saved'].includes(path)
          ) {
            if (
              !cdpRequestDetails.has(event.requestId) &&
              cdpRequestDetails.size >= maxCdpLifecycleRecords
            ) {
              const terminalId = [...cdpRequestDetails].find(([, value]) => !value.active)?.[0];
              if (terminalId) {
                cdpRequestDetails.delete(terminalId);
                cdpRequestIds.delete(terminalId);
              } else {
                cdpLifecycleOverflow += 1;
                cdpExtraInfoPendingRequest.delete(event.requestId);
                cdpRequestIds.delete(event.requestId);
                return;
              }
            }
            cdpTargetRequests.add(event.requestId);
            const existing = cdpRequestDetails.get(event.requestId);
            const details = existing ?? {
              method: event.request.method,
              path,
              fingerprint: safeRequestFingerprint(event.request.method, event.request.url),
              initiatorType: event.initiator.type,
              events: [],
              active: true,
            };
            if (event.redirectResponse)
              details.events.push(`redirect-${event.redirectResponse.status}-to-${path}`);
            details.method = event.request.method;
            details.path = path;
            details.initiatorType = event.initiator.type;
            details.fingerprint = safeRequestFingerprint(event.request.method, event.request.url);
            details.active = true;
            details.events.push('request-started');
            cdpRequestDetails.set(event.requestId, details);
            recordCdpEvent(event.requestId, 'request-started');
            const auditId = cdpExtraInfoPendingRequest.get(event.requestId);
            if (auditId) {
              cdpRequestIds.set(event.requestId, auditId);
              flushCdpEvents(event.requestId, auditId);
              cdpExtraInfoPendingRequest.delete(event.requestId);
            }
          }
        });
        cdp.on('Network.requestWillBeSentExtraInfo', (event) => {
          const headers = event.headers as Record<string, string>;
          const id = correlationIdFromHeaders(headers);
          if (typeof id !== 'string') return;
          if (!cdpTargetRequests.has(event.requestId)) {
            cdpExtraInfoPendingRequest.set(event.requestId, id);
            return;
          }
          cdpRequestIds.set(event.requestId, id);
          flushCdpEvents(event.requestId, id);
        });
        cdp.on('Network.responseReceived', (event) => {
          if (cdpTargetRequests.has(event.requestId)) {
            const details = cdpRequestDetails.get(event.requestId);
            if (details) details.events.push(`response-${event.response.status}`);
            recordCdpEvent(event.requestId, `response-${event.response.status}`);
          }
        });
        cdp.on('Network.loadingFinished', (event) => {
          if (cdpTargetRequests.has(event.requestId)) {
            const details = cdpRequestDetails.get(event.requestId);
            if (details) {
              details.active = false;
              details.events.push('loading-finished');
            }
            recordCdpEvent(event.requestId, 'loading-finished');
            cdpTargetRequests.delete(event.requestId);
            cdpEventsPendingCorrelation.delete(event.requestId);
            cdpExtraInfoPendingRequest.delete(event.requestId);
          }
        });
        cdp.on('Network.loadingFailed', (event) => {
          if (cdpTargetRequests.has(event.requestId)) {
            const details = cdpRequestDetails.get(event.requestId);
            if (details) {
              details.active = false;
              details.events.push(`loading-failed-${event.errorText}`);
            }
            recordCdpEvent(event.requestId, `loading-failed-${event.errorText}`);
            cdpTargetRequests.delete(event.requestId);
            cdpEventsPendingCorrelation.delete(event.requestId);
            cdpExtraInfoPendingRequest.delete(event.requestId);
          }
        });
      }
      // Keep request settlement observational: routing every GET through
      // Playwright and adding a diagnostic header changes the network path
      // under test. Chromium previously showed a request that Fastify had
      // completed but that neither Playwright nor CDP saw finish. Leave the
      // request untouched here; Playwright and CDP below still fail strictly
      // on any request that remains active at the settlement deadline.
      page.on('request', (request) => {
        const id =
          browserLifecycleAuditByRequest.get(request) ??
          request.headers()['x-careerscope-ui-lifecycle-id'];
        if (notificationLifecycleOnly && id && !browserLifecycleAudit.has(id)) {
          browserLifecycleAudit.set(id, {
            route: '/api/notifications',
            events: [],
            cdpEvents: [],
            cdpRequestIds: [],
          });
          browserLifecycleAuditByRequest.set(request, id);
        }
        if (id) browserLifecycleAudit.get(id)?.events.push('playwright-request');
      });
      page.on('response', (response) => {
        const request = response.request();
        const id =
          browserLifecycleAuditByRequest.get(request) ??
          request.headers()['x-careerscope-ui-lifecycle-id'];
        if (id)
          browserLifecycleAudit.get(id)?.events.push(`playwright-response-${response.status()}`);
      });
      page.on('requestfinished', (request) => {
        const id =
          browserLifecycleAuditByRequest.get(request) ??
          request.headers()['x-careerscope-ui-lifecycle-id'];
        if (id) browserLifecycleAudit.get(id)?.events.push('playwright-finished');
      });
      page.on('requestfailed', (request) => {
        const id =
          browserLifecycleAuditByRequest.get(request) ??
          request.headers()['x-careerscope-ui-lifecycle-id'];
        if (id) browserLifecycleAudit.get(id)?.events.push('playwright-failed');
      });
      let fixtureCredential = password;
      await page.route('**/api/session', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        if (body.authenticated === false) {
          await route.fulfill({
            response,
            json: {
              ...body,
              testUsersEnabled: true,
              testAccounts: [accountEmail, 'ui@example.test', 'foreign-owner@example.test'].map(
                (email) => ({ email, role: 'candidate' }),
              ),
            },
          });
        } else await route.fulfill({ response });
      });
      await page.route('**/api/login', (route) => {
        const { email } = route.request().postDataJSON();
        return route.continue({ postData: JSON.stringify({ email, password: fixtureCredential }) });
      });
      const selectFixtureAccount = async (email: string, credential = password) => {
        fixtureCredential = credential;
        await page.getByRole('button').filter({ hasText: email }).click();
      };
      const errors: string[] = [];
      const warningDiagnostics =
        engine === 'firefox' && process.env.CAREERSCOPE_UI_WARNING_DIAGNOSTICS === '1';
      const observedWarnings: {
        at: number;
        epoch: number;
        category: string;
        locationPath: string | null;
        pagePath: string | null;
        paths: string[];
      }[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(browserConsoleErrorKind(message));
        if (warningDiagnostics && message.type() === 'warning') {
          const paths = browserWarningPaths(message.text(), message.location().url, origin);
          if (paths.length > 0) {
            observedWarnings.push({
              at: Date.now(),
              epoch: routeEpoch,
              category: browserWarningCategory(message.text()),
              locationPath: sameOriginBrowserPath(message.location().url, origin),
              pagePath: sameOriginBrowserPath(page.url(), origin),
              paths,
            });
          }
        }
      });
      page.on('pageerror', (error) => {
        // WebKit can report an in-flight same-host fetch cancelled by a
        // full-document navigation as an access-control page error. The OTP
        // workflow above is kept strict and explicitly waits for its requests;
        // retain only the existing narrow WebKit/loopback diagnostic filter
        // for this older, longer navigation scenario.
        const isWebKitNavigationArtifact =
          engine === 'webkit' &&
          error.message.includes('due to access control checks.') &&
          error.message.includes('/localhost:5280/');
        if (!isWebKitNavigationArtifact) errors.push(error.message);
      });
      page.on('crash', () => errors.push('page crashed'));
      // A full-document navigation (goto/reload) that lands while the current
      // client-side route is still issuing its data fetches strands those
      // fetches, and WebKit reports a fetch started against a document that is
      // being replaced as "Fetch API cannot load <url> due to access control
      // checks" — which Playwright surfaces as a page error. The gate remains
      // strict in every engine, so the test settles requests before document
      // navigation rather than filtering that page error.
      //
      // page.waitForLoadState('networkidle') cannot express this: it resolves
      // immediately once the *current document* has reached that state once,
      // so on a long-lived single-page document it returns without waiting at
      // all (measured returning ~180ms after the last response, 30ms before
      // the reload that then stranded two /api/resumes fetches). The set below
      // tracks in-flight requests directly. EventSource streams (the search
      // progress feed) are excluded because they stay open by design and would
      // never let the page look idle.
      const inflight = new Map<import('playwright').Request, number>();
      let routeEpoch = 0;
      let nextDiagnosticRequestId = 0;
      const diagnosticRequests = new Map<
        import('playwright').Request,
        {
          id: number;
          method: string;
          path: string;
          resourceType: string;
          isNavigation: boolean;
          epoch: number;
          pagePath: string | null;
          events: { kind: string; at: number }[];
        }
      >();
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) routeEpoch += 1;
      });
      const activeRequests = () =>
        [...inflight].filter(
          ([request, epoch]) =>
            !staleSavedRead(request.method(), new URL(request.url()).pathname, epoch, routeEpoch) &&
            !staleSearchRead(request.method(), new URL(request.url()).pathname, epoch, routeEpoch),
        );
      const recentRequestEvents: string[] = [];
      const sharedRoutePrefetches: string[] = [];
      const sharedRoutePaths = new Set([
        '/dashboard',
        '/jobs',
        '/applications',
        '/saved',
        '/resume',
        '/settings',
        '/career-resources',
        '/preparation',
      ]);
      const recordRequestEvent = (request: import('playwright').Request, event: string) => {
        const rawPath = new URL(request.url()).pathname;
        const path = rawPath
          .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/:id')
          .replace(/\/[0-9a-f]{24,}/gi, '/:id');
        recentRequestEvents.push(`${Date.now()} ${request.method()} ${path} ${event}`);
        if (recentRequestEvents.length > 40) recentRequestEvents.shift();
        const diagnostic = diagnosticRequests.get(request);
        if (diagnostic) diagnostic.events.push({ kind: event, at: Date.now() });
      };
      page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (sharedRoutePaths.has(pathname) && request.headers()['next-router-prefetch'] === '1') {
          sharedRoutePrefetches.push(pathname);
        }
        const isSearchEventStream = /^\/api\/searches\/[^/]+\/events$/.test(pathname);
        if (request.resourceType() !== 'eventsource' && !isSearchEventStream) {
          inflight.set(request, routeEpoch);
          const sameOriginPath = sameOriginBrowserPath(request.url(), origin);
          if (warningDiagnostics && sameOriginPath?.startsWith('/_next/static/chunks/')) {
            diagnosticRequests.set(request, {
              id: ++nextDiagnosticRequestId,
              method: request.method(),
              path: sameOriginPath,
              resourceType: request.resourceType(),
              isNavigation: request.isNavigationRequest(),
              epoch: routeEpoch,
              pagePath: sameOriginBrowserPath(page.url(), origin),
              events: [],
            });
          }
          recordRequestEvent(request, 'started');
        }
      });
      page.on('response', (response) => {
        const request = response.request();
        if (inflight.has(request)) recordRequestEvent(request, `response-${response.status()}`);
      });
      page.on('requestfinished', (request) => {
        inflight.delete(request);
        recordRequestEvent(request, 'finished');
      });
      page.on('requestfailed', (request) => {
        inflight.delete(request);
        recordRequestEvent(
          request,
          `failed-${browserRequestFailureCategory(request.failure()?.errorText ?? '')}`,
        );
      });
      const settled = async (label: string) => {
        const deadline = Date.now() + 15000;
        let quietSince = Date.now();
        while (Date.now() < deadline) {
          if (activeRequests().length > 0) quietSince = Date.now();
          else if (Date.now() - quietSince >= 250) return;
          await page.waitForTimeout(25);
        }
        const active = activeRequests();
        const pendingAuditIds = new Set<string>();
        const pending = active.map(([request, epoch]) => {
          const url = new URL(request.url());
          const id =
            browserLifecycleAuditByRequest.get(request) ??
            request.headers()['x-careerscope-ui-lifecycle-id'];
          if (id) pendingAuditIds.add(id);
          const audit = id ? browserLifecycleAudit.get(id) : undefined;
          const server = id ? requestLifecycleAudit.get(id) : undefined;
          const headers = request.headers();
          const routePrefetch = {
            rsc: headers.rsc ?? 'none',
            nextRouterPrefetch: headers['next-router-prefetch'] ?? 'none',
            purpose: headers.purpose ?? headers['sec-purpose'] ?? 'none',
          };
          return `${request.method()} ${url.pathname} (${request.resourceType()}, navigation=${request.isNavigationRequest()}, route ${epoch}/${routeEpoch}, responseEnd ${request.timing().responseEnd}, failure ${request.failure()?.errorText ?? 'none'}, id=${id?.slice(-6) ?? 'none'}, routePrefetch=${JSON.stringify(routePrefetch)}, browser=${JSON.stringify(audit ?? null)}, server=${JSON.stringify(server ?? null)})`;
        });
        const unresolvedLifecycle = [...browserLifecycleAudit]
          .filter(([id]) => pendingAuditIds.has(id))
          .map(([id, value]) => ({
            id: id.slice(-6),
            ...value,
            cdpRequestIds: value.cdpRequestIds.map((requestId) => requestId.slice(-8)),
            server: requestLifecycleAudit.get(id) ?? null,
          }));
        const chromiumMatchingLifecycle: Array<{
          method: string;
          path: string;
          fingerprint: string;
          playwrightActiveCount: number;
          cdpMatches: {
            requestId: string;
            lifecycleId: string | null;
            active: boolean;
            initiatorType: string;
            events: string[];
          }[];
        }> = [];
        if (engine === 'chromium') {
          const activeGroups = new Map<string, (typeof chromiumMatchingLifecycle)[number]>();
          for (const [request] of active) {
            const path = new URL(request.url()).pathname;
            const fingerprint = safeRequestFingerprint(request.method(), request.url());
            let group = activeGroups.get(fingerprint);
            if (!group) {
              group = {
                method: request.method(),
                path,
                fingerprint,
                playwrightActiveCount: 0,
                cdpMatches: [...cdpRequestDetails.entries()]
                  .filter(
                    ([, details]) =>
                      details.method === request.method() &&
                      details.path === path &&
                      details.fingerprint === fingerprint,
                  )
                  .map(([requestId, { active: cdpActive, initiatorType, events }]) => ({
                    requestId: requestId.slice(-8),
                    lifecycleId: cdpRequestIds.get(requestId)?.slice(-6) ?? null,
                    active: cdpActive,
                    initiatorType,
                    events: [...events],
                  })),
              };
              activeGroups.set(fingerprint, group);
            }
            group.playwrightActiveCount += 1;
          }
          chromiumMatchingLifecycle.push(...activeGroups.values());
        }
        let proxyProbe: Record<string, string | number>;
        try {
          const response = await fetch(`${origin}/api/notifications`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(3000),
          });
          proxyProbe = {
            status: response.status,
            contentType: response.headers.get('content-type') ?? 'none',
            contentLength: response.headers.get('content-length') ?? 'none',
          };
          await response.body?.cancel();
        } catch (error) {
          proxyProbe = {
            error: error instanceof Error ? error.name : 'unknown',
          };
        }
        throw new Error(
          `${engine}: ${label} never stopped issuing requests (${pending.join(', ') || 'none'}); ` +
            `recent request events: ${recentRequestEvents.join(' | ') || 'none'}; ` +
            `request lifecycle audit: ${JSON.stringify(unresolvedLifecycle)}; ` +
            `Chromium matching network lifecycle: ${JSON.stringify(chromiumMatchingLifecycle)}; ` +
            `Chromium lifecycle records omitted at cap: ${cdpLifecycleOverflow}; ` +
            `unauthenticated same-origin proxy probe: ${JSON.stringify(proxyProbe)}`,
        );
      };
      // Search selection keeps polling enabled. All finite requests must finish
      // before reload; the quiet window does not require polling to stop.
      const settledSearchPage = settled;
      const waitForSearchStatusResponse = (runId: string, expectedStatus: string) =>
        page.waitForResponse(
          async (response) => {
            if (
              response.request().method() !== 'GET' ||
              response.url() !== `${origin}/api/searches/${runId}` ||
              response.status() !== 200
            )
              return false;
            return (await response.json()).status === expectedStatus;
          },
          { timeout: 15000 },
        );
      // CS-54: this block previously asserted that `script-src` did NOT carry
      // `'unsafe-inline'`, backed by a nonce-based middleware. That middleware
      // was REMOVED on 2026-09-25 after it was proven to break the production
      // build (prerendered HTML cannot carry a per-request nonce: 10 script
      // tags, 0 nonce attributes, suite red against `next start`). The
      // assertions are therefore reduced to what is currently TRUE, and the
      // `'unsafe-inline'` weakness stays open on CS-54 rather than being
      // asserted away.
      //
      // What is still worth enforcing is everything that is cheap to lose and
      // invisible when lost. Each is an equality check, not a substring search,
      // so a widened value fails rather than passing on a partial match — and
      // a missing header fails loudly rather than passing while unable to look.
      const documentResponse = await page.goto(origin);
      const csp = (await documentResponse?.headerValue('content-security-policy')) ?? '';
      const directives = new Map(
        csp
          .split(';')
          .map((directive) => directive.trim())
          .filter(Boolean)
          .map((directive) => [directive.split(/\s+/)[0]!, directive]),
      );
      assert.ok(
        directives.get('script-src'),
        `${engine} document response carries no script-src directive`,
      );
      for (const [name, expected] of [
        ['default-src', "default-src 'self'"],
        ['object-src', "object-src 'none'"],
        ['base-uri', "base-uri 'self'"],
        ['frame-ancestors', "frame-ancestors 'none'"],
        ['form-action', "form-action 'self'"],
      ] as const) {
        assert.equal(
          directives.get(name),
          expected,
          `${engine} ${name} is not "${expected}": ${directives.get(name) ?? 'absent'}`,
        );
      }
      const skipLink = page.getByRole('link', { name: 'Skip to content', exact: true });
      const hiddenSkip = await skipLink.boundingBox();
      assert.ok(hiddenSkip && hiddenSkip.width === 1 && hiddenSkip.height === 1);
      assert.equal(
        await skipLink.evaluate((element) => getComputedStyle(element).clipPath),
        'inset(50%)',
      );
      await skipLink.focus();
      const focusedSkip = await skipLink.boundingBox();
      assert.ok(
        focusedSkip && focusedSkip.y >= 0 && focusedSkip.width > 40 && focusedSkip.height > 40,
      );
      await skipLink.press('Enter');
      assert.equal(
        await page.locator('main').evaluate((element) => element === document.activeElement),
        true,
      );
      await accessible(page, engine, 'test account selector', 'Select test account');
      for (const width of responsiveWidthsEndingAt(320)) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        if (engine === 'chromium')
          await page.screenshot({
            path: fileURLToPath(new URL(`../test-results/account-${width}.png`, import.meta.url)),
            fullPage: true,
          });
      }
      await page.route(
        '**/api/login',
        (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
        { times: 1 },
      );
      await selectFixtureAccount(accountEmail);
      await page
        .getByRole('alert')
        .getByText('Service temporarily unavailable. Please try again shortly.', { exact: true })
        .waitFor();
      const initialNotificationsLoaded = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/notifications') &&
          response.request().method() === 'GET' &&
          response.status() === 200,
      );
      await selectFixtureAccount(accountEmail);
      await page.getByText('No searches yet.', { exact: true }).waitFor();
      assert.equal((await initialNotificationsLoaded).status(), 200);
      await settled('dashboard after login');
      assert.deepEqual(
        sharedRoutePrefetches,
        [],
        `${engine}: dashboard content and global navigation must not leave speculative RSC prefetches open`,
      );

      // The shared shell can receive refresh requests from focus, visibility,
      // polling, and panel-open events. Hold one real same-origin response
      // while delivering a burst of lifecycle events; only one API read may
      // be outstanding for this shell instance.
      let notificationRefreshRequests = 0;
      let releaseNotificationRefresh!: () => void;
      const notificationRefreshGate = new Promise<void>((resolve) => {
        releaseNotificationRefresh = resolve;
      });
      const holdNotificationRefresh = async (route: import('playwright').Route) => {
        notificationRefreshRequests += 1;
        if (notificationRefreshRequests === 1) {
          await notificationRefreshGate;
        }
        await route.fallback();
      };
      try {
        await page.route('**/api/notifications', holdNotificationRefresh);
        const notificationRefreshRequest = page.waitForRequest(
          (request) => request.url().endsWith('/api/notifications') && request.method() === 'GET',
        );
        const notificationRefreshResponse = page.waitForResponse(
          (response) =>
            response.url().endsWith('/api/notifications') &&
            response.request().method() === 'GET' &&
            response.status() === 200,
        );
        await page.evaluate(() => {
          for (let index = 0; index < 20; index += 1) {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('visibilitychange'));
          }
        });
        await notificationRefreshRequest;
        await page.evaluate(() => {
          for (let index = 0; index < 20; index += 1) {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('visibilitychange'));
          }
        });
        releaseNotificationRefresh();
        assert.equal((await notificationRefreshResponse).status(), 200);
        await settled('notification refresh coalescing');
      } finally {
        releaseNotificationRefresh();
        await page.unroute('**/api/notifications', holdNotificationRefresh);
      }
      assert.equal(
        notificationRefreshRequests,
        1,
        `${engine}: concurrent shell lifecycle signals issued duplicate notification reads`,
      );
      await page.goto(`${origin}/matching`);
      await page.getByRole('heading', { name: 'How job matching works', exact: true }).waitFor();
      const matchingDimensions = page.getByTestId('matching-dimension');
      assert.deepEqual(
        await matchingDimensions.evaluateAll((elements) =>
          elements.map((element) => {
            const label = element.querySelector('dt span')?.textContent?.trim();
            const weight = element.querySelector('dt strong')?.textContent?.trim();
            return `${label}:${weight}`;
          }),
        ),
        [
          'Skills:40%',
          'Role title:15%',
          'Seniority:12%',
          'Experience:10%',
          'Location:10%',
          'Compensation:8%',
          'Freshness:5%',
        ],
        `${engine} matching transparency does not reflect the canonical scoring dimensions`,
      );
      await page.getByText(/missing information stays unknown/i).waitFor();
      await page.getByText(/capped at 80%/i).waitFor();
      await page.getByText(/does not change these scores/i).waitFor();
      await accessible(page, engine, 'matching transparency', 'How job matching works');
      await page.getByRole('button', { name: 'Switch to dark theme' }).click();
      await page.locator('[data-theme="dark"]').waitFor();
      await accessible(page, engine, 'matching transparency dark theme', 'How job matching works');
      await page.getByRole('button', { name: 'Switch to light theme' }).click();
      await page.locator('[data-theme="light"]').waitFor();
      for (const width of requiredResponsiveWidths) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${engine} matching transparency overflows at ${width}px`,
        );
      }
      await page.goto(`${origin}/dashboard`);
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
      syntheticPermittedSources.clear();
      syntheticPermittedSources.add('greenhouse');
      const jobSources = await page.request.get(`${origin}/api/job-sources`);
      assert.equal(jobSources.status(), 200);
      assert.deepEqual(
        (await jobSources.json()).items.map(
          (source: { id: string; available: boolean; unavailableReason: string | null }) => [
            source.id,
            source.available,
            source.unavailableReason !== null,
          ],
        ),
        [
          ['greenhouse', true, false],
          ['lever', false, true],
          ['ashby', false, true],
          ['workable', false, true],
        ],
        `${engine} source catalog did not expose exact per-source permission state`,
      );
      const beforeDeniedSearch = Number(
        (await database.pool.query<{ count: string }>('SELECT count(*) FROM search_runs')).rows[0]!
          .count,
      );
      const session = await (await page.request.get(`${origin}/api/session`)).json();
      const deniedSearch = await page.request.post(`${origin}/api/searches`, {
        headers: {
          origin,
          'x-csrf-token': session.csrf,
          'idempotency-key': `policy-${randomUUID()}`,
        },
        data: { query: 'Synthetic policy rejection', sources: ['lever'] },
      });
      assert.equal(deniedSearch.status(), 503);
      const afterDeniedSearch = Number(
        (await database.pool.query<{ count: string }>('SELECT count(*) FROM search_runs')).rows[0]!
          .count,
      );
      assert.equal(afterDeniedSearch, beforeDeniedSearch, 'denied source created a search record');
      await page.getByRole('link', { name: 'Jobs', exact: true }).click();
      await page.getByRole('heading', { name: 'Find Your Next Role' }).waitFor();
      const unavailableLever = page.getByRole('checkbox', { name: 'Lever', exact: true });
      await unavailableLever.waitFor();
      assert.equal(await unavailableLever.isDisabled(), true);
      const leverReasonId = await unavailableLever.getAttribute('aria-describedby');
      assert.ok(leverReasonId, `${engine} unavailable Lever source lacks an accessible reason`);
      assert.equal(
        await page.locator(`#${leverReasonId}`).textContent(),
        JOB_SOURCE_PERMISSION_PENDING_MESSAGE,
        `${engine} unavailable Lever source does not render its exact permission reason`,
      );
      syntheticPermittedSources.add('lever');
      syntheticPermittedSources.add('ashby');
      syntheticPermittedSources.add('workable');
      await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('navigation', { name: 'CareerScope', exact: true }).waitFor();
      // WCAG 1.4.10 reflow: 320px at 200% zoom must not force horizontal scrolling.
      await page.setViewportSize({ width: 320, height: 512 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '32px';
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        `${engine} reflow at 200% zoom causes horizontal scrolling`,
      );
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '';
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      // The shared authenticated navigation (dashboard-shell.tsx), exercised
      // against what CareerScope actually renders today: real Next.js routes
      // behind <Link>s in a single sidebar, not the pre-CS-6 in-page view
      // switcher this block used to assert against (its
      // `nav[aria-label="Career workspace"]` selector matched nothing after
      // the routing migration, so it silently collected an empty array and
      // every assertion below it stopped running — test-health remediation,
      // 2026-09-24). This one block now covers presence, destination
      // correctness, keyboard reachability, active-route marking and the
      // mobile nav, and is a strict superset of the /dashboard Tab check
      // that used to live further down this file.
      const sidebarNav = page.locator('nav[aria-label="CareerScope"]');
      const mobileNav = page.locator('nav[aria-label="CareerScope, compact"]');
      // (a) the navigation exists at all, and is exposed as a landmark with
      // an accessible name — not merely as some <div> that looks like a nav.
      assert.equal(
        await page.getByRole('navigation', { name: 'CareerScope', exact: true }).count(),
        1,
        `${engine} authenticated shell has no accessible "CareerScope" navigation landmark`,
      );
      // (b) each label leads to the route it names. A label pointing at the
      // wrong screen is not caught by any reachability check.
      const expectedDestinations = [
        { label: 'Dashboard', href: '/dashboard' },
        { label: 'Jobs', href: '/jobs' },
        { label: 'Applications', href: '/applications' },
        { label: 'Saved', href: '/saved' },
        { label: 'Resume', href: '/resume' },
        { label: 'Career Resources', href: '/career-resources' },
        { label: 'Settings', href: '/settings' },
        { label: 'Preparation', href: '/preparation' },
      ];
      const readDestinations = (nav: import('playwright').Locator) =>
        nav.locator('a').evaluateAll((elements) =>
          elements.map((element) => ({
            label: element.textContent?.trim() ?? '',
            href: element.getAttribute('href') ?? '',
          })),
        );
      assert.deepEqual(
        await readDestinations(sidebarNav),
        expectedDestinations,
        `${engine} sidebar navigation destinations do not match the real routes`,
      );
      // The three design-only items have no destination yet: they must stay
      // inert <span>s, never links that go nowhere.
      assert.deepEqual(
        await sidebarNav
          .locator('[aria-disabled="true"]')
          .evaluateAll((elements) =>
            elements.map(
              (element) =>
                `${element.tagName.toLowerCase()} ${element.textContent?.trim().replace(/Soon$/, '') ?? ''}`,
            ),
          ),
        ['span Skills', 'span Insights', 'span AI Assistant'],
        `${engine} sidebar "not yet available" items are not rendered as inert spans`,
      );
      // (c) keyboard reachability. First, engine-independently: every
      // enabled item must be able to take DOM focus, in navItems order, and
      // the three "Soon" items must never be able to — a disabled-looking
      // control that still takes focus is a real, silent accessibility
      // defect. An empty or renamed nav yields [] here and fails loudly
      // rather than quietly reporting nothing, which is exactly how the
      // pre-CS-6 version of this check rotted unnoticed.
      const focusOrder = await sidebarNav
        .locator('a, [aria-disabled="true"]')
        .evaluateAll((elements) =>
          elements.map((element) => {
            (element as HTMLElement).focus();
            return {
              label: element.textContent?.trim().replace(/Soon$/, '') ?? '',
              focusable: document.activeElement === element,
            };
          }),
        );
      assert.deepEqual(
        focusOrder.filter((item) => item.focusable).map((item) => item.label),
        expectedDestinations.map((destination) => destination.label),
        `${engine} sidebar focusable items do not match the real destinations, in order`,
      );
      assert.deepEqual(
        focusOrder.filter((item) => !item.focusable).map((item) => item.label),
        ['Skills', 'Insights', 'AI Assistant'],
        `${engine} sidebar items with no destination must not be focusable`,
      );
      // Then the real Tab sequence. The skip link is the first focusable node
      // in the shell, so focusing it makes the walk deterministic; the loop
      // records every focusable descendant of the nav in DOM order and stops
      // once focus has passed out the far side. The walk itself runs on every
      // engine — only the expectation differs. Safari/WebKit deliberately
      // leaves links out of the Tab sequence unless the user opts in ("Press
      // Tab to highlight each item"), a platform convention rather than an
      // application defect, so on WebKit the walk must come back empty. That
      // emptiness is asserted, not assumed: if a future Playwright WebKit
      // build (or an opt-in default) starts tabbing to links, this fails and
      // the carve-out is removed rather than silently outliving its reason.
      // The DOM-focus assertions above are what cover WebKit for the three
      // inert <span>s (a <span> with no tabindex is neither focusable nor
      // tabbable); they do NOT substitute for Tab reachability of the eight
      // links, since an anchor with tabindex="-1" would still pass them.
      // CS-31 (Independent Reviewer finding CS31-1, 2026-09-25): the skip-link
      // contract asserted near the top of this suite runs on `/` — the
      // SIGN-IN page, whose skip link targets `#workspace-content`. It never
      // touched the one CS-31 actually added: `AuthenticatedShell`'s link to
      // `#main-content`. The reviewer's demonstration of the gap was exact —
      // removing `tabIndex={-1}` from the shell's `#main-content` would have
      // left the entire suite green. A check pointed at the wrong element is
      // the same defect class as this suite's own `Career workspace` rot, so
      // the authenticated shell now gets the identical three-part contract:
      // visually hidden when unfocused, visible and substantial when focused,
      // and Enter moves real focus to the main landmark.
      // CS-31 AC3 requires this contract "at the affected viewport AND a narrow
      // mobile viewport" (re-review finding F-1, 2026-09-25). It previously ran
      // only at 1440 — and 320 is precisely where it is most likely to break,
      // because `.skipLink` is hidden-until-focused by positioning and the
      // focused-state assertion below is a size assertion, the property a
      // narrow media query is most likely to change. The nearby [320, 390,
      // 1440] loops assert overflow and axe, not this contract.
      //
      // F-2: select by accessible name, not by href alone. An empty
      // `<a href="#main-content"></a>` would satisfy every part of this
      // contract while being a real WCAG 2.4.4 / 4.1.2 defect; axe's link-name
      // rule on the same page mitigates that but does not eliminate it.
      for (const width of responsiveWidthsEndingAt(320)) {
        await page.setViewportSize({ width, height: 900 });
        const shellSkip = page.getByRole('link', { name: 'Skip to content', exact: true });
        const shellHidden = await shellSkip.boundingBox();
        assert.ok(
          shellHidden && shellHidden.width === 1 && shellHidden.height === 1,
          `${engine} authenticated shell skip link is not visually hidden when unfocused at ${width}px`,
        );
        await shellSkip.focus();
        const shellFocused = await shellSkip.boundingBox();
        assert.ok(
          shellFocused &&
            shellFocused.y >= 0 &&
            shellFocused.width > 40 &&
            shellFocused.height > 40,
          `${engine} authenticated shell skip link does not become visible on focus at ${width}px`,
        );
        await shellSkip.press('Enter');
        assert.equal(
          await page
            .locator('#main-content')
            .evaluate((element) => element === document.activeElement),
          true,
          `${engine} authenticated shell skip link did not move focus to #main-content at ${width}px (a missing tabindex="-1" would do exactly this)`,
        );
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('a[href="#main-content"]').focus();
      const reachable: string[] = [];
      let enteredNav = false;
      for (let step = 0; step < 40; step += 1) {
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => {
          const element = document.activeElement;
          if (!element || !element.closest('nav[aria-label="CareerScope"]')) return null;
          return element.textContent?.trim() ?? '';
        });
        if (focused === null) {
          if (enteredNav) break;
          continue;
        }
        enteredNav = true;
        if (!reachable.includes(focused)) reachable.push(focused);
      }
      assert.deepEqual(
        reachable,
        expectedDestinations.map((destination) => destination.label),
        `${engine} sidebar navigation is not fully keyboard reachable in order (and items with no destination must be skipped, not merely styled as skipped)`,
      );
      // (d) active-route marking, checked on more than one route so a
      // hardcoded fallback cannot pass. Navigation happens through the real
      // shared nav, so this also proves the links work.
      const currentLabels = async (nav: import('playwright').Locator) =>
        nav
          .locator('[aria-current="page"]')
          .evaluateAll((elements) => elements.map((element) => element.textContent?.trim() ?? ''));
      assert.deepEqual(
        await currentLabels(sidebarNav),
        ['Dashboard'],
        `${engine} /dashboard does not mark exactly one current navigation item`,
      );
      await sidebarNav.getByRole('link', { name: 'Preparation', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Save a profile to prepare' }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/preparation');
      assert.deepEqual(
        await currentLabels(sidebarNav),
        ['Preparation'],
        `${engine} /preparation does not mark exactly one current navigation item`,
      );
      // (e) below the 768px breakpoint (dashboard-shell.module.css) the
      // sidebar is hidden and the compact strip is the operable navigation —
      // with the same destinations, never fewer capabilities on the narrower
      // viewport.
      await page.setViewportSize({ width: 769, height: 900 });
      assert.equal(
        await sidebarNav.isVisible(),
        true,
        `${engine} sidebar is not visible at 769px, above the documented 768px breakpoint`,
      );
      const sidebarBox = await sidebarNav.boundingBox();
      assert.ok(
        sidebarBox && sidebarBox.width > 0 && sidebarBox.height > 0,
        `${engine} sidebar occupies no space at 769px, so it is not the operable navigation there`,
      );
      assert.equal(
        await mobileNav.evaluate((element) => getComputedStyle(element).display),
        'none',
        `${engine} compact navigation is shown at 769px, above the documented 768px breakpoint`,
      );
      await page.setViewportSize({ width: 768, height: 900 });
      assert.equal(
        await sidebarNav.evaluate((element) => getComputedStyle(element).display),
        'none',
        `${engine} sidebar is still displayed at the 768px breakpoint`,
      );
      assert.equal(
        await mobileNav.evaluate((element) => getComputedStyle(element).display),
        'flex',
        `${engine} compact navigation is not displayed at the 768px breakpoint`,
      );
      assert.equal(
        await page.getByRole('navigation', { name: 'CareerScope, compact', exact: true }).count(),
        1,
        `${engine} compact navigation is not an accessible navigation landmark`,
      );
      assert.deepEqual(
        await readDestinations(mobileNav),
        expectedDestinations,
        `${engine} compact navigation offers different destinations than the sidebar`,
      );
      assert.deepEqual(
        await currentLabels(mobileNav),
        ['Preparation'],
        `${engine} compact navigation does not mark exactly one current item`,
      );
      await mobileNav.getByRole('link', { name: 'Dashboard', exact: true }).click();
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/dashboard');
      assert.deepEqual(
        await currentLabels(mobileNav),
        ['Dashboard'],
        `${engine} compact navigation does not follow the active route`,
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await accessible(page, engine, 'dashboard', /^Good (morning|afternoon|evening)!$/);
      for (const width of responsiveWidthsEndingAt(1440)) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
        await page.screenshot({
          path: fileURLToPath(
            new URL(`../test-results/dashboard-${engine}-${width}.png`, import.meta.url),
          ),
          fullPage: true,
        });
      }
      // CS-49: the real `/dashboard` route (distinct from the `view==='dashboard'`
      // state pane exercised just above) — restyled shell matching the owner's
      // supplied design image, real data only, no invented metrics (see
      // docs/FRONTEND-ADMIN-ROADMAP.md, "Planning snapshot: 2026-09-23").
      await page.setViewportSize({ width: 1440, height: 900 });
      // Every full-document navigation in this run waits for the current route
      // to stop fetching first — see `settled` above.
      await settled('workspace');
      await page.goto(`${origin}/dashboard`);
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
      await page.getByText('Run a search to see recommended jobs.', { exact: true }).waitFor();
      assert.equal(await page.getByText('Saved jobs', { exact: true }).count(), 1);
      assert.equal(await page.getByText('Applied', { exact: true }).count(), 1);
      assert.equal(await page.getByText('Not available yet', { exact: true }).count(), 1);
      await accessible(page, engine, 'dashboard route', /^Good (morning|afternoon|evening)!$/);
      for (const width of responsiveWidthsEndingAt(1440)) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
          `${engine} /dashboard at ${width}px causes horizontal scrolling`,
        );
        await page.screenshot({
          path: fileURLToPath(
            new URL(`../test-results/dashboard-route-${engine}-${width}.png`, import.meta.url),
          ),
          fullPage: true,
        });
      }
      // CS-15: /jobs, /saved, /applications, /resume and /settings were real,
      // reachable routes (CS-6/CS-50) with no automated accessibility check
      // anywhere in this suite before this - an unmeasured route is
      // indistinguishable from an inaccessible one. One axe pass per route,
      // reusing the already-authenticated `page` rather than opening a new
      // session per route.
      for (const [route, routeHeading] of [
        ['/jobs', 'Find Your Next Role'],
        ['/saved', 'Saved Leads'],
        ['/applications', 'Applications'],
        ['/resume', 'Candidate Profile'],
        ['/settings', 'Account security'],
      ] as const) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await settled(`route ${route}`);
        await page.goto(`${origin}${route}`);
        await page.waitForLoadState('networkidle');
        await accessible(page, engine, route.slice(1), routeHeading);
        if (route === '/applications') {
          const exportLink = page.getByRole('link', { name: 'Export applications CSV' });
          await exportLink.waitFor({ state: 'visible' });
          assert.equal(await exportLink.getAttribute('href'), '/api/applications/export');
          for (const width of requiredResponsiveWidths) {
            await page.setViewportSize({ width, height: 900 });
            const layout = await page.evaluate(() => ({
              viewportWidth: window.innerWidth,
              documentWidth: document.documentElement.scrollWidth,
              shell: (() => {
                const element = document.querySelector('[data-theme]');
                if (!element) return null;
                const rect = element.getBoundingClientRect();
                return { width: Math.round(rect.width), right: Math.round(rect.right) };
              })(),
              mobileNav: (() => {
                const element = document.querySelector('nav[aria-label="CareerScope, compact"]');
                if (!element) return null;
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return {
                  width: Math.round(rect.width),
                  right: Math.round(rect.right),
                  clientWidth: element.clientWidth,
                  scrollWidth: element.scrollWidth,
                  minWidth: style.minWidth,
                  overflowX: style.overflowX,
                };
              })(),
              overflowingElements: Array.from(document.querySelectorAll('body *'))
                .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
                .slice(0, 5)
                .map((element) => ({
                  tag: element.tagName.toLowerCase(),
                  className: typeof element.className === 'string' ? element.className : '',
                  right: Math.round(element.getBoundingClientRect().right),
                })),
              nonNavigationOverflowingElements: Array.from(document.querySelectorAll('body *'))
                .filter(
                  (element) =>
                    !element.closest('nav[aria-label="CareerScope, compact"]') &&
                    element.getBoundingClientRect().right > window.innerWidth + 1,
                )
                .slice(0, 8)
                .map((element) => ({
                  tag: element.tagName.toLowerCase(),
                  className: typeof element.className === 'string' ? element.className : '',
                  right: Math.round(element.getBoundingClientRect().right),
                })),
            }));
            assert.ok(
              layout.documentWidth <= layout.viewportWidth,
              `${engine} applications/export surface overflows at ${width}px: ${JSON.stringify(layout)}`,
            );
          }
          await page.setViewportSize({ width: 1440, height: 900 });
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await settled('route /settings');
      await page.goto(`${origin}/settings`);
      const languageSelect = page.locator('#interface-language');
      // `page.goto` can finish before the authenticated client shell has
      // resolved its session and mounted route content, especially in WebKit.
      // Wait for the actual settings control rather than asserting against a
      // transient loading frame; the exact-one assertion remains strict.
      await languageSelect.waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(
        await languageSelect.count(),
        1,
        `${engine} expected one interface-language control on /settings; observed ${new URL(page.url()).pathname}`,
      );
      assert.equal(
        await page.locator('label[for="interface-language"]').textContent(),
        'Choose interface language',
      );
      await languageSelect.selectOption('te');
      await page.waitForFunction(
        () =>
          document.querySelector('a[href="/jobs"][lang="te"]') !== null &&
          document.documentElement.lang === 'en',
      );
      await sidebarNav.getByRole('link', { name: 'ఉద్యోగాలు', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'ఖాతా భద్రత', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'క్రియాశీల సెషన్‌లు', exact: true }).waitFor();
      assert.equal(
        await page.locator('section[aria-labelledby="security-heading"]').getAttribute('lang'),
        'te',
      );
      await page.route(
        '**/api/account/sessions/revoke-others',
        (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Synthetic private service detail' }),
          }),
        { times: 1 },
      );
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'ఇతర సెషన్‌ల నుంచి సైన్ అవుట్ చేయండి' }).click();
      await page
        .getByRole('alert')
        .filter({
          hasText: 'సేవ తాత్కాలికంగా అందుబాటులో లేదు. కొద్దిసేపటి తర్వాత మళ్లీ ప్రయత్నించండి.',
        })
        .waitFor();
      assert.equal(
        await page.getByText('Synthetic private service detail', { exact: true }).count(),
        0,
      );
      await page.getByRole('heading', { name: 'ఇంటర్‌ఫేస్ భాష', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'నోటిఫికేషన్ ప్రాధాన్యతలు', exact: true }).waitFor();
      const teluguReminderPreference = page.getByRole('checkbox', {
        name: 'CareerScope‌లో రాబోయే ఇంటర్వ్యూ రిమైండర్‌లను చూపించండి',
      });
      await teluguReminderPreference.waitFor();
      assert.equal(await teluguReminderPreference.isChecked(), true);
      assert.equal(
        await page
          .locator('section[aria-labelledby="notification-preferences-heading"]')
          .getAttribute('lang'),
        'te',
      );
      await page
        .getByText(
          'ఇది కొత్త రిమైండర్‌లకే వర్తిస్తుంది. ఇప్పటికే ఉన్న రిమైండర్‌లు మీ నోటిఫికేషన్‌ల జాబితాలో ఉంటాయి. ఇక్కడి సెట్టింగ్ ఇమెయిల్ లేదా పుష్ రిమైండర్‌లను నియంత్రించదు.',
          { exact: true },
        )
        .waitFor();
      assert.equal(
        await page
          .locator('section[aria-labelledby="interface-language-heading"]')
          .getAttribute('lang'),
        'te',
      );
      await page
        .locator('details')
        .filter({ has: page.locator('summary[title="నోటిఫికేషన్‌లు"]') })
        .locator('summary')
        .click();
      assert.equal(
        await page.locator('section[aria-label="నోటిఫికేషన్‌లు"]').getAttribute('lang'),
        'te',
      );
      await page
        .getByText('ఇంటర్వ్యూ రిమైండర్‌లు ఇక్కడ కనిపిస్తాయి. అలర్ట్‌లో ఇంటర్వ్యూ వివరాలు ఉండవు.', {
          exact: true,
        })
        .waitFor();
      await sidebarNav.getByRole('link', { name: 'ఉద్యోగాలు', exact: true }).click();
      await page.waitForURL('**/jobs');
      await page
        .getByRole('heading', { name: 'మీ తదుపరి పాత్రను కనుగొనండి', exact: true })
        .waitFor();
      assert.equal(await page.locator('aside.history').getAttribute('lang'), 'te');
      assert.equal(await page.locator('.source-options').getAttribute('lang'), 'te');
      await page.getByPlaceholder('ఉద్యోగ పాత్ర లేదా సాంకేతికత').waitFor();
      await accessible(page, engine, 'Telugu job-search controls', 'మీ తదుపరి పాత్రను కనుగొనండి');
      await page.goto(`${origin}/settings`);
      await languageSelect.waitFor({ state: 'visible' });
      await page.reload();
      await page.waitForFunction(
        () =>
          document.querySelector('a[href="/jobs"][lang="te"]') !== null &&
          document.documentElement.lang === 'en',
      );
      await sidebarNav.getByRole('link', { name: 'ఉద్యోగాలు', exact: true }).waitFor();
      await page.setViewportSize({ width: 320, height: 900 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `${engine} Telugu workspace shell causes horizontal page overflow at 320px`,
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Object.defineProperty(window, '__careerscopeOriginalStorageSetItem', {
          value: original,
          configurable: true,
        });
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key === 'careerscope:interface-language') {
            throw new DOMException('Storage unavailable in test', 'QuotaExceededError');
          }
          return original.call(this, key, value);
        };
      });
      await languageSelect.selectOption('hi');
      await page.waitForFunction(
        () =>
          document.querySelector('a[href="/jobs"][lang="hi"]') !== null &&
          document.documentElement.lang === 'en',
      );
      await sidebarNav.getByRole('link', { name: 'नौकरियाँ', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'खाता सुरक्षा', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'सक्रिय सत्र', exact: true }).waitFor();
      assert.equal(
        await page.locator('section[aria-labelledby="security-heading"]').getAttribute('lang'),
        'hi',
      );
      await page.route(
        '**/api/account/sessions/revoke-others',
        (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Synthetic private service detail' }),
          }),
        { times: 1 },
      );
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'अन्य सत्रों से साइन आउट करें' }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: 'सेवा अस्थायी रूप से उपलब्ध नहीं है। थोड़ी देर बाद फिर कोशिश करें।' })
        .waitFor();
      assert.equal(
        await page.getByText('Synthetic private service detail', { exact: true }).count(),
        0,
      );
      await page.getByRole('heading', { name: 'सूचना प्राथमिकताएँ', exact: true }).waitFor();
      const hindiReminderPreference = page.getByRole('checkbox', {
        name: 'CareerScope में आने वाले इंटरव्यू रिमाइंडर दिखाएँ',
      });
      await hindiReminderPreference.waitFor();
      assert.equal(await hindiReminderPreference.isChecked(), true);
      assert.equal(
        await page
          .locator('section[aria-labelledby="notification-preferences-heading"]')
          .getAttribute('lang'),
        'hi',
      );
      await page
        .getByText(
          'ब्राउज़र संग्रहण उपलब्ध नहीं है। यह प्राथमिकता इस पृष्ठ को रीफ़्रेश या बंद करने तक सक्रिय रहेगी।',
          { exact: true },
        )
        .waitFor();
      await page.evaluate(() => {
        const target = window as Window & {
          __careerscopeOriginalStorageSetItem?: typeof Storage.prototype.setItem;
        };
        if (target.__careerscopeOriginalStorageSetItem) {
          Storage.prototype.setItem = target.__careerscopeOriginalStorageSetItem;
          delete target.__careerscopeOriginalStorageSetItem;
        }
      });
      await sidebarNav.getByRole('link', { name: 'नौकरियाँ', exact: true }).click();
      await page.waitForURL('**/jobs');
      await page.getByRole('heading', { name: 'अपनी अगली भूमिका खोजें', exact: true }).waitFor();
      assert.equal(await page.locator('aside.history').getAttribute('lang'), 'hi');
      assert.equal(await page.locator('.source-options').getAttribute('lang'), 'hi');
      await page.getByPlaceholder('भूमिका या तकनीक').waitFor();
      await accessible(page, engine, 'Hindi job-search controls', 'अपनी अगली भूमिका खोजें');
      await sidebarNav.getByRole('link', { name: 'सेटिंग्स', exact: true }).click();
      await page.waitForURL('**/settings');
      await languageSelect.waitFor({ state: 'visible' });
      await languageSelect.selectOption('en');
      await page.waitForFunction(
        () => document.querySelector('a[href="/jobs"][lang="en"]') !== null,
      );
      await sidebarNav.getByRole('link', { name: 'Jobs', exact: true }).waitFor();
      await page.goto(`${origin}/dashboard`);
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
      // The CS-15 Tab check that used to sit here (it asserted the first six
      // focusable sidebar items on /dashboard) is now folded into the single
      // navigation block earlier in this run: that block walks the *whole*
      // sidebar — all eight enabled items in DOM order, not just the first
      // six — and additionally asserts each destination's href, the
      // aria-current marking on two different routes, and the compact
      // navigation below 768px. Strictly more coverage, asserted once.
      await sidebarNav.getByRole('link', { name: 'Career Resources', exact: true }).click();
      await page.getByRole('heading', { name: 'Career Links', exact: true }).waitFor();

      // CS-39 AC3: "keep resource provenance and static/curated scope explicit"
      // and "preserve safe external-link behavior". Both are asserted here
      // because both are silently losable — the provenance line is one deletion
      // away, and rel="noopener noreferrer" is the kind of attribute an
      // unrelated refactor drops without anyone noticing. A tab opened with
      // target="_blank" and no rel can reach back through window.opener.
      await page
        .getByText('A fixed, hand-picked list that ships with CareerScope.', { exact: false })
        .waitFor();
      const externalLinks = await page.locator('.resource-list a').evaluateAll((elements) =>
        elements.map((element) => ({
          href: element.getAttribute('href') ?? '',
          rel: element.getAttribute('rel') ?? '',
          target: element.getAttribute('target') ?? '',
        })),
      );
      assert.ok(
        externalLinks.length > 0,
        `${engine} Career Links renders no resources at all, so its link safety is untested`,
      );
      for (const link of externalLinks) {
        assert.ok(
          link.href.startsWith('https://'),
          `${engine} career resource is not https: ${link.href}`,
        );
        assert.equal(
          link.target,
          '_blank',
          `${engine} career resource does not open in a new tab: ${link.href}`,
        );
        assert.ok(
          link.rel.includes('noopener') && link.rel.includes('noreferrer'),
          `${engine} career resource lacks noopener/noreferrer: ${link.href} rel="${link.rel}"`,
        );
      }

      await page.getByLabel('Find resources', { exact: true }).fill('MDN');
      assert.equal(await page.locator('.resource-list a').count(), 1);
      assert.equal(
        await page.getByRole('link', { name: 'MDN Web Docs' }).getAttribute('href'),
        'https://developer.mozilla.org/',
      );
      await page.getByLabel('Find resources', { exact: true }).fill('no-such-resource');
      // CS-13 AC3: the message must distinguish "nothing matches your filter"
      // from "nothing yet". This list is a fixed constant and can only be
      // emptied by the search box, so the message names the term and the way
      // back — the previous "No resources found." said neither.
      await page
        .getByRole('status')
        .filter({
          hasText:
            'No resources match “no-such-resource”. Clear the search box above to see all 8 resources.',
        })
        .waitFor();
      await page.getByLabel('Find resources', { exact: true }).fill('');
      await accessible(page, engine, 'career links', 'Career Links');
      for (const width of responsiveWidthsEndingAt(1440)) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
        await page.screenshot({
          path: fileURLToPath(
            new URL(`../test-results/resources-${engine}-${width}.png`, import.meta.url),
          ),
          fullPage: true,
        });
      }
      await sidebarNav.getByRole('link', { name: 'Jobs', exact: true }).click();
      await page.waitForURL(`${origin}/jobs`);
      // `exact: true` matters here specifically: Playwright matches an
      // accessible name by SUBSTRING by default, so a rename to
      // "Search history renamed" would still satisfy this locator and the
      // emptiness assertion below would keep passing against a nav that is no
      // longer the one it names (demonstrated during the CS-15 remediation).
      // This is the landmark whose existence the next line proves, so it is the
      // one that must be pinned.
      const history = page.getByRole('navigation', { name: 'Search history', exact: true });
      assert.equal(await history.count(), 1, `${engine} /jobs has no Search history navigation`);
      await page.getByText('No searches yet.', { exact: true }).waitFor();
      assert.equal(await history.getByRole('button').count(), 0);
      // The resume/profile workspace is its own route behind the shared nav
      // now (CS-6) — the old "Candidate profile" view-switch button inside
      // the search view no longer exists.
      await sidebarNav.getByRole('link', { name: 'Resume', exact: true }).click();
      await page.getByRole('heading', { name: 'Candidate Profile', exact: true }).waitFor();
      const archive = new JSZip();
      archive.file(
        '[Content_Types].xml',
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      );
      archive.file(
        'word/document.xml',
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Candidate, React and TypeScript developer with experience building accessible web applications.</w:t></w:r></w:p></w:body></w:document>',
      );
      await page.getByLabel('Resume file (PDF or DOCX, up to 5 MiB)').setInputFiles({
        name: 'synthetic.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: await archive.generateAsync({ type: 'nodebuffer' }),
      });
      const capacityRoute = async (route: import('playwright').Route) => {
        // Only the upload POST is being simulated here. Anything else that
        // happens to hit this URL while the handler is installed (the resume
        // list refetch) is handed back to the default handling rather than
        // continued through the interceptor: WebKit reports a continued
        // same-origin request as "Fetch API cannot load ... due to access
        // control checks", a route-interception artefact that would
        // otherwise surface as a fake page error.
        if (route.request().method() !== 'POST') return route.fallback();
        await route.fulfill({
          status: 507,
          contentType: 'application/json',
          // WebKit rejects an intercepted response that carries no
          // Access-Control-Allow-Origin even for a same-origin request, and
          // reports it as a page error ("due to access control checks").
          // That is a route-interception artefact, not app behaviour, so the
          // synthetic response states the page's own origin rather than the
          // page-error assertion being loosened to ignore it.
          headers: { 'access-control-allow-origin': origin },
          body: JSON.stringify({ error: 'Synthetic internal storage details' }),
        });
      };
      await page.route('**/api/resumes', capacityRoute);
      await page.getByRole('button', { name: 'Upload resume', exact: true }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: 'Resume storage capacity reached.' })
        .waitFor();
      assert.equal(
        await page.getByText('Synthetic internal storage details', { exact: true }).count(),
        0,
      );
      await page
        .locator('button:enabled')
        .filter({ hasText: /^Upload resume$/ })
        .waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Upload resume', exact: true }).isEnabled(),
        true,
      );
      await page.unroute('**/api/resumes', capacityRoute);
      const uploaded = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/resumes') && response.request().method() === 'POST',
      );
      await database.pool
        .query(`CREATE OR REPLACE FUNCTION reject_browser_upload() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic upload publication failure'; END $$`);
      await database.pool.query(`CREATE TRIGGER reject_browser_upload BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION reject_browser_upload()`);
      await page.getByRole('button', { name: 'Upload resume', exact: true }).click();
      assert.equal((await uploaded).status(), 500);
      await database.pool.query('DROP TRIGGER reject_browser_upload ON outbox_events');
      await page.getByRole('button', { name: 'Recover upload', exact: true }).waitFor();
      const recoveredUpload = page.waitForResponse(
        (response) => response.url().endsWith('/recover') && response.request().method() === 'POST',
      );
      const recoveryGate = Promise.withResolvers<void>();
      await page.route(
        '**/api/resumes/*/recover',
        async (route) => {
          await recoveryGate.promise;
          await route.continue();
        },
        { times: 1 },
      );
      await page.getByRole('button', { name: 'Recover upload', exact: true }).click();
      try {
        await page.getByRole('status').filter({ hasText: 'Recovering upload...' }).waitFor();
        assert.equal(
          await page.getByRole('button', { name: 'Recover upload', exact: true }).isDisabled(),
          true,
        );
      } finally {
        recoveryGate.resolve();
      }
      assert.equal((await recoveredUpload).status(), 200);
      await publishPending(database, { 'resume.parse': filesQueue });
      await page
        .getByRole('status')
        .filter({ hasText: 'Resume ready for review.' })
        .waitFor({ timeout: 45000 });
      for (const width of responsiveWidthsEndingAt(320)) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        if (engine === 'chromium')
          await page.screenshot({
            path: fileURLToPath(new URL(`../test-results/resume-${width}.png`, import.meta.url)),
            fullPage: true,
          });
      }
      await page.getByRole('button', { name: 'Review profile draft', exact: true }).click();
      assert.match(await page.locator('textarea[name="techStack"]').inputValue(), /React/);
      const account = await database.pool.query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1',
        [accountEmail],
      );
      assert.equal(await new ProfileRepository(database).get(account.rows[0]!.id), null);
      await page.getByLabel('Full Name', { exact: true }).fill('Synthetic Candidate');
      await page.getByLabel('Email', { exact: true }).fill(accountEmail);
      await page.getByLabel('Location', { exact: true }).fill('Hyderabad');
      await page
        .getByRole('combobox', { name: 'Career stage', exact: true })
        .selectOption('experienced');
      await page.locator('textarea[name="titles"]').fill('React Engineer');
      await page.getByRole('button', { name: 'Save Profile', exact: true }).click();
      await page.getByText('Profile saved.', { exact: true }).waitFor();
      const reviewed = await new ProfileRepository(database).get(account.rows[0]!.id);
      // `get` returns null when no profile exists. Three later assertions read
      // `reviewed.revision`; without this the suite would die with a TypeError
      // in the middle of a browser run and look like a UI failure rather than
      // a missing fixture.
      assert.ok(
        reviewed,
        'the reviewed profile must exist before the preparation screen is driven',
      );
      assert.ok(reviewed?.profile.preferences.techStack.includes('React'));
      assert.equal(reviewed?.profile.candidate.segment, 'experienced');
      // The sidebar is hidden below 768px and the screenshot loop above left
      // the viewport at 320px, so widen before navigating through it.
      await page.setViewportSize({ width: 1440, height: 900 });
      await sidebarNav.getByRole('link', { name: 'Preparation', exact: true }).click();
      await page.getByRole('heading', { name: 'Interview Practice', exact: true }).waitFor();
      await accessible(page, engine, 'preparation', 'Resume & Interview Prep');
      await page
        .getByText(`Rules-based review | Saved profile revision ${reviewed.revision}`, {
          exact: true,
        })
        .waitFor();
      // Removed provider functionality must not leave an actionable coaching control.
      assert.equal(
        await page.getByRole('button', { name: 'Get AI coaching' }).count(),
        0,
        `${engine} the AI coaching trigger renders while the server reports no AI provider`,
      );
      assert.ok((await page.locator('.preparation-evidence').count()) > 0);
      for (const width of responsiveWidthsEndingAt(1440)) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
        await page.screenshot({
          path: fileURLToPath(
            new URL(`../test-results/preparation-${engine}-${width}.png`, import.meta.url),
          ),
          fullPage: true,
        });
      }
      await page.route(
        '**/api/preparation',
        (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
        { times: 1 },
      );
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      // CS-13 F-1: this was a `hasText: 'Request failed.'` substring match,
      // and the old bare text is a SUBSTRING of the new prefixed text — so it
      // passed before the CS-13 rollout, passed after it, and would keep
      // passing if this screen regressed to a bare `{error.message}`. It was
      // never stale in the sense of failing, which is exactly why it was not
      // caught alongside the two that went red. Asserting the full string
      // makes the "what failed" prefix and the recovery instruction both
      // load-bearing.
      await page
        .getByRole('alert')
        .getByText(
          'Could not prepare your review. Service temporarily unavailable. Please try again shortly. Use Refresh above to try again.',
          { exact: true },
        )
        .waitFor();
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByRole('heading', { name: 'Interview Practice', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
      await page.getByRole('button', { name: 'Delete resume', exact: true }).waitFor();
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Delete resume', exact: true }).click();
      await page.getByText('No resumes uploaded.', { exact: true }).waitFor();
      // "Back to Search" returns to the workspace home (/dashboard) now that
      // search is its own route; the search form itself is reached through
      // the shared navigation.
      await page.getByRole('button', { name: 'Back to Search', exact: true }).click();
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
      await sidebarNav.getByRole('link', { name: 'Jobs', exact: true }).click();
      await page.waitForURL(`${origin}/jobs`);
      await page.getByLabel('Role or technology').fill('React Engineer');
      const matchedSearch = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/searches') && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const matchedRun = (await (await matchedSearch).json()).runId;
      const captured = await database.getSearch(account.rows[0]!.id, matchedRun);
      assert.equal(captured?.profileRevision, reviewed.revision);
      assert.ok(captured?.matchingProfile?.preferences.techStack.includes('React'));
      await database.cancelSearch(account.rows[0]!.id, matchedRun);
      await page
        .getByRole('status')
        .filter({ hasText: /^cancelled$/ })
        .waitFor();
      const securityAuth = new Auth(database);
      const secondSession = await securityAuth.login(accountEmail, password);
      assert.ok(secondSession);
      const deviceSession = await securityAuth.loginSession(
        accountEmail,
        password,
        undefined,
        'Test device',
      );
      assert.ok(deviceSession);
      // Account security is the /settings route behind the shared nav now.
      await sidebarNav.getByRole('link', { name: 'Settings', exact: true }).click();
      await page.getByRole('heading', { name: 'Account security', exact: true }).waitFor();
      const reminderPreference = page.getByRole('checkbox', {
        name: 'Show upcoming interview reminders in CareerScope',
      });
      await reminderPreference.waitFor();
      assert.equal(await reminderPreference.isChecked(), true);
      await page
        .getByText('You are not opted in to optional product updates.', { exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Opt in to product updates', exact: true }).click();
      await page
        .getByText(/You opted in to optional product updates under version test-marketing-1/)
        .waitFor();
      await page.getByRole('button', { name: 'Withdraw marketing consent', exact: true }).click();
      await page
        .getByText('You are not opted in to optional product updates.', { exact: true })
        .waitFor();
      const activeSessions = page.getByRole('list', { name: 'Active devices and sessions' });
      await activeSessions.getByText('Test device', { exact: true }).waitFor();
      assert.equal(await activeSessions.getByRole('listitem').count(), 3);
      assert.equal(await activeSessions.getByRole('button').count(), 2);
      page.once('dialog', (dialog) => dialog.accept());
      await activeSessions
        .getByRole('button', { name: 'Sign out Test device', exact: true })
        .click();
      await page.getByRole('status').filter({ hasText: 'Test device signed out.' }).waitFor();
      assert.equal(await securityAuth.session(deviceSession.accessToken), null);
      await activeSessions.getByText('Test device', { exact: true }).waitFor({ state: 'detached' });
      assert.equal(await activeSessions.getByRole('listitem').count(), 2);
      page.once('dialog', (dialog) => dialog.dismiss());
      await page.getByRole('button', { name: 'Sign out other sessions', exact: true }).click();
      assert.ok(await securityAuth.session(secondSession));
      let releaseRevocation!: () => void;
      const revocationGate = new Promise<void>((resolve) => {
        releaseRevocation = resolve;
      });
      await page.route(
        '**/api/account/sessions/revoke-others',
        async (route) => {
          await revocationGate;
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Synthetic private session detail' }),
          });
        },
        { times: 1 },
      );
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Sign out other sessions', exact: true }).click();
      try {
        const pendingRevocation = page.getByRole('button', {
          name: 'Signing out other sessions',
          exact: true,
        });
        await pendingRevocation.waitFor();
        assert.equal(await pendingRevocation.isDisabled(), true);
        assert.equal(
          await page.getByRole('button', { name: 'Back to search', exact: true }).isDisabled(),
          true,
        );
      } finally {
        releaseRevocation();
      }
      // CS-13 re-review: filtering on the substring 'Request failed. Please
      // try again.' passed identically before and after the operation name was
      // added — the invisible-substring shape F-1 was raised for. Assert the
      // WHOLE string so removing the "what failed" half fails here too, not
      // only at the type level.
      const revocationAlert = page
        .getByRole('alert')
        .filter({ hasText: 'Request failed. Please try again.' });
      await revocationAlert.waitFor();
      assert.equal(
        (await revocationAlert.innerText()).trim(),
        'Could not sign out other sessions. Request failed. Please try again.',
      );
      assert.equal(
        await page.getByText('Synthetic private session detail', { exact: true }).count(),
        0,
      );
      assert.ok(await securityAuth.session(secondSession));
      assert.equal(
        await page.getByRole('status').filter({ hasText: 'Other sessions signed out.' }).count(),
        0,
      );
      await page.route(
        '**/api/account/sessions/revoke-others',
        (route) => route.fulfill({ status: 429, contentType: 'application/json', body: '{}' }),
        { times: 1 },
      );
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Sign out other sessions', exact: true }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: 'Too many requests. Try again shortly.' })
        .waitFor();
      assert.equal(
        await page
          .getByRole('button', { name: 'Sign out other sessions', exact: true })
          .isEnabled(),
        true,
      );
      assert.ok(await securityAuth.session(secondSession));
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Sign out other sessions', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Other sessions signed out.' }).waitFor();
      assert.equal(await securityAuth.session(secondSession), null);
      for (const width of responsiveWidthsEndingAt(320)) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        if (engine === 'chromium')
          await page.screenshot({
            path: fileURLToPath(new URL(`../test-results/security-${width}.png`, import.meta.url)),
            fullPage: true,
          });
      }
      await page.getByRole('button', { name: 'Back to search', exact: true }).click();
      // Signed in again: the shared authenticated shell (its greeting heading
      // on /dashboard) is the current proof, replacing the old single-page
      // header's "Account security" button.
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
      assert.equal(
        (await new ProfileRepository(database).get(account.rows[0]!.id))?.revision,
        reviewed.revision,
      );
      // Sign out through the shared topbar, which confirms before discarding
      // the session.
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('heading', { name: 'Select test account', exact: true }).waitFor();
      await selectFixtureAccount('ui@example.test', password);
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
      await page.setViewportSize({ width: 1440, height: 900 });
      await sidebarNav.getByRole('link', { name: 'Jobs', exact: true }).click();
      await page.waitForURL(`${origin}/jobs`);
      await page
        .getByRole('navigation', { name: 'Search history' })
        .getByRole('button', { name: /^React.*partial/s })
        .click();
      await page.getByRole('heading', { name: 'Senior React Engineer' }).waitFor();
      for (const source of ['Greenhouse', 'Lever', 'Ashby', 'Workable']) {
        const control = page.getByRole('checkbox', { name: source, exact: true });
        await control.check();
        assert.equal(await control.isChecked(), true);
        await control.uncheck();
      }
      const resultResponse = await page.request.get(`${origin}/api/searches/${search.id}`);
      assert.equal(resultResponse.status(), 200);
      const resultBody = await resultResponse.json();
      assert.equal(resultBody.status, 'partial');
      await page
        .getByText('Partial results. Some sources did not finish.', { exact: true })
        .waitFor();
      await page
        .getByRole('list', { name: 'Source outcomes' })
        .getByText('Himalayas: 1 accepted; permission review pending', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Retry failed sources', exact: true }).count(),
        0,
      );
      assert.equal(resultBody.jobs[0].data.title, 'Scored React Engineer');
      assert.equal(resultBody.jobs[1].data.match, null);
      await page.getByText('Not scored', { exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Scored React Engineer', exact: true }).click();
      await page.getByRole('region', { name: 'Match evidence' }).waitFor();
      // CS-18 copy: the low-confidence flag now explains itself instead of
      // reading "Limited Description" (match-evidence.tsx) — the assertion
      // text was stale, the behaviour it checks is unchanged.
      await page
        .getByText('Limited description — score capped, treat as low-confidence', { exact: true })
        .waitFor();
      await page.getByText('Do Not Apply', { exact: true }).waitFor();
      const scoredJobCard = page
        .locator('details.job')
        .filter({ has: page.getByRole('heading', { name: 'Scored React Engineer', exact: true }) });
      const feedbackReason = scoredJobCard.getByLabel('Report a posting issue');
      const priorFeedbackReason = resultBody.jobs[0].feedbackReason;
      const firstFeedbackReason =
        priorFeedbackReason === 'suspicious' ? 'irrelevant' : 'suspicious';
      await feedbackReason.selectOption(firstFeedbackReason);
      const firstFeedbackResponse = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/search-jobs/${resultBody.jobs[0].id}/feedback`) &&
          response.request().method() === 'PUT',
      );
      await scoredJobCard
        .getByRole('button', {
          name: priorFeedbackReason ? 'Update feedback' : 'Send feedback',
          exact: true,
        })
        .click();
      const firstFeedbackResult = await firstFeedbackResponse;
      assert.equal(firstFeedbackResult.status(), 200);
      assert.deepEqual(firstFeedbackResult.request().postDataJSON(), {
        reason: firstFeedbackReason,
      });
      await scoredJobCard
        .getByRole('status')
        .filter({ hasText: 'Your feedback was recorded.' })
        .waitFor();
      let feedbackRows = await database.pool.query(
        'SELECT owner_id, job_id, reason FROM job_feedback WHERE owner_id = $1 AND job_id = $2',
        [ownerId, resultBody.jobs[0].id],
      );
      assert.deepEqual(feedbackRows.rows, [
        { owner_id: ownerId, job_id: resultBody.jobs[0].id, reason: firstFeedbackReason },
      ]);
      const secondFeedbackReason = firstFeedbackReason === 'suspicious' ? 'incorrect' : 'duplicate';
      await feedbackReason.selectOption(secondFeedbackReason);
      const secondFeedbackResponse = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/search-jobs/${resultBody.jobs[0].id}/feedback`) &&
          response.request().method() === 'PUT',
      );
      await scoredJobCard.getByRole('button', { name: 'Update feedback', exact: true }).click();
      const secondFeedbackResult = await secondFeedbackResponse;
      assert.equal(secondFeedbackResult.status(), 200);
      assert.deepEqual(secondFeedbackResult.request().postDataJSON(), {
        reason: secondFeedbackReason,
      });
      await scoredJobCard
        .getByRole('status')
        .filter({ hasText: 'Your feedback was recorded.' })
        .waitFor();
      feedbackRows = await database.pool.query(
        'SELECT owner_id, job_id, reason FROM job_feedback WHERE owner_id = $1 AND job_id = $2',
        [ownerId, resultBody.jobs[0].id],
      );
      assert.deepEqual(feedbackRows.rows, [
        { owner_id: ownerId, job_id: resultBody.jobs[0].id, reason: secondFeedbackReason },
      ]);
      assert.equal(
        (await database.pool.query('SELECT id FROM job_feedback WHERE owner_id = $1', [ownerId]))
          .rowCount,
        1,
        'changing feedback updates the existing owner/job row instead of creating a duplicate',
      );
      await page.getByText('Senior React Engineer', { exact: true }).click();
      assert.equal(
        await page
          .locator('details.job')
          .filter({ hasText: 'Senior React Engineer' })
          .getByRole('link', { name: 'Remote OK', exact: true })
          .getAttribute('href'),
        'https://remoteok.com/remote-jobs/synthetic',
      );
      assert.equal(
        await page.getByRole('link', { name: 'Himalayas', exact: true }).getAttribute('href'),
        'https://himalayas.app/jobs/synthetic',
      );
      await page
        .getByText('Build accessible interfaces using React and TypeScript.', { exact: true })
        .waitFor();
      assert.equal(
        await page
          .locator('details')
          .filter({ hasText: 'Senior React Engineer' })
          .getByRole('link', { name: 'Open Posting' })
          .getAttribute('href'),
        'https://example.test/apply',
      );
      for (const width of responsiveWidthsEndingAt(320)) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${engine} ${width}px overflow`,
        );
        const exportBounds = await page
          .getByRole('button', { name: 'Download all results as JSON', exact: true })
          .boundingBox();
        assert.ok(
          exportBounds && exportBounds.x >= 0 && exportBounds.x + exportBounds.width <= width,
        );
        if (engine === 'chromium')
          await page.screenshot({
            path: fileURLToPath(new URL(`../test-results/workspace-${width}.png`, import.meta.url)),
            fullPage: true,
          });
      }
      await page.getByLabel('Filter results').fill('NoSuchCompany');
      // CS-13's shared EmptyState renders its title as a styled <p>, not a
      // heading (it is embedded at varying heading depths), so this checks
      // the real empty-filter state — title and its actionable description —
      // rather than the pre-CS-13 heading that no longer exists.
      await page.getByText('No matching jobs', { exact: true }).waitFor();
      await page
        .getByText('Nothing in this search matches your filter. Try clearing it.', { exact: true })
        .waitFor();
      const exportButton = page.getByRole('button', {
        name: 'Download all results as JSON',
        exact: true,
      });
      const exportStarted = page.waitForRequest((request) =>
        request.url().endsWith(`/searches/${search.id}/export`),
      );
      let releaseExport!: () => void;
      const exportGate = new Promise<void>((resolve) => {
        releaseExport = resolve;
      });
      await page.route(
        '**/api/searches/*/export',
        async (route) => {
          await exportGate;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Synthetic export outage' }),
          });
        },
        { times: 1 },
      );
      await exportButton.click();
      await exportStarted;
      await exportButton.and(page.locator(':disabled')).waitFor();
      releaseExport();
      // CS-13 criterion 2: an error must say WHAT FAILED and offer a next
      // action, never a bare message. This asserts the full string rather than
      // the generic tail, so reverting to a bare `{error.message}` fails here.
      await page
        .getByRole('alert')
        .getByText(
          'Could not export this search. Service temporarily unavailable. Please try again shortly.',
          {
            exact: true,
          },
        )
        .waitFor();
      assert.equal(await exportButton.isEnabled(), true);
      const downloaded = page.waitForEvent('download');
      await exportButton.focus();
      await page.keyboard.press('Enter');
      const download = await downloaded;
      assert.equal(download.suggestedFilename(), `careerscope-search-${search.id}.json`);
      assert.equal(await download.failure(), null);
      const downloadedPath = await download.path();
      assert.ok(downloadedPath);
      const exported = JSON.parse(await readFile(downloadedPath, 'utf8'));
      assert.deepEqual(Object.keys(exported).sort(), [
        'jobs',
        'request',
        'runId',
        'schemaVersion',
        'sourceOutcomes',
        'status',
      ]);
      assert.equal(exported.status, 'partial');
      assert.deepEqual(exported.sourceOutcomes, sourceOutcomes);
      assert.equal(exported.schemaVersion, 1);
      assert.equal(exported.runId, search.id);
      assert.deepEqual(exported.request.sources, ['himalayas', 'remoteok']);
      assert.deepEqual(
        exported.jobs,
        resultBody.jobs.map((job: { data: unknown }) => job.data),
      );
      await download.delete();
      await page.getByText('Download started.', { exact: true }).waitFor();
      await page
        .getByText(
          'Could not export this search. Service temporarily unavailable. Please try again shortly.',
          { exact: true },
        )
        .waitFor({ state: 'hidden' });
      // An expiry the server actually agrees with: CS-6's shared shell
      // re-checks the session on `/`, so a *synthetic* 401 against a session
      // that is still valid server-side would simply bounce straight back to
      // /dashboard and prove nothing. Removing the session row makes the
      // export request 401 for real, which is the case this check exists for.
      await database.pool.query('DELETE FROM sessions WHERE owner_id = $1', [ownerId]);
      await exportButton.click();
      await page.getByRole('heading', { name: 'Select test account', exact: true }).waitFor();
      await selectFixtureAccount('ui@example.test', password);
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
      await page.setViewportSize({ width: 1440, height: 900 });
      await sidebarNav.getByRole('link', { name: 'Jobs', exact: true }).click();
      await page.waitForURL(`${origin}/jobs`);
      await page
        .getByRole('navigation', { name: 'Search history' })
        .getByRole('button', { name: /^React.*partial/s })
        .click();
      await page.getByLabel('Filter results').fill('');
      await page.getByLabel('Role or technology').fill('TypeScript');
      await page.getByRole('checkbox', { name: 'Greenhouse', exact: true }).uncheck();
      assert.equal(
        await page.getByRole('button', { name: 'Search', exact: true }).isDisabled(),
        true,
      );
      await page.getByRole('checkbox', { name: 'Greenhouse', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Lever', exact: true }).check();
      const submitted = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/searches') && response.request().method() === 'POST',
      );
      const progressStream = page.waitForResponse(
        (response) =>
          response.url().includes('/api/searches/') && response.url().endsWith('/events'),
      );
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const submission = await submitted;
      assert.equal(submission.status(), 202);
      const submittedId = (await submission.json()).runId;
      assert.deepEqual((await database.getSearch(ownerId, submittedId))?.request.sources, [
        'greenhouse',
        'lever',
      ]);
      await page.getByText('Search in progress', { exact: true }).waitFor();
      assert.equal((await progressStream).status(), 200);
      const startedCommand = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === submittedId,
      )!.command;
      const startedFence = await database.claim(startedCommand.id);
      assert.ok(startedFence);
      assert.equal(await database.startSearch(startedCommand, startedFence), true);
      await page
        .locator('.result-toolbar .status')
        .filter({ hasText: /^running$/ })
        .waitFor({ timeout: 5000 });
      assert.equal(await exportButton.count(), 0);
      const cancellation = page.getByRole('button', { name: 'Cancel search', exact: true });
      for (const width of responsiveWidthsEndingAt(320)) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        const bounds = await cancellation.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
        if (engine === 'chromium')
          await page.screenshot({
            path: fileURLToPath(new URL(`../test-results/cancel-${width}.png`, import.meta.url)),
            fullPage: true,
          });
      }
      page.once('dialog', (dialog) => dialog.dismiss());
      await cancellation.click();
      await page.getByText('Search in progress', { exact: true }).waitFor();
      assert.equal(await cancellation.isEnabled(), true);
      await page.route(
        '**/api/searches/*/cancel',
        (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Synthetic cancellation outage' }),
          }),
        { times: 1 },
      );
      page.once('dialog', (dialog) => dialog.accept());
      await cancellation.click();
      await page
        .getByText('Service temporarily unavailable. Please try again shortly.', { exact: true })
        .waitFor();
      await page.getByText('Search in progress', { exact: true }).waitFor();
      assert.equal(await cancellation.isEnabled(), true);
      page.once('dialog', (dialog) => dialog.accept());
      const cancelledDetail = waitForSearchStatusResponse(submittedId, 'cancelled');
      const cancelledList = page.waitForResponse(async (response) => {
        if (
          response.request().method() !== 'GET' ||
          response.url() !== `${origin}/api/searches` ||
          response.status() !== 200
        )
          return false;
        const body = await response.json();
        return body.items.some(
          (run: { id: string; status: string }) =>
            run.id === submittedId && run.status === 'cancelled',
        );
      });
      await cancellation.click();
      await Promise.all([cancelledDetail, cancelledList]);
      await page
        .getByRole('status')
        .filter({ hasText: /^cancelled$/ })
        .waitFor();
      assert.equal(await cancellation.count(), 0);
      assert.equal((await database.getSearch(ownerId, submittedId))?.status, 'cancelled');
      // Both refreshed read models and durable state now prove cancellation.
      // An obsolete request for another selected run is not a persistence gate.
      await page.reload();
      await page
        .getByLabel('Search sources', { exact: true })
        .getByText('Greenhouse + Lever', { exact: true })
        .waitFor();
      await page
        .getByRole('status')
        .filter({ hasText: /^cancelled$/ })
        .waitFor();
      for (const width of responsiveWidthsEndingAt(320)) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
      }
      assert.equal(
        (
          await database.pool.query('SELECT id FROM search_runs WHERE owner_id = $1 AND id <> $2', [
            ownerId,
            search.id,
          ])
        ).rowCount! > 0,
        true,
      );
      await page
        .getByRole('navigation', { name: 'Search history' })
        .getByRole('button', { name: /^React.*partial/s })
        .click();
      await page.getByRole('heading', { name: 'Senior React Engineer', exact: true }).click();
      const savedJob = page.locator('details.job').filter({ hasText: 'Senior React Engineer' });
      await page.route(
        '**/api/leads',
        (route) =>
          route.request().method() === 'POST'
            ? route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'Synthetic lead outage' }),
              })
            : route.continue(),
        { times: 1 },
      );
      await savedJob.getByRole('button', { name: 'Save Job', exact: true }).click();
      // CS-13 criterion 2: SaveJob's inline error must name what failed, not
      // just relay the transport message. Asserting the full string means a
      // regression to a bare `{error.message}` fails here.
      await savedJob
        .getByText(
          'Could not save this job. Service temporarily unavailable. Please try again shortly.',
          { exact: true },
        )
        .waitFor();
      const leadCreated = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/leads') && response.request().method() === 'POST',
      );
      await savedJob.getByRole('button', { name: 'Save Job', exact: true }).click();
      const leadResult = await leadCreated;
      assert.equal(leadResult.status(), 200);
      const leadId = (await leadResult.json()).id;
      await savedJob.getByRole('button', { name: 'Open Saved Lead', exact: true }).click();
      await page.getByRole('heading', { name: 'Saved Leads', exact: true }).waitFor();
      // Forensic audit F-1a/F-2: "Open Saved Lead" must land on the lead it
      // just saved, identified by id — not on the bare list. Both halves are
      // asserted: the id reaches the URL, and the destination actually opens
      // that lead (its details panel is present with no list click at all).
      await page.waitForURL(`${origin}/saved?lead=${leadId}`);
      const openedLead = page.getByRole('article', { name: 'Lead details' });
      await openedLead.waitFor();
      await openedLead.getByText('Senior React Engineer', { exact: true }).first().waitFor();
      assert.equal(
        await page
          .getByRole('navigation', { name: 'Saved lead list' })
          .getByRole('button', { name: /Senior React Engineer/ })
          .getAttribute('aria-current'),
        'true',
        `${engine} /saved?lead= did not open the lead it was given`,
      );
      await page
        .getByRole('navigation', { name: 'Saved lead list' })
        .getByRole('button', { name: /Senior React Engineer/ })
        .click();
      // The redesigned lead details panel exposes one posting link (the
      // lead's first recorded source link) instead of one link per source;
      // it must still be the lead's real recorded URL, never a fabricated or
      // wrong-source one. The loss of the per-source links is an application
      // finding, reported rather than quietly dropped from this suite.
      const leadDetails = page.getByRole('article', { name: 'Lead details' });
      const postingHrefs = await leadDetails
        .getByRole('link', { name: 'Open job posting' })
        .evaluateAll((elements) => elements.map((element) => element.getAttribute('href')));
      assert.ok(
        postingHrefs.length > 0,
        `${engine} saved lead details exposes no posting link at all`,
      );
      assert.deepEqual([...new Set(postingHrefs)], ['https://himalayas.app/jobs/synthetic']);
      const leadRepository = new LeadRepository(database);
      const linkedLead = await leadRepository.get(ownerId, leadId);
      assert.equal(linkedLead?.status, 'saved');
      const postingUrl = 'https://himalayas.app/jobs/synthetic';
      const interceptPosting = (route: import('playwright').Route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><title>Synthetic destination</title><p>Synthetic external destination</p>',
        });
      await page.context().route(postingUrl, interceptPosting);
      const externalPostingLink = leadDetails
        .getByRole('link', { name: 'Open job posting' })
        .first();
      assert.equal(await externalPostingLink.getAttribute('target'), '_blank');
      assert.match((await externalPostingLink.getAttribute('rel')) ?? '', /\bnoopener\b/);
      const destinationOpened = page.waitForEvent('popup');
      await externalPostingLink.click();
      const destination = await destinationOpened;
      await destination.waitForURL(postingUrl);
      await destination.getByText('Synthetic external destination', { exact: true }).waitFor();
      await destination.close();
      assert.equal(
        (await leadRepository.get(ownerId, leadId))?.status,
        'saved',
        `${engine}: opening the external destination changed application status`,
      );
      await openedLead.getByRole('button', { name: 'Record application', exact: true }).click();
      const evidenceForm = openedLead.locator('form');
      await evidenceForm.getByRole('heading', { name: 'Record your application' }).waitFor();
      await evidenceForm.getByLabel('Application method', { exact: true }).fill('Employer website');
      const confirmationSelect = evidenceForm
        .locator('label')
        .filter({ hasText: 'Did you receive a confirmation?' })
        .locator('select');
      assert.equal(await confirmationSelect.count(), 1);
      await confirmationSelect.selectOption('received');
      await evidenceForm
        .getByLabel('Evidence source (optional)', { exact: true })
        .fill('Synthetic candidate report');
      const confidenceSelect = evidenceForm
        .locator('label')
        .filter({ hasText: 'Your confidence in this record' })
        .locator('select');
      assert.equal(await confidenceSelect.count(), 1);
      await confidenceSelect.selectOption('medium');
      assert.match(
        (await openedLead.textContent()) ?? '',
        /This records your report only\. CareerScope does not submit the application or verify an employer response\./,
      );
      const applicationRecorded = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/leads/${leadId}`) && response.request().method() === 'PUT',
      );
      await evidenceForm.getByRole('button', { name: 'Record I applied', exact: true }).click();
      const applicationResponse = await applicationRecorded;
      assert.equal(applicationResponse.status(), 200);
      const applicationRecord = await applicationResponse.json();
      assert.equal(applicationRecord.status, 'applied');
      assert.equal(applicationRecord.applicationEvidence.method, 'Employer website');
      assert.equal(applicationRecord.applicationEvidence.source, 'Synthetic candidate report');
      await page.goto(`${origin}/applications`);
      await page.waitForURL(`${origin}/applications`);
      await page.getByRole('heading', { name: 'Applications', exact: true }).waitFor();
      await page
        .getByRole('navigation', { name: 'Saved lead list' })
        .getByRole('button', { name: /Senior React Engineer/ })
        .click();
      const applicationDetails = page.getByRole('article', { name: 'Lead details' });
      await applicationDetails
        .getByText('Candidate reports receiving confirmation', { exact: true })
        .waitFor();
      const interviewOrganizer = applicationDetails.getByRole('region', {
        name: 'Interview organizer',
      });
      await interviewOrganizer.getByRole('heading', { name: 'Interview rounds' }).waitFor();
      await interviewOrganizer.getByRole('button', { name: 'Add round' }).click();
      const interviewForm = interviewOrganizer.locator('form');
      await interviewForm.getByLabel('Round name').fill('Technical interview');
      await interviewForm.getByLabel('Date and time').fill('2030-05-10T15:00');
      await interviewForm.getByLabel('Time zone (IANA)').fill('Asia/Kolkata');
      await interviewForm.getByLabel('Format').selectOption('video');
      await interviewForm.getByLabel('Status').selectOption('scheduled');
      await interviewForm.getByRole('button', { name: 'Add contact' }).click();
      await interviewForm.getByLabel('Name', { exact: true }).fill('Synthetic interviewer');
      await interviewForm.getByLabel('Role', { exact: true }).fill('Engineering');
      await interviewForm
        .getByRole('textbox', { name: 'New preparation item' })
        .fill('Review system design notes');
      await interviewForm.getByRole('button', { name: 'Add item' }).click();
      await interviewForm.getByLabel('Reminder time (optional)').fill('2030-05-10T14:00');
      await interviewForm.getByLabel('Notes', { exact: true }).fill('Prepare examples.');
      assert.match(
        (await interviewOrganizer.textContent()) ?? '',
        /email and push notifications are not sent/i,
      );
      const interviewCreated = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/leads/${leadId}/interviews`) &&
          response.request().method() === 'POST',
      );
      await interviewForm.getByRole('button', { name: 'Save round' }).click();
      const interviewCreateResponse = await interviewCreated;
      assert.equal(interviewCreateResponse.status(), 200);
      const createdRound = await interviewCreateResponse.json();
      assert.equal(createdRound.title, 'Technical interview');
      assert.equal(createdRound.timeZone, 'Asia/Kolkata');
      assert.equal(createdRound.startsAt, '2030-05-10T09:30:00.000Z');
      assert.equal(createdRound.contacts[0].name, 'Synthetic interviewer');
      assert.equal(createdRound.checklist[0].label, 'Review system design notes');
      assert.equal(createdRound.notes, 'Prepare examples.');
      assert.ok(createdRound.reminderAt);
      await database.pool.query(
        `UPDATE interview_rounds
         SET reminder_at = now() - interval '1 minute'
         WHERE owner_id = $1 AND id = $2`,
        [ownerId, createdRound.id],
      );
      assert.equal(await publishDueInterviewReminders(database), 1);
      const notificationToggle = page.locator('summary[aria-label^="Notifications"]');
      await notificationToggle.waitFor({ state: 'visible' });
      const notificationsResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/notifications') && response.request().method() === 'GET',
      );
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      const notificationResult = await notificationsResponse;
      assert.equal(notificationResult.status(), 200);
      const notificationBody = await notificationResult.json();
      assert.equal(
        notificationBody.items.length,
        1,
        `The authenticated UI owner did not receive the due reminder: ${JSON.stringify(notificationBody)}`,
      );
      assert.equal(notificationBody.unreadCount, 1);
      const notificationPanel = page.getByRole('region', { name: 'Notifications' });
      await page.waitForFunction(
        () =>
          document
            .querySelector('summary[aria-label^="Notifications"]')
            ?.getAttribute('aria-label') === 'Notifications, 1 unread',
      );
      await notificationToggle.click();
      await notificationPanel.getByText('You have an upcoming interview round.').waitFor();
      const notificationText = (await notificationPanel.textContent()) ?? '';
      assert.equal(notificationText.includes('Synthetic interviewer'), false);
      assert.equal(notificationText.includes('Prepare examples.'), false);

      // Reproduce the mutation/read race: capture an unread snapshot before
      // the PUT, delay delivering that response to the browser, then require
      // the post-mutation refresh to replace it with the current read state.
      await notificationToggle.click();
      await settled('notification panel close before mutation race');
      if (notificationLifecycleOnly) {
        assert.deepEqual(
          errors.filter((error) => !expectedAuthenticatedJourneyConsoleErrors.has(error)),
          [],
          'focused Chromium journey produced an unexpected runtime error',
        );
        assert.deepEqual(await unhandledRejections(page), []);
        await page.unrouteAll({ behavior: 'wait' });
        process.stdout.write(
          'Chromium focused notification panel close before mutation race: PASS; later browser scenarios were not run\n',
        );
        break;
      }
      let heldNotificationReads = 0;
      let releaseStaleNotificationRead!: () => void;
      let resolveStaleNotificationReadFetched!: () => void;
      const staleNotificationReadGate = new Promise<void>((resolve) => {
        releaseStaleNotificationRead = resolve;
      });
      let rejectStaleNotificationReadFetched!: (error: Error) => void;
      const staleNotificationReadFetched = new Promise<void>((resolve, reject) => {
        resolveStaleNotificationReadFetched = resolve;
        rejectStaleNotificationReadFetched = reject;
      });
      const holdStaleNotificationRead = async (route: import('playwright').Route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        heldNotificationReads += 1;
        if (heldNotificationReads === 1) {
          try {
            const staleResponse = await route.fetch({ timeout: 15000 });
            const staleBody = (await staleResponse.json()) as {
              items: unknown[];
              unreadCount: number;
            };
            assert.ok(
              Array.isArray(staleBody.items),
              'the stale response must retain the notification items',
            );
            assert.equal(
              staleBody.unreadCount,
              1,
              'the held response must predate the read mutation',
            );
            resolveStaleNotificationReadFetched();
            await staleNotificationReadGate;
            await route.fulfill({
              status: staleResponse.status(),
              contentType: 'application/json',
              body: JSON.stringify(staleBody),
            });
          } catch (error) {
            rejectStaleNotificationReadFetched(
              error instanceof Error
                ? error
                : new Error('Could not capture the stale notification response'),
            );
            throw error;
          }
          return;
        }
        await route.fallback();
      };
      try {
        await page.route('**/api/notifications', holdStaleNotificationRead);
        await notificationToggle.click();
        await staleNotificationReadFetched;
        const markReadResponse = page.waitForResponse(
          (response) =>
            response.url().includes('/api/notifications/') &&
            response.url().endsWith('/read') &&
            response.request().method() === 'PUT',
        );
        await notificationPanel.getByRole('button', { name: 'Mark as read' }).click();
        assert.equal((await markReadResponse).status(), 204);
        releaseStaleNotificationRead();
        await page.waitForFunction(
          () =>
            document
              .querySelector('summary[aria-label^="Notifications"]')
              ?.getAttribute('aria-label') === 'Notifications',
        );
        await settled('notification post-mutation refresh');
      } finally {
        releaseStaleNotificationRead();
        await page.unroute('**/api/notifications', holdStaleNotificationRead);
      }
      assert.equal(
        heldNotificationReads,
        2,
        `${engine}: successful mark-read must issue one refresh after the older read settles`,
      );
      await notificationToggle.click();
      await interviewOrganizer.getByText('Technical interview', { exact: true }).waitFor();
      await interviewOrganizer
        .getByText('To do: Review system design notes', { exact: true })
        .waitFor();
      await interviewOrganizer.getByRole('button', { name: 'Edit round' }).click();
      const editInterviewForm = interviewOrganizer.locator('form');
      await editInterviewForm.getByLabel('Status').selectOption('completed');
      const interviewUpdated = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/interviews/${createdRound.id}`) &&
          response.request().method() === 'PUT',
      );
      await editInterviewForm.getByRole('button', { name: 'Save round' }).click();
      assert.equal((await interviewUpdated).status(), 200);
      await interviewOrganizer.getByText('completed', { exact: true }).waitFor();
      assert.equal(
        (await leadRepository.get(ownerId, leadId))?.status,
        'applied',
        `${engine}: interview completion must not synthesize a lifecycle transition`,
      );
      await page.reload();
      await page
        .getByRole('navigation', { name: 'Saved lead list' })
        .getByRole('button', { name: /Senior React Engineer/ })
        .click();
      const persistedOrganizer = page
        .getByRole('article', { name: 'Lead details' })
        .getByRole('region', { name: 'Interview organizer' });
      await persistedOrganizer.getByText('Technical interview', { exact: true }).waitFor();
      await persistedOrganizer.getByText('completed', { exact: true }).waitFor();
      await page.once('dialog', (dialog) => dialog.accept());
      const archiveApplication = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/leads/${leadId}`) && response.request().method() === 'PUT',
      );
      await applicationDetails.getByRole('button', { name: 'Archive in CareerScope' }).click();
      assert.equal((await archiveApplication).status(), 200);
      assert.equal((await leadRepository.get(ownerId, leadId))?.status, 'archived');
      assert.equal(
        (await leadRepository.get(ownerId, leadId))?.applicationEvidence?.method,
        'Employer website',
      );
      await page.goto(`${origin}/saved`);
      await page.getByRole('heading', { name: 'Saved Leads', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Archived', exact: true }).click();
      await page
        .getByRole('navigation', { name: 'Saved lead list' })
        .getByRole('button', { name: /Senior React Engineer/ })
        .click();
      const archivedDetails = page.getByRole('article', { name: 'Lead details' });
      await archivedDetails.getByText('Employer website', { exact: true }).waitFor();
      await page.once('dialog', (dialog) => dialog.accept());
      const restoreApplication = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/leads/${leadId}`) && response.request().method() === 'PUT',
      );
      await archivedDetails.getByRole('button', { name: 'Restore Lead' }).click();
      assert.equal((await restoreApplication).status(), 200);
      assert.equal((await leadRepository.get(ownerId, leadId))?.status, 'saved');
      assert.equal(
        (await leadRepository.get(ownerId, leadId))?.applicationEvidence?.method,
        'Employer website',
      );
      await page.goto(`${origin}/saved?lead=${leadId}`);
      await page.getByRole('heading', { name: 'Saved Leads', exact: true }).waitFor();
      await openedLead.getByText('Senior React Engineer', { exact: true }).first().waitFor();
      const notes = page.getByRole('textbox', { name: 'Notes', exact: true });
      await notes.fill(`Private synthetic ${engine} notes`);
      page.once('dialog', (dialog) => dialog.dismiss());
      await page.getByRole('button', { name: 'Back to search', exact: true }).click();
      assert.equal(await notes.inputValue(), `Private synthetic ${engine} notes`);
      const notesSaved = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/leads/${leadId}`) && response.request().method() === 'PUT',
      );
      const refreshedLeads = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/leads?status=saved') && response.status() === 200,
      );
      const refreshedHistory = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/leads/${leadId}/history`) && response.status() === 200,
      );
      await page.getByRole('button', { name: 'Save Notes', exact: true }).click();
      assert.equal((await notesSaved).status(), 200);
      // Both refetches must have completed — asserted on the resolved
      // responses themselves. `Response.finished()` was used here before and
      // was observed hanging indefinitely against the proxied dev server
      // (it takes no timeout, so it stalled the entire suite rather than
      // failing); the predicates above already require a 200.
      assert.equal((await refreshedLeads).status(), 200);
      assert.equal((await refreshedHistory).status(), 200);
      const tags = page.getByRole('textbox', { name: 'Comma-separated tags', exact: true });
      assert.equal(await tags.getAttribute('maxlength'), '790');
      const maximumCodePointTag = '🙂'.repeat(32);
      await tags.fill(`Target role, ${maximumCodePointTag}, Remote`);
      const tagsSaved = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/leads/${leadId}`) && response.request().method() === 'PUT',
      );
      const tagsHistory = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/leads/${leadId}/history`) && response.status() === 200,
      );
      await page.getByRole('button', { name: 'Save Tags', exact: true }).click();
      assert.equal((await tagsSaved).status(), 200);
      assert.equal((await tagsHistory).status(), 200);
      // Exercise the shared editor on its applications surface, where tag
      // editing is unavailable: saving notes must leave the existing tags
      // untouched rather than sending them as an attempted tag mutation.
      const taggedLead = await leadRepository.get(ownerId, leadId);
      assert.ok(taggedLead?.applicationEvidence);
      await leadRepository.update(ownerId, leadId, {
        revision: taggedLead.revision,
        notes: taggedLead.notes,
        status: 'applied',
      });
      await page.goto(`${origin}/applications?lead=${leadId}`);
      const applicationLead = page.getByRole('article', { name: 'Lead details' });
      await applicationLead.waitFor();
      await page
        .getByRole('textbox', { name: 'Notes', exact: true })
        .fill(`Private synthetic ${engine} notes updated after application`);
      const appliedNoteSaved = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/leads/${leadId}`) && response.request().method() === 'PUT',
      );
      await page.getByRole('button', { name: 'Save Notes', exact: true }).click();
      const appliedNoteResponse = await appliedNoteSaved;
      assert.equal(appliedNoteResponse.status(), 200, 'Application notes save without a tag edit');
      assert.equal('tags' in appliedNoteResponse.request().postDataJSON(), false);
      assert.deepEqual((await leadRepository.get(ownerId, leadId))?.tags, [
        'Target role',
        maximumCodePointTag,
        'Remote',
      ]);
      await page
        .getByRole('button', { name: 'Save Notes', exact: true })
        .and(page.locator(':disabled'))
        .waitFor();
      // The write and both invalidated read models were asserted above. This
      // route can retain unrelated cached-query traffic in Firefox, so a
      // global network-idle condition is not a meaningful persistence gate;
      // the following full reload plus persisted-notes assertion is.
      // Re-open the same owner-scoped record on the saved surface to verify
      // that the application-surface note save preserved its non-editable tags.
      await page.goto(`${origin}/saved?lead=${leadId}`);
      await page.getByRole('heading', { name: 'Saved Leads', exact: true }).waitFor();
      await page.getByRole('article', { name: 'Lead details' }).waitFor();
      await notes.waitFor();
      assert.equal(
        await notes.inputValue(),
        `Private synthetic ${engine} notes updated after application`,
      );
      await tags.waitFor();
      assert.equal(await tags.inputValue(), `Target role, ${maximumCodePointTag}, Remote`);
      // The applied record is deep-linked from /saved but no longer belongs
      // to its saved-stage list; its tag is visible once in the details.
      assert.equal(await page.getByText('Target role', { exact: true }).count(), 1);
      const currentLead = await leadRepository.get(ownerId, leadId);
      assert.ok(currentLead);
      await leadRepository.update(ownerId, leadId, {
        revision: currentLead.revision,
        notes: 'Changed in another session',
        status: 'saved',
      });
      await notes.fill('Unsaved local lead notes');
      await page.getByRole('button', { name: 'Save Notes', exact: true }).click();
      await page
        .getByText(
          // CS-13 AC2: the save failure now names what failed before the
          // recoverable detail, instead of surfacing the bare API message.
          'Could not save this lead. This record changed in another session. Your edits have not been saved.',
          {
            exact: true,
          },
        )
        .waitFor();
      assert.equal(await notes.inputValue(), 'Unsaved local lead notes');
      page.once('dialog', (dialog) => dialog.dismiss());
      await page.getByRole('button', { name: 'Discard Edits and Reload', exact: true }).click();
      assert.equal(await notes.inputValue(), 'Unsaved local lead notes');
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Discard Edits and Reload', exact: true }).click();
      await page.waitForFunction(
        () =>
          (document.querySelector('textarea[name="notes"]') as HTMLTextAreaElement)?.value ===
          'Changed in another session',
      );
      // The archive control is labelled "Archive in CareerScope" now (it
      // names the system the action affects, since the lead also exists on
      // the job board it came from); its confirm-before-archiving behaviour
      // is unchanged and still asserted here.
      page.once('dialog', (dialog) => dialog.dismiss());
      await page.getByRole('button', { name: 'Archive in CareerScope', exact: true }).click();
      assert.equal((await leadRepository.get(ownerId, leadId))?.status, 'saved');
      page.once('dialog', (dialog) => dialog.accept());
      const archivedLeadHistory = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/leads/${leadId}/history`) &&
          response.request().method() === 'GET' &&
          response.status() === 200,
      );
      await page.getByRole('button', { name: 'Archive in CareerScope', exact: true }).click();
      await page.getByRole('button', { name: 'Restore Lead', exact: true }).waitFor();
      assert.equal((await archivedLeadHistory).status(), 200);
      await page
        .getByRole('group', { name: 'Lead status' })
        .getByRole('button', { name: 'Archived', exact: true })
        .click();
      await page
        .getByRole('navigation', { name: 'Saved lead list' })
        .getByRole('button', { name: /Senior React Engineer/ })
        .click();
      page.once('dialog', (dialog) => dialog.accept());
      const restoredLeadHistory = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/leads/${leadId}/history`) &&
          response.request().method() === 'GET' &&
          response.status() === 200,
      );
      await page.getByRole('button', { name: 'Restore Lead', exact: true }).click();
      // "Restore Lead" only renders while the lead is archived, and the
      // archive button now stays rendered-but-disabled instead of being
      // removed — so its mere presence proves nothing. Wait for the restore
      // to actually land in the UI before asserting the stored status.
      await page
        .getByRole('button', { name: 'Restore Lead', exact: true })
        .waitFor({ state: 'detached' });
      await page
        .getByRole('button', { name: 'Archive in CareerScope', exact: true })
        .and(page.locator(':enabled'))
        .waitFor();
      assert.equal((await restoredLeadHistory).status(), 200);
      assert.equal((await leadRepository.get(ownerId, leadId))?.status, 'saved');
      for (const width of responsiveWidthsEndingAt(320)) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${engine} leads ${width}px overflow`,
        );
        if (engine === 'chromium')
          await page.screenshot({
            path: fileURLToPath(new URL(`../test-results/leads-${width}.png`, import.meta.url)),
            fullPage: true,
          });
      }
      const leadHistory = await leadRepository.history(ownerId, leadId, {});
      assert.ok(leadHistory?.items.some((entry) => entry.status === 'archived'));
      await page.getByRole('button', { name: 'Back to search', exact: true }).click();
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
      await page.setViewportSize({ width: 1440, height: 900 });
      await sidebarNav.getByRole('link', { name: 'Resume', exact: true }).click();
      await page.getByRole('heading', { name: 'Candidate Profile', exact: true }).waitFor();
      await page.getByLabel('Full Name', { exact: true }).fill('Example Candidate');
      await page.getByLabel('Email', { exact: true }).fill('candidate@example.test');
      await page.getByLabel('Location', { exact: true }).fill('Hyderabad');
      await page.getByLabel('Graduation Year', { exact: true }).fill('2024');
      await page.getByRole('checkbox', { name: 'Reduce non-essential motion' }).check();
      await page
        .getByRole('textbox', { name: 'Education', exact: true })
        .fill('B.Tech, Computer Science');
      await page
        .getByRole('textbox', { name: 'Projects', exact: true })
        .fill('Accessible job search prototype');
      // Satisfy the profile form's existing required preference fields so the
      // submit handler reaches the education/project length validation below.
      await page.getByRole('textbox', { name: 'Target Roles', exact: true }).fill('React Engineer');
      await page.getByRole('textbox', { name: 'Skills', exact: true }).fill('React\nTypeScript');
      const educationField = page.getByRole('textbox', { name: 'Education', exact: true });
      const projectsField = page.getByRole('textbox', { name: 'Projects', exact: true });
      const profiles = new ProfileRepository(database);
      const profileBeforeInvalidInput = await profiles.get(ownerId);
      for (const [field, value] of [
        [educationField, 'B.Tech, Computer Science'],
        [projectsField, 'Accessible job search prototype'],
      ] as const) {
        await field.fill('x'.repeat(201));
        await page.getByRole('button', { name: 'Save Profile', exact: true }).click();
        assert.equal(
          await field.evaluate((element) => (element as HTMLTextAreaElement).validity.customError),
          true,
          `${engine}: profile list entries over 200 characters must show field validation`,
        );
        const profileAfterInvalidInput = await profiles.get(ownerId);
        assert.equal(
          profileAfterInvalidInput?.revision ?? 0,
          profileBeforeInvalidInput?.revision ?? 0,
          `${engine}: invalid profile list entry must not persist`,
        );
        await field.fill(value);
      }
      await page.getByLabel('Years of Experience', { exact: true }).fill('4');
      // The real unsaved-work guard on this screen today: the profile
      // editor's own "Back to Search" confirms before discarding, and the
      // beforeunload guard below covers a full page unload. (The old loop
      // also clicked a brand <Link> in the pre-CS-6 header, which no longer
      // exists; the sidebar's plain <Link> navigation does not prompt today
      // — reported as an application finding rather than asserted here.)
      {
        let warned = false;
        const onDialog = async (dialog: import('playwright').Dialog) => {
          warned = true;
          await dialog.dismiss();
        };
        page.on('dialog', onDialog);
        await page.getByRole('button', { name: 'Back to Search', exact: true }).click();
        page.off('dialog', onDialog);
        assert.equal(warned, true, `${engine}: dirty profile navigation must warn`);
        assert.equal(
          await page.getByLabel('Full Name', { exact: true }).inputValue(),
          'Example Candidate',
        );
      }
      assert.equal(
        await page.evaluate(() => {
          const event = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        }),
        true,
        `${engine}: dirty profile unload must be guarded`,
      );
      await page.getByRole('button', { name: 'Save Profile', exact: true }).click();
      await page.getByText('Profile saved.', { exact: true }).waitFor();
      const savedProfile = await new ProfileRepository(database).get(ownerId);
      assert.deepEqual(savedProfile?.profile.candidate.education, ['B.Tech, Computer Science']);
      assert.equal(savedProfile?.profile.candidate.graduationYear, 2024);
      assert.deepEqual(savedProfile?.profile.accessibility, { reducedMotion: true });
      assert.deepEqual(savedProfile?.profile.candidate.projects, [
        'Accessible job search prototype',
      ]);
      const experienceField = page.getByLabel('Years of Experience', { exact: true });
      await experienceField.fill('');
      await page.getByRole('button', { name: 'Save Profile', exact: true }).click();
      await page.getByText('Profile saved.', { exact: true }).waitFor();
      assert.equal(
        (await profiles.get(ownerId))?.profile.application.yearsOfExperience,
        null,
        `${engine}: blank experience must persist as unknown rather than zero`,
      );
      await experienceField.fill('0');
      await page.getByRole('button', { name: 'Save Profile', exact: true }).click();
      await page.getByText('Profile saved.', { exact: true }).waitFor();
      assert.equal(
        (await profiles.get(ownerId))?.profile.application.yearsOfExperience,
        0,
        `${engine}: explicitly entered zero must remain distinct from unknown`,
      );
      await experienceField.fill('4');
      await page.getByRole('button', { name: 'Save Profile', exact: true }).click();
      await page.getByText('Profile saved.', { exact: true }).waitFor();
      await page.waitForFunction(
        () => document.documentElement.dataset.reducedMotion === 'true',
        undefined,
        { timeout: 5000 },
      );
      await database.pool.query(
        `UPDATE candidate_profiles
         SET data = data #- '{candidate,education}'
                    #- '{candidate,projects}'
                    #- '{candidate,graduationYear}'
         WHERE owner_id = $1`,
        [ownerId],
      );
      await page.reload();
      await page.getByLabel('Full Name', { exact: true }).waitFor();
      assert.equal(
        await page.getByRole('checkbox', { name: 'Reduce non-essential motion' }).isChecked(),
        true,
      );
      assert.equal(await page.locator('html').getAttribute('data-reduced-motion'), 'true');
      assert.equal(await page.getByLabel('Graduation Year', { exact: true }).inputValue(), '');
      assert.equal(await educationField.inputValue(), '');
      assert.equal(await projectsField.inputValue(), '');
      await page.getByLabel('Graduation Year', { exact: true }).fill('2024');
      await educationField.fill('B.Tech, Computer Science');
      await projectsField.fill('Accessible job search prototype');
      await page.getByRole('button', { name: 'Save Profile', exact: true }).click();
      await page.getByText('Profile saved.', { exact: true }).waitFor();
      const normalizedProfile = await profiles.get(ownerId);
      assert.deepEqual(normalizedProfile?.profile.candidate.education, [
        'B.Tech, Computer Science',
      ]);
      assert.equal(normalizedProfile?.profile.candidate.graduationYear, 2024);
      assert.deepEqual(normalizedProfile?.profile.candidate.projects, [
        'Accessible job search prototype',
      ]);
      assert.equal(
        await page.evaluate(() => {
          const event = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        }),
        false,
        `${engine}: saved profile must release unload guard`,
      );
      // The same control must not prompt once there is nothing to lose — a
      // guard that always fires is indistinguishable from no guard at all.
      {
        let prompted = false;
        const onDialog = async (dialog: import('playwright').Dialog) => {
          prompted = true;
          await dialog.dismiss();
        };
        page.on('dialog', onDialog);
        sharedRoutePrefetches.length = 0;
        await page.getByRole('button', { name: 'Back to Search', exact: true }).click();
        await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
        await settled('dashboard');
        page.off('dialog', onDialog);
        assert.equal(prompted, false, `${engine}: a saved profile must not warn on navigation`);
        assert.deepEqual(
          sharedRoutePrefetches,
          [],
          `${engine}: returning to the dashboard must not leave speculative route prefetches open`,
        );
      }
      // The dashboard's finite route fetches were observed to finish before
      // this navigation, so a response below belongs to the Resume route
      // rather than stale dashboard traffic.
      const resumeViewLoaded = page
        .waitForResponse(
          (response) =>
            response.url().endsWith('/api/resumes') && response.request().method() === 'GET',
          { timeout: 5000 },
        )
        .catch(() => undefined);
      await sidebarNav.getByRole('link', { name: 'Resume', exact: true }).click();
      await page.getByRole('heading', { name: 'Candidate Profile', exact: true }).waitFor();
      const resumeResponse = await resumeViewLoaded;
      if (resumeResponse) assert.equal(resumeResponse.status(), 200);
      await settled('resume');
      await page.reload();
      await page.getByLabel('Full Name', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Graduation Year', { exact: true }).inputValue(), '2024');
      assert.equal(
        await page.getByRole('textbox', { name: 'Education', exact: true }).inputValue(),
        'B.Tech, Computer Science',
      );
      assert.equal(
        await page.getByRole('textbox', { name: 'Projects', exact: true }).inputValue(),
        'Accessible job search prototype',
      );
      assert.equal(
        await page.getByLabel('Full Name', { exact: true }).inputValue(),
        'Example Candidate',
      );
      const current = await profiles.get(ownerId);
      assert.ok(current);
      await profiles.save(ownerId, {
        revision: current.revision,
        profile: {
          ...current.profile,
          candidate: { ...current.profile.candidate, fullName: 'Updated In Another Session' },
        },
      });
      await page.getByLabel('Full Name', { exact: true }).fill('Unsaved Local Edits');
      await page.getByRole('button', { name: 'Save Profile', exact: true }).click();
      await page
        .getByText(
          // CS-13 AC2: same rule on the profile form — what failed, then the
          // detail, then the recovery control below it.
          'Could not save your profile. This record changed in another session. Your edits have not been saved.',
          {
            exact: true,
          },
        )
        .waitFor();
      assert.equal(
        await page.getByLabel('Full Name', { exact: true }).inputValue(),
        'Unsaved Local Edits',
      );
      await page.getByRole('button', { name: 'Discard Edits and Reload', exact: true }).click();
      await page.waitForFunction(
        () =>
          (document.querySelector('input[name="fullName"]') as HTMLInputElement)?.value ===
          'Updated In Another Session',
      );
      for (const width of responsiveWidthsEndingAt(320)) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${engine} profile ${width}px overflow`,
        );
        if (engine === 'chromium')
          await page.screenshot({
            path: fileURLToPath(new URL(`../test-results/profile-${width}.png`, import.meta.url)),
            fullPage: true,
          });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('button', { name: 'Back to Search', exact: true }).click();
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
      await sidebarNav.getByRole('link', { name: 'Jobs', exact: true }).click();
      await page.waitForURL(`${origin}/jobs`);
      await page
        .getByRole('navigation', { name: 'Search history' })
        .getByRole('button', { name: /^Greenhouse Retry.*failed/s })
        .click();
      const retried = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/searches') && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Retry failed sources', exact: true }).click();
      const retryResponse = await retried;
      assert.equal(retryResponse.status(), 202);
      const retryId = (await retryResponse.json()).runId;
      assert.deepEqual((await database.getSearch(ownerId, retryId))?.request.sources, [
        'greenhouse',
      ]);
      assert.equal((await database.getSearch(ownerId, search.id))?.status, 'partial');
      await database.cancelSearch(ownerId, retryId);
      await page.getByRole('combobox', { name: 'Discovery mode' }).selectOption('profile');
      assert.equal(await page.getByLabel('Role or technology').isDisabled(), true);
      const profileSubmitted = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/searches') && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const profileResponse = await profileSubmitted;
      assert.equal(profileResponse.status(), 202);
      const profileId = (await profileResponse.json()).runId;
      const profileRun = await database.getSearch(ownerId, profileId);
      assert.equal(profileRun?.request.useProfileTitles, true);
      assert.ok(profileRun?.matchingProfile?.preferences.titles.length);
      const profileProvider: JobProvider = {
        id: 'greenhouse',
        kind: 'ats',
        label: 'Greenhouse',
        unavailableReason: null,
        async *search(query) {
          assert.deepEqual(
            query.titles,
            [
              ...new Map(
                profileRun!.matchingProfile!.preferences.titles.map((title) => [
                  title.trim().replace(/\s+/g, ' ').toLowerCase(),
                  title.trim().replace(/\s+/g, ' '),
                ]),
              ).values(),
            ].slice(0, 5),
          );
          yield* [];
        },
      };
      const profileCollected = await collect(
        profileRun!.request,
        new AbortController().signal,
        profileProvider,
        undefined,
        { profile: profileRun!.matchingProfile },
      );
      const profileCommand = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === profileId,
      )!.command;
      const profileFence = await database.claim(profileCommand.id);
      assert.ok(profileFence);
      const profileTerminalRead = waitForSearchStatusResponse(profileId, 'partial');
      assert.equal(
        await database.completeCollection(
          profileCommand,
          profileFence,
          profileCollected.jobs,
          profileCollected.outcomes,
        ),
        true,
      );
      assert.equal((await profileTerminalRead).status(), 200);
      // The stubbed provider returns nothing, so the only source's outcome is
      // `empty`, and `collectionStatus()` (packages/core/src/jobs.ts) records
      // the run as `partial` — only an all-`completed` outcome set is
      // `completed`. The check is that the UI reflects the run's real
      // recorded status live, plus the genuine zero-result empty state.
      await page
        .getByRole('status')
        .filter({ hasText: /^partial$/ })
        .waitFor();
      await page.getByText('No jobs found', { exact: true }).waitFor();
      await page
        .getByText('This search returned no results. Try different keywords or sources.', {
          exact: true,
        })
        .waitFor();
      await settledSearchPage('empty search results');
      await page.reload();
      await page.getByRole('heading', { name: /^Saved target roles/ }).waitFor();
      for (const width of responsiveWidthsEndingAt(320)) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        if (engine === 'chromium')
          await page.screenshot({
            path: fileURLToPath(new URL(`../test-results/discovery-${width}.png`, import.meta.url)),
            fullPage: true,
          });
      }
      await page.getByRole('combobox', { name: 'Discovery mode' }).selectOption('query');
      assert.deepEqual(
        await page
          .getByRole('group', { name: 'Sources' })
          .getByRole('checkbox')
          .evaluateAll((checkboxes) =>
            checkboxes.map((checkbox) => ({
              label: checkbox.parentElement?.textContent?.trim(),
              disabled: (checkbox as HTMLInputElement).disabled,
            })),
          ),
        [
          { label: 'Greenhouse', disabled: false },
          { label: 'Lever', disabled: false },
          { label: 'Ashby', disabled: false },
          { label: 'Workable', disabled: false },
        ],
        `${engine} source selector diverges from the approved D14 source set`,
      );
      for (const source of ['Greenhouse', 'Lever', 'Ashby', 'Workable'])
        await page.getByRole('checkbox', { name: source, exact: true }).check();
      await page.getByLabel('Role or technology').fill('Four source acceptance');
      const fourSubmitted = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/searches') && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const fourResponse = await fourSubmitted;
      assert.equal(fourResponse.status(), 202);
      const fourId = (await fourResponse.json()).runId;
      const fourRun = await database.getSearch(ownerId, fourId);
      assert.equal(fourRun?.request.sources.length, 4);
      const fourCommand = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === fourId,
      )!.command;
      const fourFence = await database.claim(fourCommand.id);
      assert.ok(fourFence);
      const fourTerminalRead = waitForSearchStatusResponse(fourId, 'completed');
      assert.equal(
        await database.completeCollection(
          fourCommand,
          fourFence,
          [],
          fourRun!.request.sources.map((source) => ({
            source,
            status: 'completed',
            accepted: 0,
            limited: false,
            errorCode: null,
          })),
        ),
        true,
      );
      assert.equal((await fourTerminalRead).status(), 200);
      await page
        .getByRole('status')
        .filter({ hasText: /^completed$/ })
        .waitFor();
      await settledSearchPage('completed search');
      await page.reload();
      await page
        .getByRole('list', { name: 'Source outcomes' })
        .getByRole('listitem')
        .nth(3)
        .waitFor();
      assert.equal(
        await page.getByRole('list', { name: 'Source outcomes' }).getByRole('listitem').count(),
        4,
      );
      // ---------------------------------------------------------------
      // Forensic audit F-3: a link to a discovery run must open THAT run.
      // Several real runs exist for this owner by now, so "most recent" and
      // "the one asked for" are genuinely different records — without that
      // the check could not fail. `search.id` is the oldest ("React",
      // partial); `fourId` is the newest ("Four source acceptance").
      const runOrder = await page.request.get(`${origin}/api/searches`);
      assert.equal(runOrder.status(), 200);
      const runIds = (await runOrder.json()).items.map((item: { id: string }) => item.id);
      assert.equal(runIds[0], fourId, `${engine} fixture: newest run is not the four-source run`);
      assert.ok(
        runIds.indexOf(search.id) > 0,
        `${engine} fixture: the run used for the deep-link check must not be the newest one`,
      );
      const resultHeading = page.locator('.result-toolbar h2');
      // CS-75: api() now cancels unread non-OK response bodies, so the normal
      // request-settlement gate is valid for these deliberately refused IDs.
      await settled('run deep link');
      await page.goto(`${origin}/jobs?run=${search.id}`);
      await page.getByRole('heading', { name: 'Find Your Next Role', exact: true }).waitFor();
      await resultHeading.waitFor();
      assert.match(
        (await resultHeading.textContent()) ?? '',
        /^React/,
        `${engine} /jobs?run= opened a different run than the one named in the URL`,
      );
      await page.getByRole('heading', { name: 'Senior React Engineer', exact: true }).waitFor();
      assert.equal(
        await history.locator('[aria-current="true"] strong').textContent(),
        'React',
        `${engine} /jobs?run= does not mark the requested run as current`,
      );
      // Absent parameter: unchanged fallback to the most recent run.
      await settled('run deep link fallback');
      await page.goto(`${origin}/jobs`);
      await resultHeading.waitFor();
      assert.match(
        (await resultHeading.textContent()) ?? '',
        /^Four source acceptance/,
        `${engine} /jobs without ?run= no longer falls back to the most recent run`,
      );
      // Selecting a run keeps the URL in sync, and Back returns to the run
      // that was showing before — the view is genuinely linkable, not merely
      // readable from the URL once.
      await settled('run url sync');
      await page.goto(`${origin}/jobs?run=${search.id}`);
      await resultHeading.waitFor();
      await history
        .getByRole('button', { name: /^Four source acceptance/ })
        .first()
        .click();
      await page.waitForURL(`${origin}/jobs?run=${fourId}`);
      await page.waitForFunction(() =>
        document.querySelector('.result-toolbar h2')?.textContent?.startsWith('Four source'),
      );
      await page.goBack();
      await page.waitForURL(`${origin}/jobs?run=${search.id}`);
      await page.waitForFunction(() =>
        document.querySelector('.result-toolbar h2')?.textContent?.startsWith('React'),
      );
      // An id in the URL is untrusted input. Malformed, unknown and
      // another owner's run must each reach this view's real error state —
      // never a crash, a blank screen, or somebody else's results.
      for (const [label, runId, message] of [
        ['malformed', 'not-a-uuid', 'Check the fields and try again.'],
        ['unknown', randomUUID(), 'Request failed. Please try again.'],
        ['foreign-owner', foreignRun.id, 'Request failed. Please try again.'],
      ] as const) {
        await settled(`run ${label}`);
        await page.goto(`${origin}/jobs?run=${runId}`);
        await page.getByRole('heading', { name: 'Find Your Next Role', exact: true }).waitFor();
        await page.getByRole('alert').filter({ hasText: message }).first().waitFor();
        assert.equal(
          await resultHeading.count(),
          0,
          `${engine} /jobs?run=<${label}> rendered some other run's results`,
        );
        assert.equal(
          await page.getByText('Foreign Owner Secret Role', { exact: true }).count(),
          0,
          `${engine} /jobs?run=<${label}> exposed another owner's job data`,
        );
      }
      // The same, for the lead parameter on both screens that accept it.
      for (const [route, heading, label, leadParam, message] of [
        ['/saved', 'Saved Leads', 'malformed', 'not-a-uuid', 'Check the fields and try again.'],
        ['/saved', 'Saved Leads', 'unknown', randomUUID(), 'Request failed. Please try again.'],
        [
          '/applications',
          'Applications',
          'foreign-owner',
          foreignLead.id,
          'Request failed. Please try again.',
        ],
      ] as const) {
        await settled(`lead ${label}`);
        await page.goto(`${origin}${route}?lead=${leadParam}`);
        await page.getByRole('heading', { name: heading, exact: true }).waitFor();
        await page.getByRole('alert').filter({ hasText: message }).first().waitFor();
        assert.equal(
          await page.getByRole('article', { name: 'Lead details' }).count(),
          0,
          `${engine} ${route}?lead=<${label}> opened a lead it should not have`,
        );
        assert.equal(
          await page.getByText('Foreign Owner Secret Role', { exact: true }).count(),
          0,
          `${engine} ${route}?lead=<${label}> exposed another owner's lead`,
        );
      }
      await settled('deep link checks');
      await page.goto(`${origin}/dashboard`);
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
      // Dashboard "Recent Discovery" names the run it renders (F-3's other
      // half): each entry must link to its own run id, and following the
      // oldest one must open that run rather than the newest.
      //
      // The greeting heading is static, but Recent Discovery renders from an
      // async query, so reading hrefs straight after the heading can sample a
      // section that has not rendered its links yet — observed intermittently
      // on WebKit as `got ()`, an empty collection. Wait for the section's own
      // links first. This does NOT make the assertion unfalsifiable: if the
      // defect returns as a bare `/jobs` link the anchors still exist, the wait
      // still succeeds, and the assertion below fails with its real message. A
      // section that renders no links at all times out loudly, which is itself
      // a genuine failure rather than a silent pass.
      const discoverySection = page
        .locator('section', { has: page.getByRole('heading', { name: 'Recent Discovery' }) })
        .last();
      await discoverySection.locator('a').first().waitFor();
      const discoveryHrefs = await discoverySection
        .locator('a')
        .evaluateAll((elements) => elements.map((element) => element.getAttribute('href')));
      assert.ok(
        discoveryHrefs.includes(`/jobs?run=${fourId}`),
        `${engine} Recent Discovery does not link runs by id (got ${discoveryHrefs.join(', ')})`,
      );
      assert.equal(
        discoveryHrefs.filter((href) => href === '/jobs').length,
        0,
        `${engine} Recent Discovery still has an unqualified /jobs link`,
      );
      // ---------------------------------------------------------------
      // CS-13: the shared loading/empty/error treatment, exercised at the
      // three widths the acceptance criterion names (320, 768, 1440) in all
      // three engines. Every state asserted here is one this rollout changed,
      // so a regression fails the suite instead of being spotted on a
      // screenshot months later.
      //
      // Nothing is fabricated for the browser. The lead is put back into
      // "saved" through the same repository the rest of this file uses, so
      // the filtered-empty case has a real, known-non-empty sibling status to
      // name; the only interception is of this owner's own /api/leads list,
      // used to make a list genuinely empty on demand.
      const cs13Lead = await leadRepository.get(ownerId, leadId);
      assert.ok(cs13Lead, `${engine} CS-13 fixture: the saved lead no longer exists`);
      if (cs13Lead.status !== 'saved')
        assert.ok(
          await leadRepository.update(ownerId, leadId, {
            revision: cs13Lead.revision,
            notes: cs13Lead.notes,
            status: 'saved',
          }),
          `${engine} CS-13 fixture: could not put the lead back into "saved"`,
        );
      const leadListRequest = (url: URL) => url.pathname === '/api/leads';
      const archivedLeadListRequest = (url: URL) =>
        url.pathname === '/api/leads' && url.searchParams.get('status') === 'archived';
      const searchListRequest = (url: URL) => url.pathname === '/api/searches';
      const emptyLeadList = (route: import('playwright').Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: [], nextCursor: null }),
        });
      const failedSearchList = (route: import('playwright').Route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      const cs13NothingYet =
        'No leads with status “Saved” yet. Save a job from Search to add one here.';
      const cs13FilteredEmpty =
        'No leads with status “Archived”. That is this status filter only — “Saved” has leads; choose it above to see them.';
      for (const width of responsiveWidthsEndingAt(1440)) {
        await page.setViewportSize({ width, height: 900 });

        // AC3, "nothing yet": no status on this screen holds anything, so the
        // message must not claim another status does, and must name the one
        // action that populates the list.
        await page.route(leadListRequest, emptyLeadList);
        await page.goto(`${origin}/saved`);
        await page.getByRole('heading', { name: 'Saved Leads', exact: true }).waitFor();
        await page.getByText(cs13NothingYet, { exact: true }).waitFor();
        assert.equal(
          await page.getByText(cs13FilteredEmpty, { exact: true }).count(),
          0,
          `${engine} ${width}px: an unpopulated lead list claims a filter is hiding leads`,
        );
        // The paired positive for the assertion above: the "nothing yet" copy
        // must also DECLARE itself as nothing-yet, so a site cannot satisfy the
        // copy check while carrying the opposite machine-readable reason.
        assert.equal(
          await page.getByText(cs13NothingYet, { exact: true }).getAttribute('data-empty-reason'),
          'nothing-yet',
          `${engine} ${width}px: nothing-yet copy carries the wrong data-empty-reason`,
        );
        await page.unroute(leadListRequest, emptyLeadList);

        // AC3, "nothing matches your filters": the same list, same width, but
        // the Saved status really does hold a lead — so the empty Archived tab
        // must read differently and say which status has them.
        await page.route(archivedLeadListRequest, emptyLeadList);
        await page.goto(`${origin}/saved`);
        await page
          .getByRole('navigation', { name: 'Saved lead list' })
          .getByRole('button', { name: /Senior React Engineer/ })
          .waitFor();
        const archivedTab = page
          .getByRole('group', { name: 'Lead status' })
          .getByRole('button', { name: 'Archived', exact: true });
        await archivedTab.click();
        const pressedDeadline = Date.now() + 5000;
        while (Date.now() < pressedDeadline) {
          if ((await archivedTab.getAttribute('aria-pressed')) === 'true') break;
          await page.waitForTimeout(25);
        }
        assert.equal(
          await archivedTab.getAttribute('aria-pressed'),
          'true',
          `${engine} ${width}px: Archived tab did not become selected`,
        );
        await page.getByText(cs13FilteredEmpty, { exact: true }).waitFor();
        assert.equal(
          await page.getByText(cs13NothingYet, { exact: true }).count(),
          0,
          `${engine} ${width}px: a filtered-empty lead list shows the "nothing yet" message`,
        );
        // CS-62: the machine-readable reason must agree with the words. The
        // two assertions above check the COPY; without this one the
        // discriminator could say 'nothing-yet' while the text correctly says
        // the opposite, and nothing would notice - which is the prose-versus-
        // type gap CS-62 exists to close, reintroduced one level down.
        assert.equal(
          await page
            .getByText(cs13FilteredEmpty, { exact: true })
            .getAttribute('data-empty-reason'),
          'filtered',
          `${engine} ${width}px: filtered-empty copy carries the wrong data-empty-reason`,
        );
        await page.unroute(archivedLeadListRequest, emptyLeadList);

        // AC2: an error state names what failed and offers the next action in
        // the same live region — never a bare message.
        await page.route(searchListRequest, failedSearchList);
        await page.goto(`${origin}/dashboard`);
        const discoveryError = page
          .getByRole('alert')
          .filter({ hasText: 'Could not load your recent searches.' });
        await discoveryError.waitFor();
        assert.equal(
          await discoveryError.getByRole('button', { name: 'Retry' }).count(),
          1,
          `${engine} ${width}px: the Recent Discovery error offers no next action`,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${engine} ${width}px: a dashboard error state forces horizontal scrolling`,
        );
        await page.unroute(searchListRequest, failedSearchList);
      }
      await page.setViewportSize({ width: 1440, height: 900 });

      // CS-38 AC3: the dashboard must distinguish a capped page from a
      // complete list, and a stale value must change only after the owner's
      // explicit refresh. The response is synthetic but uses the real API
      // shape and the real dashboard query; the handler assertion prevents a
      // route mismatch from turning this into a vacuous UI check.
      let dashboardSavedResponses = 0;
      let dashboardSavedVersion = 0;
      const dashboardSavedRequest = (url: URL) =>
        url.pathname === '/api/leads' && url.searchParams.get('status') === 'saved';
      await page.route(dashboardSavedRequest, async (route) => {
        dashboardSavedResponses += 1;
        const paginated = dashboardSavedVersion === 0;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              {
                id: randomUUID(),
                data: {
                  title: paginated ? 'Paged saved job' : 'Complete saved job',
                  company: 'Fixture Co',
                },
                createdAt: '2026-09-28T12:00:00.000Z',
              },
              ...(paginated
                ? []
                : [
                    {
                      id: randomUUID(),
                      data: { title: 'Second saved job', company: 'Fixture Co' },
                      createdAt: '2026-09-28T11:00:00.000Z',
                    },
                  ]),
            ],
            nextCursor: paginated ? 'fixture-next-cursor' : null,
          }),
        });
      });
      await page.goto(`${origin}/dashboard`);
      const dashboardSavedCount = page.getByTestId('dashboard-saved-count');
      await dashboardSavedCount.waitFor();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="dashboard-saved-count"]')?.textContent === '1+',
      );
      assert.equal(
        await dashboardSavedCount.textContent(),
        '1+',
        `${engine}: paginated dashboard count was presented as an exact total`,
      );
      assert.ok(dashboardSavedResponses > 0, `${engine}: CS-38 saved-leads fixture was never used`);
      assert.equal(
        await dashboardSavedCount.textContent(),
        '1+',
        `${engine}: stale dashboard value changed without an explicit refresh`,
      );
      dashboardSavedVersion = 1;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="dashboard-saved-count"]')?.textContent === '2',
      );
      assert.equal(
        await dashboardSavedCount.textContent(),
        '2',
        `${engine}: complete dashboard count did not replace the stale paginated value`,
      );
      await page.unroute(dashboardSavedRequest);

      // A read mutation can finish after the authenticated shell unmounts.
      // Its continuation must not start a notification GET for the departed
      // owner. Hold the successful PUT response across sign-out and count any
      // notification reads issued after the shell has disappeared.
      await settled('notifications before read fixture reset');
      await database.pool.query(
        `UPDATE in_app_notifications
         SET read_at = NULL
         WHERE owner_id = $1 AND round_id = $2`,
        [ownerId, createdRound.id],
      );
      const signoutNotificationToggle = page.locator('summary[aria-label^="Notifications"]');
      const notificationPanelWasOpen = await signoutNotificationToggle.evaluate(
        (summary) =>
          summary.parentElement instanceof HTMLDetailsElement && summary.parentElement.open,
      );
      if (notificationPanelWasOpen) await signoutNotificationToggle.click();
      assert.equal(
        await signoutNotificationToggle.evaluate(
          (summary) =>
            summary.parentElement instanceof HTMLDetailsElement && summary.parentElement.open,
        ),
        false,
        `${engine}: notification fixture must begin with the panel closed`,
      );
      const unreadNotificationsResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/notifications') && response.request().method() === 'GET',
      );
      await signoutNotificationToggle.click();
      assert.equal((await unreadNotificationsResponse).status(), 200);
      await page
        .getByRole('region', { name: 'Notifications' })
        .getByRole('button', {
          name: 'Mark as read',
        })
        .waitFor();
      await settled('notification visible before unmount regression');
      let notificationGetsDuringUnmountRegression = 0;
      const countNotificationReads = (request: import('playwright').Request) => {
        if (
          request.method() === 'GET' &&
          new URL(request.url()).pathname === '/api/notifications'
        ) {
          notificationGetsDuringUnmountRegression += 1;
        }
      };
      page.on('request', countNotificationReads);
      let releaseNotificationMutation!: () => void;
      let resolveNotificationMutationFetched!: () => void;
      let rejectNotificationMutationFetched!: (error: Error) => void;
      const notificationMutationGate = new Promise<void>((resolve) => {
        releaseNotificationMutation = resolve;
      });
      const notificationMutationFetched = new Promise<void>((resolve, reject) => {
        resolveNotificationMutationFetched = resolve;
        rejectNotificationMutationFetched = reject;
      });
      const holdNotificationMutation = async (route: import('playwright').Route) => {
        if (route.request().method() !== 'PUT') return route.fallback();
        try {
          await route.fetch({ timeout: 15000 }).then((response) => {
            assert.equal(response.status(), 204);
          });
          resolveNotificationMutationFetched();
          await notificationMutationGate;
          await route.fulfill({ status: 204, body: '' });
        } catch (error) {
          rejectNotificationMutationFetched(
            error instanceof Error ? error : new Error('Could not complete the held read mutation'),
          );
          throw error;
        }
      };
      try {
        await page.route('**/api/notifications/*/read', holdNotificationMutation);
        const markReadResponse = page.waitForResponse(
          (response) => response.url().endsWith('/read') && response.request().method() === 'PUT',
        );
        await page
          .getByRole('region', { name: 'Notifications' })
          .getByRole('button', {
            name: 'Mark as read',
          })
          .click();
        await notificationMutationFetched;
        page.once('dialog', (dialog) => dialog.accept());
        await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        await page.getByRole('heading', { name: 'Select test account', exact: true }).waitFor();
        const readsAtUnmount = notificationGetsDuringUnmountRegression;
        releaseNotificationMutation();
        assert.equal((await markReadResponse).status(), 204);
        await settled('post-unmount notification mutation continuation');
        assert.equal(
          notificationGetsDuringUnmountRegression,
          readsAtUnmount,
          `${engine}: a completed read mutation started a notification GET after shell unmount`,
        );
      } finally {
        releaseNotificationMutation();
        page.off('request', countNotificationReads);
        await page.unroute('**/api/notifications/*/read', holdNotificationMutation);
      }

      // CS-36 AC2: "Define and test a shared reset policy ... so old requests
      // or caches cannot restore prior-session data". Verify the actual
      // production logout reset with a second account that has distinct,
      // seeded profile data. Drain the dashboard's exact search-detail read
      // before navigating away, so the check observes it rather than having
      // the general stale-route filter classify it as irrelevant.
      //
      // The foreign owner is a real account with its own run, job and lead,
      // created at the top of this file, so this also re-proves owner
      // isolation across a session boundary rather than only within one.
      const searchDetailRequests = () =>
        [...inflight.keys()].filter((request) => {
          const url = new URL(request.url());
          return request.method() === 'GET' && /^\/api\/searches\/[^/]+$/.test(url.pathname);
        });
      const searchRequestDeadline = Date.now() + 15000;
      while (searchDetailRequests().length > 0 && Date.now() < searchRequestDeadline) {
        await page.waitForTimeout(25);
      }
      assert.equal(
        searchDetailRequests().length,
        0,
        `${engine}: owner-A search detail request remained in flight before account change: ${searchDetailRequests()
          .map((request) => `${request.url()} (responseEnd=${request.timing().responseEnd})`)
          .join(', ')}`,
      );
      await page.goto(`${origin}/settings`);
      await page.getByRole('heading', { name: 'Account security', exact: true }).waitFor();
      // The shared topbar's sign-out confirms first (authenticated-shell.tsx).
      await selectFixtureAccount('foreign-owner@example.test', password);
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();

      // Each route asserts a POSITIVE anchor belonging to the NEW owner
      // before asserting the absence of the old one. Without that, every
      // `count() === 0` below would pass vacuously on a page that simply had
      // not rendered yet — the precise shape of check-that-cannot-fail this
      // suite keeps finding. `quiet()` is deliberately not used here: /jobs
      // polls /api/searches every 5s unconditionally (see CS-55), so it never
      // goes quiet and the helper would time out on a healthy page.
      for (const [route, navLabel, heading, anchor] of [
        ['/jobs', 'Jobs', 'Find Your Next Role', 'Foreign Owner Secret Query'],
        ['/saved', 'Saved', 'Saved Leads', 'Foreign Owner Secret Role'],
        ['/applications', 'Applications', 'Applications', 'No leads with status'],
        ['/resume', 'Resume', 'Candidate Profile', 'No resumes uploaded.'],
        ['/preparation', 'Preparation', 'Resume & Interview Prep', 'Saved profile revision'],
      ] as const) {
        await page.getByRole('link', { name: navLabel, exact: true }).first().click();
        await page.waitForURL(`**${route}`);
        await page.getByRole('heading', { name: heading, exact: true }).waitFor();
        await page.getByText(anchor, { exact: false }).first().waitFor();
        for (const secret of [
          'React Engineer',
          'Senior React Engineer',
          `Private synthetic ${engine} notes`,
          'Synthetic Candidate',
        ]) {
          assert.equal(
            await page.getByText(secret, { exact: true }).count(),
            0,
            `${engine} ${route} showed the previous session's "${secret}" after sign-out`,
          );
        }
      }

      // CS-36 AC2, the assertion that is actually load-bearing. The loop
      // above is near-decorative and the review said so precisely: three of
      // its four secrets live in form controls, which `getByText` cannot see
      // at all, and the fourth sits on a surface whose refetch has already
      // replaced the stale value by the time its anchor resolves.
      //
      // The profile is different in kind. `profile-editor.tsx:397-400` uses
      // `queryKey: ['profile']` with `staleTime: Infinity` and
      // `refetchOnWindowFocus: false`, and that key carries NO owner. So a
      // surviving cache is not a flash here — the previous owner's profile
      // would persist INDEFINITELY for the next owner, with no refetch to
      // correct it. `.inputValue()` is the matcher this file already uses on
      // this exact field at :1772, :1833 and :1859.
      //
      // The name asserted is the one the IMMEDIATELY PRECEDING session held
      // (:1843), not an older one from a session already cleared at :1265 —
      // asserting a stale-by-two-boundaries value would be vacuous. Wait for
      // this owner's distinct positive value before checking owner A is absent.
      await page.getByRole('link', { name: 'Resume', exact: true }).first().click();
      await page.waitForURL('**/resume');
      await page.getByRole('heading', { name: 'Candidate Profile', exact: true }).waitFor();
      await page.getByLabel('Full Name', { exact: true }).waitFor({ state: 'visible' });
      assert.notEqual(
        await page.getByLabel('Full Name', { exact: true }).inputValue(),
        'Updated In Another Session',
        `${engine} /resume restored the previous session's profile from cache`,
      );
      assert.equal(
        await page.getByLabel('Full Name', { exact: true }).inputValue(),
        'Foreign Owner Candidate',
        `${engine} /resume did not load the foreign owner's distinct profile`,
      );
      assert.deepEqual(
        errors.filter((error) => !expectedAuthenticatedJourneyConsoleErrors.has(error)),
        [],
        `${engine} authenticated UI journey produced unexpected browser runtime errors\n${recentRequestEvents.slice(-20).join('\n')}`,
      );
      if (warningDiagnostics) {
        const correlation = observedWarnings.map((warning) => ({
          category: warning.category,
          paths: warning.paths,
          locationPath: warning.locationPath,
          pagePath: warning.pagePath,
          candidateRequests: [...diagnosticRequests.values()]
            .filter(
              (request) => request.epoch === warning.epoch && warning.paths.includes(request.path),
            )
            .map((request) => {
              const nearestEventDeltaMs = Math.min(
                ...request.events.map((event) => Math.abs(event.at - warning.at)),
              );
              return {
                id: request.id,
                method: request.method,
                path: request.path,
                resourceType: request.resourceType,
                isNavigation: request.isNavigation,
                pagePath: request.pagePath,
                samePageRoute: request.pagePath === warning.pagePath,
                correlatedWithin10s: nearestEventDeltaMs <= 10000,
                nearestEventDeltaMs,
                events: request.events.map((event) => event.kind),
              };
            }),
        }));
        process.stdout.write(`Firefox warning diagnostic: ${JSON.stringify(correlation)}\n`);
      }
      assert.deepEqual(
        await unhandledRejections(page),
        [],
        `${engine} authenticated UI journey produced an unhandled promise rejection`,
      );
      // Let in-flight network handlers settle before disposing the browser
      // context. Closing Chromium with a `route.fetch()` callback still active
      // can reject against Playwright's already-disposed request context.
      await page.unrouteAll({ behavior: 'wait' });
      process.stdout.write(
        `${engine}: search/export/cancellation, saved leads/notes/archive/conflicts, profile, logout, required responsive-width checks passed\n`,
      );
    } finally {
      await browser.close();
    }
  }
  // Exercise the actual executable test-access contract without the legacy
  // password-fixture routes above. No network responses are replaced here.
  await app.close();
  const testApp = await createApp(database, origin, async () => true, {
    testAccess: { mode: 'local' },
  });
  try {
    await testApp.listen({ host: '127.0.0.1', port: 5390 });
    for (const [engine, browserType] of notificationLifecycleOnly ? [] : uiBrowsers) {
      const browser = await browserType.launch();
      try {
        const page = await browser.newPage();
        await installUnhandledRejectionGuard(page);
        const runtimeErrors: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error') {
            runtimeErrors.push(browserConsoleErrorKind(message));
          }
        });
        page.on('pageerror', () => runtimeErrors.push('uncaught page exception'));
        page.on('crash', () => runtimeErrors.push('page crashed'));
        const consoleSentinel = page.waitForEvent(
          'console',
          (message) =>
            message.type() === 'error' && message.text() === 'careerscope-runtime-guard-sentinel',
        );
        await page.evaluate(() => console.error('careerscope-runtime-guard-sentinel'));
        await consoleSentinel;
        assert.deepEqual(runtimeErrors, ['synthetic console sentinel']);
        runtimeErrors.length = 0;
        await page.goto(origin);
        await page.getByRole('heading', { name: 'Select test account', exact: true }).waitFor();
        assert.equal(await page.locator('input[type="password"]').count(), 0);
        assert.equal(
          await page.getByRole('button', { name: 'Create account', exact: true }).count(),
          0,
        );
        for (const user of testUsers) {
          assert.equal(await page.getByRole('button').filter({ hasText: user.email }).count(), 1);
        }
        await accessible(page, engine, 'real test selector', 'Select test account');
        for (const width of responsiveWidthsEndingAt(1440)) {
          await page.setViewportSize({ width, height: 900 });
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
        }
        let previousOwner: string | undefined;
        for (const user of testUsers) {
          const button = page.getByRole('button').filter({ hasText: user.email });
          await button.focus();
          await button.press('Enter');
          await page.waitForURL('**/dashboard');
          const session = await (await page.request.get(`${origin}/api/session`)).json();
          assert.equal(session.email, user.email);
          assert.equal(session.testUser, user.role);
          if (previousOwner) assert.notEqual(session.owner, previousOwner);
          previousOwner = session.owner;
          await accessible(
            page,
            engine,
            `${user.role} dashboard`,
            /^Good (morning|afternoon|evening)!$/,
          );
          await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
          await page.waitForURL('**/settings');
          await page.getByRole('heading', { name: 'Account security', exact: true }).waitFor();
          assert.equal(await page.locator('input[type="password"]').count(), 0);
          await accessible(page, engine, `${user.role} test settings`, 'Account security');
          page.once('dialog', (dialog) => dialog.accept());
          await page.getByRole('button', { name: 'Sign out', exact: true }).click();
          await page.getByRole('heading', { name: 'Select test account', exact: true }).waitFor();
          assert.equal(
            (await (await page.request.get(`${origin}/api/session`)).json()).authenticated,
            false,
          );
        }
        assert.deepEqual(
          await unhandledRejections(page),
          [],
          `${engine} test-account selector produced an unhandled promise rejection`,
        );
        assert.deepEqual(
          runtimeErrors,
          [],
          `${engine} test selector journey produced runtime errors`,
        );
        process.stdout.write(
          `${engine}: real two-account selector, session switching, keyboard, eight-width reflow and axe passed\n`,
        );
      } finally {
        await browser.close();
      }
    }
  } finally {
    await testApp.close();
  }
} finally {
  if (filesWorker && filesWorker.exitCode === null && filesWorker.signalCode === null) {
    const closed = once(filesWorker, 'close');
    filesWorker.kill('SIGKILL');
    await closed;
  }
  await filesQueue.destroy().catch(() => {});
  await filesQueue.close();
  resumeStorage.close();
  await app.close();
  await database.close();
  await admin.pool.query(`DROP DATABASE "${name}"`);
  await admin.close();
  await rm(resumeDirectory, { recursive: true, force: true });
}
