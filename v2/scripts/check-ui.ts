import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  Database,
  passwordHash,
  users,
  ProfileRepository,
  LeadRepository,
  matchingProfile,
  writableProfileSchema,
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
const app = await createApp(database, origin, async () => true);
try {
  await migrate(database.db, {
    migrationsFolder: new URL('../migrations', import.meta.url).pathname,
  });
  await database.db
    .insert(users)
    .values({ id: ownerId, email: 'ui@example.test', passwordHash: await passwordHash(password) });
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
  assert.equal(scored.length, 1);
  await database.complete(command, fence, [
    {
      fingerprint: 'browser-fixture',
      title: 'Senior React Engineer',
      company: 'Example Technology',
      location: 'Remote',
      description: 'Build accessible interfaces using React and TypeScript.',
      source: 'himalayas',
      sourceUrl: 'https://himalayas.app/jobs/synthetic',
      applyUrl: 'https://example.test/apply',
      postedAt: null,
    },
    ...scored,
  ]);
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await app.listen({ host: '127.0.0.1', port: 5390 });
  for (const [engine, browserType] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await browserType.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin);
      await page.getByLabel('Email', { exact: true }).fill('ui@example.test');
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page
        .getByRole('navigation', { name: 'Search history' })
        .getByRole('button', { name: /^React/ })
        .click();
      await page.getByRole('heading', { name: 'Senior React Engineer' }).waitFor();
      const resultResponse = await page.request.get(`${origin}/api/searches/${search.id}`);
      assert.equal(resultResponse.status(), 200);
      const resultBody = await resultResponse.json();
      assert.equal(resultBody.jobs[0].data.title, 'Scored React Engineer');
      assert.equal(resultBody.jobs[1].data.match, null);
      await page.getByText('Not scored', { exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Scored React Engineer', exact: true }).click();
      await page.getByRole('region', { name: 'Match evidence' }).waitFor();
      await page.getByText('Limited Description', { exact: true }).waitFor();
      await page.getByText('Do Not Apply', { exact: true }).waitFor();
      await page.getByText('Senior React Engineer', { exact: true }).click();
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
            path: new URL(`../test-results/workspace-${width}.png`, import.meta.url).pathname,
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
      assert.deepEqual(Object.keys(exported).sort(), ['jobs', 'request', 'runId', 'schemaVersion']);
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
        .getByRole('button', { name: /^React/ })
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
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const submission = await submitted;
      assert.equal(submission.status(), 202);
      const submittedId = (await submission.json()).runId;
      assert.deepEqual((await database.getSearch(ownerId, submittedId))?.request.sources, [
        'himalayas',
        'remoteok',
      ]);
      await page.getByText('Search in progress', { exact: true }).waitFor();
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
            path: new URL(`../test-results/cancel-${width}.png`, import.meta.url).pathname,
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
        .getByRole('button', { name: /^React/ })
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
      const notes = page.getByRole('textbox', { name: 'Notes', exact: true });
      await notes.fill(`Private synthetic ${engine} notes`);
      page.once('dialog', (dialog) => dialog.dismiss());
      await page.getByRole('button', { name: 'Back to search', exact: true }).click();
      assert.equal(await notes.inputValue(), `Private synthetic ${engine} notes`);
      const notesSaved = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/leads/${leadId}`) && response.request().method() === 'PUT',
      );
      await page.getByRole('button', { name: 'Save Notes', exact: true }).click();
      assert.equal((await notesSaved).status(), 200);
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
            path: new URL(`../test-results/leads-${width}.png`, import.meta.url).pathname,
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
      await page.getByRole('button', { name: 'Save Profile', exact: true }).click();
      await page.getByText('Profile saved.', { exact: true }).waitFor();
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
            path: new URL(`../test-results/profile-${width}.png`, import.meta.url).pathname,
            fullPage: true,
          });
      }
      await page.getByRole('button', { name: 'Back to Search', exact: true }).click();
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
  await app.close();
  await database.close();
  await admin.pool.query(`DROP DATABASE "${name}"`);
  await admin.close();
}
