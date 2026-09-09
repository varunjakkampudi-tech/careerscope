import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { encryptSnapshot } from '../mobile-site/snapshot-crypto.mjs';

const passphrase = 'synthetic-browser-test-only';
const envelope = await encryptSnapshot(
  {
    version: 1,
    updatedAt: '2026-09-09T00:00:00Z',
    profile: { updatedAt: '2026-09-09T00:00:00Z', hasResume: true },
    leads: Array.from({ length: 60 }, (_, index) => ({
      title: index === 0 ? '<img src=x onerror=alert(1)> React engineer' : `Engineer ${index}`,
      company: 'Example',
      location: 'India',
      source: index % 2 ? 'lever' : 'linkedin',
      score: index % 2 ? 0.6 : 0.95,
      status: index % 2 ? 'saved' : 'new',
      postedAt: null,
      url: index === 0 ? 'javascript:alert(1)' : 'https://www.linkedin.com/jobs/view/123',
    })),
  },
  passphrase,
);
const files = new Set([
  'admin.html',
  'admin.js',
  'admin.css',
  'style.css',
  'theme.js',
  'select-chevron.svg',
  'snapshot-crypto.mjs',
  'favicon.svg',
]);
const server = createServer(async (request, response) => {
  const name = request.url.slice(1);
  if (name === 'admin.enc.json') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(envelope));
    return;
  }
  if (!files.has(name)) {
    response.writeHead(404).end();
    return;
  }
  const type = name.endsWith('.html')
    ? 'text/html'
    : name.endsWith('.css')
      ? 'text/css'
      : name.endsWith('.svg')
        ? 'image/svg+xml'
        : 'text/javascript';
  response.setHeader('Content-Type', type);
  response.end(await readFile(fileURLToPath(new URL(`../mobile-site/${name}`, import.meta.url))));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.clock.install();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/admin.html`);
  await page.getByLabel('Snapshot passphrase').fill('incorrect');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByRole('alert').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#workspace').isVisible(), false);
  await page.getByLabel('Snapshot passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByRole('table', { name: 'My leads' }).waitFor();
  assert.equal(await page.locator('#rows [role=row]').count(), 50);
  assert.deepEqual(await page.getByRole('columnheader').allTextContents(), [
    'Match',
    'Role',
    'Company',
    'Location',
    'Source',
    'Posted',
    'Status',
  ]);
  assert.equal(await page.getByRole('meter').count(), 50);
  assert.equal(await page.locator('#threshold-count').textContent(), '60 at or above 0%');
  assert.equal(await page.locator('#rows img, #rows a[href^="javascript:"]').count(), 0);
  await page.getByRole('button', { name: 'Load more' }).click();
  assert.equal(await page.locator('#rows [role=row]').count(), 60);
  await page.getByLabel('linkedin', { exact: true }).check();
  assert.equal(await page.locator('#rows [role=row]').count(), 30);
  await page.getByLabel('lever', { exact: true }).check();
  assert.equal(await page.locator('#rows [role=row]').count(), 50);
  await page.getByLabel('Search', { exact: true }).fill('React');
  assert.equal(await page.locator('#rows [role=row]').count(), 1);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.locator('#score').fill('85');
  assert.equal(await page.locator('#rows [role=row]').count(), 30);
  await page.locator('#status').selectOption('saved');
  assert.equal(await page.locator('#rows [role=row]').count(), 0);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: `/tmp/careerscope-admin-${width}.png` });
  }
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  assert.equal(await page.locator('#rows [role=row]').count(), 0);
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#leads-title').textContent(), 'My leads');
  assert.equal(await page.locator('#threshold-count').textContent(), '');
  assert.equal(await page.getByLabel('Snapshot passphrase').inputValue(), '');
  await page.getByLabel('Snapshot passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByRole('table', { name: 'My leads' }).waitFor();
  await page.clock.fastForward(310000);
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#rows [role=row]').count(), 0);
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Admin browser checks passed: wrong password, unlock, filters, pagination, safe DOM, lock, no storage, desktop/mobile.\n',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
