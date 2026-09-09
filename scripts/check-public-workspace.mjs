import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { pageFiles } from './stage-pages.mjs';

const jobs = [
  {
    title: 'React engineer',
    company: 'Zen',
    location: 'India',
    source: 'lever',
    postedAt: '2026-09-09T10:00:00Z',
    url: 'https://jobs.lever.co/one',
  },
  {
    title: 'Frontend engineer',
    company: 'Acme',
    location: 'Remote',
    source: 'ashby',
    postedAt: '2026-09-07T10:00:00Z',
    url: 'https://jobs.ashbyhq.com/two',
  },
  {
    title: 'React lead',
    company: 'Beta',
    location: 'India',
    source: 'lever',
    postedAt: null,
    url: 'https://jobs.lever.co/three',
  },
];
const server = createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (name === 'jobs.json') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ updatedAt: '2026-09-09T12:00:00Z', jobs }));
  } else if (pageFiles.includes(name) && name !== 'admin.enc.json') {
    response.setHeader(
      'Content-Type',
      name.endsWith('.html')
        ? 'text/html'
        : name.endsWith('.css')
          ? 'text/css'
          : name.endsWith('.svg')
            ? 'image/svg+xml'
            : 'text/javascript',
    );
    response.end(await readFile(new URL(`../mobile-site/${name}`, import.meta.url)));
  } else response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date('2026-09-09T12:00:00Z'));
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base);
      await page.locator('#jobs li').first().waitFor();
      assert.equal(await page.locator('#jobs li').count(), 3);
      await page.getByLabel('Posted', { exact: true }).selectOption('1');
      assert.equal(await page.locator('#jobs li').count(), 1);
      await page.getByRole('button', { name: 'Save React engineer at Zen', exact: true }).click();
      await page.getByRole('button', { name: /^Saved / }).click();
      await page.reload();
      await page.locator('#jobs li').first().waitFor();
      assert.equal(await page.locator('#jobs li').count(), 1);
      assert.equal(await page.locator('#posted').inputValue(), '1');
      assert.equal(await page.locator('#saved-jobs').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.save-job').getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await page.getByRole('button', { name: 'All jobs', exact: true }).click();
      await page.getByLabel('Sort', { exact: true }).selectOption('company');
      assert.deepEqual(await page.locator('#jobs .company').allTextContents(), [
        'Acme',
        'Beta',
        'Zen',
      ]);
      for (const theme of ['light', 'dark']) {
        await page.locator('#theme').selectOption(theme);
        for (const width of [320, 390, 768, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          assert.equal(await page.evaluate(() => innerWidth), width);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
          await page.screenshot({ path: `/tmp/careerscope-v2-${name}-${theme}-${width}.png` });
        }
      }
      await page.getByRole('button', { name: /^Saved / }).click();
      await page.route('**/jobs.json', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ updatedAt: '2026-09-09T12:00:00Z', jobs: jobs.slice(1) }),
        }),
      );
      await page.getByRole('button', { name: 'Refresh jobs', exact: true }).click();
      await page.locator('#saved-unavailable').waitFor();
      assert.equal(await page.locator('#jobs li').count(), 0);
      assert.match(await page.locator('#saved-unavailable').textContent(), /1 saved posting/);
      await page.unroute('**/jobs.json');
      await page.getByRole('button', { name: 'Refresh jobs', exact: true }).click();
      await page.locator('#jobs li').first().waitFor();
      await page.getByRole('button', { name: 'Clear saved jobs', exact: true }).click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await page.locator('#jobs li').count(), 1);
      await page.getByRole('button', { name: 'Clear saved jobs', exact: true }).click();
      await page.locator('#confirm-clear').click();
      assert.equal(await page.locator('#jobs li').count(), 0);
      assert.deepEqual(
        await page.evaluate(() => JSON.parse(localStorage.getItem('careerscope.public.saved.v1'))),
        [],
      );
      assert.deepEqual(errors, []);
      const blocked = await browser.newPage();
      await blocked.addInitScript(() =>
        Object.defineProperty(window, 'localStorage', {
          get() {
            throw new Error('Blocked');
          },
        }),
      );
      await blocked.goto(base);
      await blocked.locator('#jobs li').first().waitFor();
      await blocked.locator('.save-job').first().click();
      assert.equal(await blocked.locator('#storage-error').isVisible(), true);
      await blocked.locator('#saved-jobs').click();
      assert.equal(await blocked.locator('#jobs li').count(), 1);
      await blocked.close();
      process.stdout.write(
        `${name}: public filters, saved jobs, refresh, clear confirmation, blocked storage and responsive screenshots passed.\n`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
