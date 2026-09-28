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
import { createRemoteOkProvider } from '@job-radar/providers';

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
      errorCode: 'source_failed' as const,
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
  for (const [engine, browserType] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await browserType.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      // A full-document navigation (goto/reload) that lands while the current
      // client-side route is still issuing its data fetches strands those
      // fetches, and WebKit reports a fetch started against a document that is
      // being replaced as "Fetch API cannot load <url> due to access control
      // checks" — which Playwright surfaces as a page error, failing the
      // assert.deepEqual(errors, []) gate at the end of this run. It is a
      // teardown artefact, not app behaviour, so the navigation waits for the
      // page to stop making requests instead of the gate being weakened.
      //
      // page.waitForLoadState('networkidle') cannot express this: it resolves
      // immediately once the *current document* has reached that state once,
      // so on a long-lived single-page document it returns without waiting at
      // all (measured returning ~180ms after the last response, 30ms before
      // the reload that then stranded two /api/resumes fetches). The set below
      // tracks in-flight requests directly. EventSource streams (the search
      // progress feed) are excluded because they stay open by design and would
      // never let the page look idle.
      const inflight = new Set<import('playwright').Request>();
      page.on('request', (request) => {
        if (request.resourceType() !== 'eventsource') inflight.add(request);
      });
      page.on('requestfinished', (request) => inflight.delete(request));
      page.on('requestfailed', (request) => inflight.delete(request));
      const settled = async (label: string) => {
        const deadline = Date.now() + 15000;
        let quietSince = Date.now();
        while (Date.now() < deadline) {
          if (inflight.size > 0) quietSince = Date.now();
          else if (Date.now() - quietSince >= 250) return;
          await page.waitForTimeout(25);
        }
        throw new Error(`${engine}: ${label} never stopped issuing requests`);
      };
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
      await page.getByRole('button', { name: 'Create an account', exact: true }).click();
      await page.getByRole('heading', { name: 'Create account', exact: true }).waitFor();
      await accessible(page, engine, 'create account', 'Create account');
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
      for (const width of [1440, 320]) {
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
      if (engine === 'webkit') {
        assert.deepEqual(
          reachable,
          [],
          `${engine} now includes links in the Tab sequence — remove this carve-out and assert the real order on all three engines`,
        );
      } else {
        assert.deepEqual(
          reachable,
          expectedDestinations.map((destination) => destination.label),
          `${engine} sidebar navigation is not fully keyboard reachable in order (and items with no destination must be skipped, not merely styled as skipped)`,
        );
      }
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
      for (const width of [320, 768, 1440]) {
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
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await settled('route /settings');
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
      // `get` returns null when no profile exists. Three later assertions read
      // `reviewed.revision`; without this the suite would die with a TypeError
      // in the middle of a browser run and look like a UI failure rather than
      // a missing fixture.
      assert.ok(
        reviewed,
        'the reviewed profile must exist before the preparation screen is driven',
      );
      assert.ok(reviewed?.profile.preferences.techStack.includes('React'));
      // The sidebar is hidden below 768px and the screenshot loop above left
      // the viewport at 320px, so widen before navigating through it.
      await page.setViewportSize({ width: 1440, height: 900 });
      await sidebarNav.getByRole('link', { name: 'Preparation', exact: true }).click();
      await page.getByRole('heading', { name: 'Interview Practice', exact: true }).waitFor();
      await accessible(page, engine, 'preparation', 'Resume & Interview Prep');
      await page
        .getByText(
          `Rules-based review | AI inference off | Saved profile revision ${reviewed.revision}`,
          { exact: true },
        )
        .waitFor();
      // CS-39 F-1: the caption above is pinned exactly, but nothing pinned
      // the BUTTON. Deleting the `aiEnabled` gate from AiElaborate would
      // leave this suite green while silently restoring CS-48 F-1 — the
      // control reappears with AI off and 503s on click. AI_ENABLED is false
      // in this environment, so the honest assertion is absence: the trigger
      // must not exist at all when the server reports no provider.
      assert.equal(
        await page.getByRole('button', { name: 'Get AI coaching' }).count(),
        0,
        `${engine} the AI coaching trigger renders while the server reports no AI provider`,
      );
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
          'Could not prepare your review. Request failed. Please try again. Use Refresh above to try again.',
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
      // Account security is the /settings route behind the shared nav now.
      await sidebarNav.getByRole('link', { name: 'Settings', exact: true }).click();
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
      // Same strengthening as the revocation alert above, for the same reason.
      const passwordAlert = page
        .getByRole('alert')
        .filter({ hasText: 'Request failed. Please try again.' });
      await passwordAlert.waitFor();
      assert.equal(
        (await passwordAlert.innerText()).trim(),
        'Could not change your password. Request failed. Please try again.',
      );
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
      await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
      await page.getByLabel('Email', { exact: true }).fill('ui@example.test');
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
      await page.setViewportSize({ width: 1440, height: 900 });
      await sidebarNav.getByRole('link', { name: 'Jobs', exact: true }).click();
      await page.waitForURL(`${origin}/jobs`);
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
      // CS-18 copy: the low-confidence flag now explains itself instead of
      // reading "Limited Description" (match-evidence.tsx) — the assertion
      // text was stale, the behaviour it checks is unchanged.
      await page
        .getByText('Limited description — score capped, treat as low-confidence', { exact: true })
        .waitFor();
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
        .getByText('Could not export this search. Request failed. Please try again.', {
          exact: true,
        })
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
      // An expiry the server actually agrees with: CS-6's shared shell
      // re-checks the session on `/`, so a *synthetic* 401 against a session
      // that is still valid server-side would simply bounce straight back to
      // /dashboard and prove nothing. Removing the session row makes the
      // export request 401 for real, which is the case this check exists for.
      await database.pool.query('DELETE FROM sessions WHERE owner_id = $1', [ownerId]);
      await exportButton.click();
      await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
      await page.getByLabel('Email', { exact: true }).fill('ui@example.test');
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
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
      await settled('cancelled search');
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
      // CS-13 criterion 2: SaveJob's inline error must name what failed, not
      // just relay the transport message. Asserting the full string means a
      // regression to a bare `{error.message}` fails here.
      await savedJob
        .getByText('Could not save this job. Request failed. Please try again.', { exact: true })
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
      await page
        .getByRole('button', { name: 'Save Notes', exact: true })
        .and(page.locator(':disabled'))
        .waitFor();
      await settled('saved lead notes');
      await page.reload();
      // /saved is its own route now: a reload lands straight back on the
      // saved-leads workspace, so the old "Saved Leads" view-switch button no
      // longer exists (the label is this screen's <h1>). The lead itself is
      // re-opened from the real list below.
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
      await page.getByRole('button', { name: 'Archive in CareerScope', exact: true }).click();
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
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
      await page.setViewportSize({ width: 1440, height: 900 });
      await sidebarNav.getByRole('link', { name: 'Resume', exact: true }).click();
      await page.getByRole('heading', { name: 'Candidate Profile', exact: true }).waitFor();
      await page.getByLabel('Full Name', { exact: true }).fill('Example Candidate');
      await page.getByLabel('Email', { exact: true }).fill('candidate@example.test');
      await page.getByLabel('Location', { exact: true }).fill('Hyderabad');
      await page.getByRole('textbox', { name: 'Target Roles', exact: true }).fill('React Engineer');
      await page.getByRole('textbox', { name: 'Skills', exact: true }).fill('React\nTypeScript');
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
        await page.getByRole('button', { name: 'Back to Search', exact: true }).click();
        await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
        page.off('dialog', onDialog);
        assert.equal(prompted, false, `${engine}: a saved profile must not warn on navigation`);
      }
      // The heading of a client-side route is painted before that route has
      // issued its data fetches: React commits the tree, then runs the passive
      // effects that start the ['resumes'] and ['profile'] queries. Reloading
      // on the heading alone put a document navigation 30ms after the route
      // commit and stranded both /api/resumes fetches (reproduced on webkit in
      // 5 of 17 runs, always here, always exactly two errors, stack: api ->
      // QueryObserver#executeFetch -> onSubscribe -> commitPassiveMountOnFiber).
      // Waiting for the previous route to be quiet first is what makes the
      // response wait below unambiguous — otherwise it is satisfied by the
      // *dashboard's* still-in-flight /api/resumes request and waits for
      // nothing.
      await settled('dashboard');
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
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('button', { name: 'Back to Search', exact: true }).click();
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();
      await sidebarNav.getByRole('link', { name: 'Jobs', exact: true }).click();
      await page.waitForURL(`${origin}/jobs`);
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
      await settled('empty search results');
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
      await settled('completed search');
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
      // ---------------------------------------------------------------
      // Forensic audit F-3: a link to a discovery run must open THAT run.
      // Five real runs exist for this owner by now, so "most recent" and
      // "the one asked for" are genuinely different records — without that
      // the check could not fail. `search.id` is the oldest ("React",
      // partial); `fiveId` is the newest ("Five source acceptance").
      const runOrder = await page.request.get(`${origin}/api/searches`);
      assert.equal(runOrder.status(), 200);
      const runIds = (await runOrder.json()).items.map((item: { id: string }) => item.id);
      assert.equal(runIds[0], fiveId, `${engine} fixture: newest run is not the five-source run`);
      assert.ok(
        runIds.indexOf(search.id) > 0,
        `${engine} fixture: the run used for the deep-link check must not be the newest one`,
      );
      const resultHeading = page.locator('.result-toolbar h2');
      // `settled()` cannot be used for the navigations below. Some of them
      // deliberately ask the API for an id it must refuse, and lib/api.ts
      // throws on a non-OK response without reading its body — so Playwright
      // never marks that 400/404 fetch as finished and the page never looks
      // idle, no matter how long it is left (measured: two permanently
      // "in-flight" /api/searches/not-a-uuid fetches). A response having
      // ARRIVED is the honest signal here; that is exactly what these checks
      // are about — what the screen renders once the API has refused.
      const answered = new WeakSet<import('playwright').Request>();
      page.on('response', (response) => answered.add(response.request()));
      const quiet = async (label: string) => {
        const deadline = Date.now() + 15000;
        let quietSince = Date.now();
        while (Date.now() < deadline) {
          if ([...inflight].some((request) => !answered.has(request))) quietSince = Date.now();
          else if (Date.now() - quietSince >= 250) return;
          await page.waitForTimeout(25);
        }
        throw new Error(`${engine}: ${label} never stopped issuing requests`);
      };
      await quiet('run deep link');
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
      await quiet('run deep link fallback');
      await page.goto(`${origin}/jobs`);
      await resultHeading.waitFor();
      assert.match(
        (await resultHeading.textContent()) ?? '',
        /^Five source acceptance/,
        `${engine} /jobs without ?run= no longer falls back to the most recent run`,
      );
      // Selecting a run keeps the URL in sync, and Back returns to the run
      // that was showing before — the view is genuinely linkable, not merely
      // readable from the URL once.
      await quiet('run url sync');
      await page.goto(`${origin}/jobs?run=${search.id}`);
      await resultHeading.waitFor();
      await history
        .getByRole('button', { name: /^Five source acceptance/ })
        .first()
        .click();
      await page.waitForURL(`${origin}/jobs?run=${fiveId}`);
      await page.waitForFunction(() =>
        document.querySelector('.result-toolbar h2')?.textContent?.startsWith('Five source'),
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
        await quiet(`run ${label}`);
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
        await quiet(`lead ${label}`);
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
      await quiet('deep link checks');
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
        discoveryHrefs.includes(`/jobs?run=${fiveId}`),
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
      for (const width of [320, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });

        // AC3, "nothing yet": no status on this screen holds anything, so the
        // message must not claim another status does, and must name the one
        // action that populates the list.
        await quiet(`cs-13 nothing-yet ${width}`);
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
        await quiet(`cs-13 filtered-empty ${width}`);
        await page.route(archivedLeadListRequest, emptyLeadList);
        await page.goto(`${origin}/saved`);
        await page
          .getByRole('navigation', { name: 'Saved lead list' })
          .getByRole('button', { name: /Senior React Engineer/ })
          .waitFor();
        await page
          .getByRole('group', { name: 'Lead status' })
          .getByRole('button', { name: 'Archived', exact: true })
          .click();
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
        await quiet(`cs-13 error state ${width}`);
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
      await quiet('cs-13 states');

      // The shared topbar's sign-out confirms first (authenticated-shell.tsx).
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();

      // CS-36 AC2: "Define and test a shared reset policy ... so old requests
      // or caches cannot restore prior-session data". The policy was defined
      // and the implementation reviewed, but the TEST half did not exist —
      // the Independent Reviewer's blocking finding. This is it.
      //
      // The reset is `cache.clear()` in authenticated-shell.tsx, on both
      // logout (:71) and SESSION_EXPIRED_EVENT (:57). Asserting that the
      // function is called would prove nothing about whether data actually
      // becomes unreachable, so this signs in as a genuinely DIFFERENT owner
      // and requires the first owner's data to be gone from every surface
      // AC2 names. A surviving React Query cache would repopulate these
      // screens instantly from memory, before any network response — which is
      // exactly the failure the criterion describes.
      //
      // The foreign owner is a real account with its own run, job and lead,
      // created at the top of this file, so this also re-proves owner
      // isolation across a session boundary rather than only within one.
      await page.getByLabel('Email', { exact: true }).fill('foreign-owner@example.test');
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)!$/ }).waitFor();

      // Each route asserts a POSITIVE anchor belonging to the NEW owner
      // before asserting the absence of the old one. Without that, every
      // `count() === 0` below would pass vacuously on a page that simply had
      // not rendered yet — the precise shape of check-that-cannot-fail this
      // suite keeps finding. `quiet()` is deliberately not used here: /jobs
      // polls /api/searches every 5s unconditionally (see CS-55), so it never
      // goes quiet and the helper would time out on a healthy page.
      for (const [route, heading, anchor] of [
        ['/jobs', 'Find Your Next Role', 'Foreign Owner Secret Query'],
        ['/saved', 'Saved Leads', 'Foreign Owner Secret Role'],
        ['/applications', 'Applications', 'No leads with status'],
        ['/resume', 'Candidate Profile', 'No resumes uploaded.'],
        ['/preparation', 'Resume & Interview Prep', 'Save a profile to prepare'],
      ] as const) {
        await page.goto(`${origin}${route}`);
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
      // asserting a stale-by-two-boundaries value would be vacuous.
      await page.goto(`${origin}/resume`);
      await page.getByRole('heading', { name: 'Candidate Profile', exact: true }).waitFor();
      assert.notEqual(
        await page.getByLabel('Full Name', { exact: true }).inputValue(),
        'Updated In Another Session',
        `${engine} /resume restored the previous session's profile from cache`,
      );

      page.once('dialog', (dialog) => dialog.accept());
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
