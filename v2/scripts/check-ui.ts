import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  Auth,
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
} from '@careerscope/core';
import { createApp } from '../apps/api/src/app.js';
import { collect } from '../apps/workers/search/src/collect.js';
import { createRemoteOkProvider } from '../../packages/providers/dist/index.js';

const configured = process.env.DATABASE_URL;
assert.ok(configured);
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
const filesQueue = new LocalQueue(process.env.LOCAL_AWS_ENDPOINT!);
const filesQueueName = `test-files-${randomUUID()}`;
let filesWorker: ReturnType<typeof spawn> | undefined;
const app = await createApp(database, origin, async () => true, {
  registrationEnabled: true,
  resumeStorage,
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
      stdio: ['ignore', 'pipe', 'ignore'],
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
      if (String(chunk).includes('v2 isolated files worker ready')) {
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
    { query: 'React', sources: ['remoteok'] },
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
      errorCode: 'source_failed' as const,
    },
  ];
  await database.completeCollection(
    command,
    fence,
    [
      {
        fingerprint: 'browser-fixture',
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
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await app.listen({ host: '127.0.0.1', port: 5390 });
  const axeSource = await readFile(
    fileURLToPath(new URL('../node_modules/axe-core/axe.min.js', import.meta.url)),
    'utf8',
  );
  /** Fails on any WCAG 2.1 A/AA violation at the given widths. */
  const accessible = async (page: import('playwright').Page, engine: string, view: string) => {
    for (const width of [320, 1440]) {
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
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
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
  for (const [engine, browserType] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await browserType.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin);
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
      await page.getByRole('button', { name: 'Create an account', exact: true }).click();
      await page.getByRole('heading', { name: 'Create account', exact: true }).waitFor();
      await accessible(page, engine, 'create account');
      for (const width of [1440, 390, 320]) {
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
      const accountEmail = `signup-${engine}@example.test`;
      await page.getByLabel('Email', { exact: true }).fill(accountEmail);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page
        .getByLabel('Confirm password', { exact: true })
        .fill('different-synthetic-password');
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Passwords do not match.' }).waitFor();
      assert.equal(
        await page
          .getByLabel('Confirm password', { exact: true })
          .evaluate((element) => element === document.activeElement),
        true,
      );
      await page.getByLabel('Confirm password', { exact: true }).fill(password);
      await page.route(
        '**/api/register',
        (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
        { times: 1 },
      );
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Request failed.' }).waitFor();
      assert.equal(await page.getByLabel('Password', { exact: true }).inputValue(), '');
      assert.equal(await page.getByLabel('Confirm password', { exact: true }).inputValue(), '');
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByLabel('Confirm password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'You can now try signing in' }).waitFor();
      await page.getByLabel('Email', { exact: true }).fill(accountEmail);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByText('No searches yet.', { exact: true }).waitFor();
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
      // Every workspace destination must be reachable and operable by keyboard alone.
      const reachable: string[] = [];
      for (let step = 0; step < 40 && reachable.length < 5; step += 1) {
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => {
          const element = document.activeElement;
          if (!element || !element.closest('nav[aria-label="Career workspace"]')) return null;
          return element.textContent?.trim() ?? '';
        });
        if (focused && !reachable.includes(focused)) reachable.push(focused);
      }
      assert.deepEqual(
        reachable,
        ['Dashboard', 'Discovery', 'Leads', 'Preparation', 'Career Links'],
        `${engine} workspace navigation is not fully keyboard reachable`,
      );
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Career Links', exact: true }).waitFor();
      const workspaceNav = page.getByRole('navigation', { name: 'Career workspace', exact: true });
      await workspaceNav.getByRole('button', { name: 'Preparation', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Save a profile to prepare' }).waitFor();
      await workspaceNav.getByRole('button', { name: 'Dashboard', exact: true }).click();
      await page.getByRole('heading', { name: 'Your Next Chapter', exact: true }).waitFor();
      await accessible(page, engine, 'dashboard');
      for (const width of [320, 390, 1440]) {
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
      await workspaceNav.getByRole('button', { name: 'Career Links', exact: true }).click();
      await page.getByLabel('Find resources', { exact: true }).fill('MDN');
      assert.equal(await page.locator('.resource-list a').count(), 1);
      assert.equal(
        await page.getByRole('link', { name: 'MDN Web Docs' }).getAttribute('href'),
        'https://developer.mozilla.org/',
      );
      await page.getByLabel('Find resources', { exact: true }).fill('no-such-resource');
      await page.getByRole('status').filter({ hasText: 'No resources found.' }).waitFor();
      await page.getByLabel('Find resources', { exact: true }).fill('');
      await accessible(page, engine, 'career links');
      for (const width of [320, 1440]) {
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
      await workspaceNav.getByRole('button', { name: 'Discovery', exact: true }).click();
      assert.equal(
        await page.getByRole('navigation', { name: 'Search history' }).getByRole('button').count(),
        0,
      );
      await page.getByRole('button', { name: 'Candidate profile', exact: true }).click();
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
        if (route.request().method() !== 'POST') return route.continue();
        await route.fulfill({
          status: 507,
          contentType: 'application/json',
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
      for (const width of [1440, 390, 320]) {
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
      await page.locator('textarea[name="titles"]').fill('React Engineer');
      await page.getByRole('button', { name: 'Save Profile', exact: true }).click();
      await page.getByText('Profile saved.', { exact: true }).waitFor();
      const reviewed = await new ProfileRepository(database).get(account.rows[0]!.id);
      assert.ok(reviewed?.profile.preferences.techStack.includes('React'));
      await workspaceNav.getByRole('button', { name: 'Preparation', exact: true }).click();
      await page.getByRole('heading', { name: 'Interview Practice', exact: true }).waitFor();
      await accessible(page, engine, 'preparation');
      await page
        .getByText(
          `Rules-based review | AI inference off | Saved profile revision ${reviewed.revision}`,
          { exact: true },
        )
        .waitFor();
      assert.ok((await page.locator('.preparation-evidence').count()) > 0);
      for (const width of [320, 390, 1440]) {
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
      await page.getByRole('alert').filter({ hasText: 'Request failed.' }).waitFor();
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByRole('heading', { name: 'Interview Practice', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
      await page.getByRole('button', { name: 'Delete resume', exact: true }).waitFor();
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Delete resume', exact: true }).click();
      await page.getByText('No resumes uploaded.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Back to Search', exact: true }).click();
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
      await page.getByRole('button', { name: 'Account security', exact: true }).click();
      await page.getByRole('heading', { name: 'Account security', exact: true }).waitFor();
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
          await page.getByRole('button', { name: 'Change password', exact: true }).isDisabled(),
          true,
        );
        assert.equal(
          await page.getByRole('button', { name: 'Back to search', exact: true }).isDisabled(),
          true,
        );
      } finally {
        releaseRevocation();
      }
      await page
        .getByRole('alert')
        .filter({ hasText: 'Request failed. Please try again.' })
        .waitFor();
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
      const passwordSession = await securityAuth.login(accountEmail, password);
      assert.ok(passwordSession);
      for (const width of [1440, 390, 320]) {
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
      const changedPassword = randomUUID();
      await page.getByLabel('Current password', { exact: true }).fill(password);
      await page.getByLabel('New password', { exact: true }).fill(changedPassword);
      await page.getByLabel('Confirm new password', { exact: true }).fill(randomUUID());
      await page.getByRole('button', { name: 'Change password', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Passwords do not match.' }).waitFor();
      assert.equal(
        await page
          .getByLabel('Confirm new password', { exact: true })
          .evaluate((element) => element === document.activeElement),
        true,
      );
      await page.getByLabel('Confirm new password', { exact: true }).fill(changedPassword);
      page.once('dialog', (dialog) => dialog.dismiss());
      await page.getByRole('button', { name: 'Change password', exact: true }).click();
      assert.ok(await securityAuth.session(passwordSession));
      let releaseFailure!: () => void;
      const failureGate = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
      await page.route(
        '**/api/account/password',
        async (route) => {
          await failureGate;
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Synthetic internal password_hash detail' }),
          });
        },
        { times: 1 },
      );
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Change password', exact: true }).click();
      try {
        const pendingButton = page.getByRole('button', { name: 'Changing password', exact: true });
        await pendingButton.waitFor();
        assert.equal(await pendingButton.isDisabled(), true);
        assert.equal(await page.getByLabel('Current password', { exact: true }).isDisabled(), true);
      } finally {
        releaseFailure();
      }
      await page
        .getByRole('alert')
        .filter({ hasText: 'Request failed. Please try again.' })
        .waitFor();
      assert.equal(
        await page.getByText('Synthetic internal password_hash detail', { exact: true }).count(),
        0,
      );
      for (const label of ['Current password', 'New password', 'Confirm new password']) {
        const input = page.getByLabel(label, { exact: true });
        assert.equal(await input.inputValue(), '');
        assert.equal(await input.getAttribute('aria-describedby'), 'security-error');
      }
      assert.ok(await securityAuth.session(passwordSession));
      await page.getByLabel('Current password', { exact: true }).fill(password);
      await page.getByLabel('New password', { exact: true }).fill(changedPassword);
      await page.getByLabel('Confirm new password', { exact: true }).fill(changedPassword);
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Change password', exact: true }).click();
      await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
      await page
        .getByRole('status')
        .filter({ hasText: 'Password changed. All sessions signed out.' })
        .waitFor();
      assert.equal(await securityAuth.session(passwordSession), null);
      assert.equal(await page.getByLabel('Password', { exact: true }).inputValue(), '');
      await page.getByLabel('Email', { exact: true }).fill(accountEmail);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Invalid email or password.' }).waitFor();
      await page.getByLabel('Password', { exact: true }).fill(changedPassword);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('button', { name: 'Account security', exact: true }).waitFor();
      assert.equal(
        (await new ProfileRepository(database).get(account.rows[0]!.id))?.revision,
        reviewed.revision,
      );
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
      await page.getByLabel('Email', { exact: true }).fill('ui@example.test');
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page
        .getByRole('navigation', { name: 'Search history' })
        .getByRole('button', { name: /^React.*partial/s })
        .click();
      await page.getByRole('heading', { name: 'Senior React Engineer' }).waitFor();
      for (const source of ['Greenhouse', 'Lever', 'Workable']) {
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
        .getByText('Himalayas: 1 accepted; source failed', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Retry failed sources', exact: true }).isEnabled(),
        true,
      );
      assert.equal(resultBody.jobs[0].data.title, 'Scored React Engineer');
      assert.equal(resultBody.jobs[1].data.match, null);
      await page.getByText('Not scored', { exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Scored React Engineer', exact: true }).click();
      await page.getByRole('region', { name: 'Match evidence' }).waitFor();
      await page.getByText('Limited Description', { exact: true }).waitFor();
      await page.getByText('Do Not Apply', { exact: true }).waitFor();
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
      for (const width of [1440, 390, 320]) {
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
      await page.getByRole('heading', { name: 'No Matching Jobs' }).waitFor();
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
      await page
        .getByRole('alert')
        .getByText('Request failed. Please try again.', { exact: true })
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
        .getByText('Request failed. Please try again.', { exact: true })
        .waitFor({ state: 'hidden' });
      await page.route(
        '**/api/searches/*/export',
        (route) =>
          route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Authentication required' }),
          }),
        { times: 1 },
      );
      await exportButton.click();
      await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
      await page.getByLabel('Email', { exact: true }).fill('ui@example.test');
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page
        .getByRole('navigation', { name: 'Search history' })
        .getByRole('button', { name: /^React.*partial/s })
        .click();
      await page.getByLabel('Filter results').fill('');
      await page.getByLabel('Role or technology').fill('TypeScript');
      await page.getByRole('checkbox', { name: 'Remote OK', exact: true }).uncheck();
      assert.equal(
        await page.getByRole('button', { name: 'Search', exact: true }).isDisabled(),
        true,
      );
      await page.getByRole('checkbox', { name: 'Himalayas', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Remote OK', exact: true }).check();
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
        'himalayas',
        'remoteok',
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
      for (const width of [1440, 390, 320]) {
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
      await page.getByText('Request failed. Please try again.', { exact: true }).waitFor();
      await page.getByText('Search in progress', { exact: true }).waitFor();
      assert.equal(await cancellation.isEnabled(), true);
      page.once('dialog', (dialog) => dialog.accept());
      await cancellation.click();
      await page
        .getByRole('status')
        .filter({ hasText: /^cancelled$/ })
        .waitFor();
      assert.equal(await cancellation.count(), 0);
      await page.reload();
      await page
        .getByLabel('Search sources', { exact: true })
        .getByText('Himalayas + Remote OK', { exact: true })
        .waitFor();
      await page
        .getByRole('status')
        .filter({ hasText: /^cancelled$/ })
        .waitFor();
      for (const width of [1440, 390, 320]) {
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
      await savedJob.getByText('Request failed. Please try again.', { exact: true }).waitFor();
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
      assert.equal(
        await page
          .getByRole('article', { name: 'Lead details' })
          .getByRole('link', { name: 'Remote OK', exact: true })
          .getAttribute('href'),
        'https://remoteok.com/remote-jobs/synthetic',
      );
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
      await (await refreshedLeads).finished();
      await (await refreshedHistory).finished();
      await page
        .getByRole('button', { name: 'Save Notes', exact: true })
        .and(page.locator(':disabled'))
        .waitFor();
      await page.reload();
      await page.getByRole('button', { name: 'Saved Leads', exact: true }).click();
      await page
        .getByRole('navigation', { name: 'Saved lead list' })
        .getByRole('button', { name: /Senior React Engineer/ })
        .click();
      await notes.waitFor();
      assert.equal(await notes.inputValue(), `Private synthetic ${engine} notes`);
      const leadRepository = new LeadRepository(database);
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
        .getByText('This record changed in another session. Your edits have not been saved.', {
          exact: true,
        })
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
      page.once('dialog', (dialog) => dialog.dismiss());
      await page.getByRole('button', { name: 'Archive Lead', exact: true }).click();
      assert.equal((await leadRepository.get(ownerId, leadId))?.status, 'saved');
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Archive Lead', exact: true }).click();
      await page.getByRole('button', { name: 'Restore Lead', exact: true }).waitFor();
      await page
        .getByRole('group', { name: 'Lead status' })
        .getByRole('button', { name: 'Archived', exact: true })
        .click();
      await page
        .getByRole('navigation', { name: 'Saved lead list' })
        .getByRole('button', { name: /Senior React Engineer/ })
        .click();
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Restore Lead', exact: true }).click();
      await page.getByRole('button', { name: 'Archive Lead', exact: true }).waitFor();
      assert.equal((await leadRepository.get(ownerId, leadId))?.status, 'saved');
      for (const width of [1440, 390, 320]) {
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
      await page.getByRole('button', { name: 'Candidate profile', exact: true }).click();
      await page.getByLabel('Full Name', { exact: true }).fill('Example Candidate');
      await page.getByLabel('Email', { exact: true }).fill('candidate@example.test');
      await page.getByLabel('Location', { exact: true }).fill('Hyderabad');
      await page.getByRole('textbox', { name: 'Target Roles', exact: true }).fill('React Engineer');
      await page.getByRole('textbox', { name: 'Skills', exact: true }).fill('React\nTypeScript');
      await page.getByLabel('Years of Experience', { exact: true }).fill('4');
      for (const target of [
        page.getByRole('button', { name: 'Sign out', exact: true }),
        page.getByRole('link', { name: /CareerScope/ }),
      ]) {
        let warned = false;
        page.once('dialog', async (dialog) => {
          warned = true;
          await dialog.dismiss();
        });
        await target.click();
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
      assert.equal(
        await page.evaluate(() => {
          const event = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        }),
        false,
        `${engine}: saved profile must release unload guard`,
      );
      await page.reload();
      await page.getByRole('button', { name: 'Candidate profile', exact: true }).click();
      await page.getByLabel('Full Name', { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel('Full Name', { exact: true }).inputValue(),
        'Example Candidate',
      );
      const profiles = new ProfileRepository(database);
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
        .getByText('This record changed in another session. Your edits have not been saved.', {
          exact: true,
        })
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
      for (const width of [1440, 390, 320]) {
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
      await page.getByRole('button', { name: 'Back to Search', exact: true }).click();
      await page
        .getByRole('navigation', { name: 'Search history' })
        .getByRole('button', { name: /^React.*partial/s })
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
        'himalayas',
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
      const profileCollected = await collect(
        profileRun!.request,
        new AbortController().signal,
        {
          ...createRemoteOkProvider(),
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
        },
        undefined,
        { profile: profileRun!.matchingProfile },
      );
      const profileCommand = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === profileId,
      )!.command;
      const profileFence = await database.claim(profileCommand.id);
      assert.ok(profileFence);
      assert.equal(
        await database.completeCollection(
          profileCommand,
          profileFence,
          profileCollected.jobs,
          profileCollected.outcomes,
        ),
        true,
      );
      await page
        .getByRole('status')
        .filter({ hasText: /^completed$/ })
        .waitFor();
      await page.reload();
      await page.getByRole('heading', { name: /^Saved target roles/ }).waitFor();
      for (const width of [1440, 390, 320]) {
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
      for (const source of ['Remote OK', 'Himalayas', 'Greenhouse', 'Lever', 'Workable'])
        await page.getByRole('checkbox', { name: source, exact: true }).check();
      await page.getByLabel('Role or technology').fill('Five source acceptance');
      const fiveSubmitted = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/searches') && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const fiveResponse = await fiveSubmitted;
      assert.equal(fiveResponse.status(), 202);
      const fiveId = (await fiveResponse.json()).runId;
      const fiveRun = await database.getSearch(ownerId, fiveId);
      assert.equal(fiveRun?.request.sources.length, 5);
      const fiveCommand = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === fiveId,
      )!.command;
      const fiveFence = await database.claim(fiveCommand.id);
      assert.ok(fiveFence);
      assert.equal(
        await database.completeCollection(
          fiveCommand,
          fiveFence,
          [],
          fiveRun!.request.sources.map((source) => ({
            source,
            status: 'completed',
            accepted: 0,
            limited: false,
            errorCode: null,
          })),
        ),
        true,
      );
      await page
        .getByRole('status')
        .filter({ hasText: /^completed$/ })
        .waitFor();
      await page.reload();
      await page
        .getByRole('list', { name: 'Source outcomes' })
        .getByRole('listitem')
        .nth(4)
        .waitFor();
      assert.equal(
        await page.getByRole('list', { name: 'Source outcomes' }).getByRole('listitem').count(),
        5,
      );
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
      assert.deepEqual(errors, []);
      console.log(
        `${engine}: search/export/cancellation, saved leads/notes/archive/conflicts, profile, logout, 320/390/1440px passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  if (filesWorker && filesWorker.exitCode === null && filesWorker.signalCode === null) {
    const closed = once(filesWorker, 'close');
    filesWorker.kill('SIGKILL');
    await closed;
  }
  for (const QueueUrl of [filesQueue.url, filesQueue.deadLetterUrl].filter(Boolean)) {
    await filesQueue.client.send(new DeleteQueueCommand({ QueueUrl }));
  }
  filesQueue.close();
  resumeStorage.close();
  await app.close();
  await database.close();
  await admin.pool.query(`DROP DATABASE "${name}"`);
  await admin.close();
  await rm(resumeDirectory, { recursive: true, force: true });
}
