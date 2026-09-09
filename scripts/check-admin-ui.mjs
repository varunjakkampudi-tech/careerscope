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
      status: index === 59 ? 'applied' : index % 2 ? 'saved' : 'new',
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
  'version.js',
  ...['list', 'search', 'briefcase', 'settings', 'user', 'globe', 'lock', 'refresh'].map(
    (name) => `icon-${name}.svg`,
  ),
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
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.clock.install();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/admin.html`);
  const release = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(await page.locator('[data-app-version]').textContent(), `v${release.version}`);
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
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('React');
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
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  assert.equal(await page.evaluate(() => sessionStorage.length), 1);
  assert.equal(
    await page.evaluate((secret) => JSON.stringify(sessionStorage).includes(secret), passphrase),
    false,
  );
  await page.reload();
  await page.getByRole('table', { name: 'My leads' }).waitFor();
  assert.equal(await page.locator('#rows [role=row]').count(), 50);
  await page.getByRole('link', { name: 'Search', exact: true }).click();
  await page.getByRole('heading', { name: 'Search jobs' }).waitFor();
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('React');
  assert.equal(await page.locator('#rows [role=row]').count(), 1);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('link', { name: 'Applications', exact: true }).click();
  await page.getByRole('table', { name: 'Applications', exact: true }).waitFor();
  assert.equal(await page.locator('#rows [role=row]').count(), 1);
  assert.match(await page.locator('#rows').textContent(), /Engineer 59/);
  await page.getByRole('link', { name: 'Profile', exact: true }).click();
  await page.locator('#profile-view').waitFor();
  assert.equal(await page.locator('#profile-resume').textContent(), 'Attached');
  await page.reload();
  await page.locator('#profile-view').waitFor();
  assert.equal(await page.locator('#profile-leads').textContent(), '60');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.locator('#settings-view').waitFor();
  await page.getByLabel('Appearance').selectOption('dark');
  assert.equal(await page.locator('#theme').inputValue(), 'dark');
  await page.getByLabel('Appearance').selectOption('light');
  for (const selected of ['leads', 'search', 'applications', 'settings', 'profile']) {
    await page.locator(`[data-view="${selected}"]`).click();
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({ path: `/tmp/careerscope-${selected}-${width}.png` });
    }
  }
  const otherTab = await page.context().newPage();
  await otherTab.goto(`http://127.0.0.1:${server.address().port}/admin.html`);
  assert.equal(await otherTab.locator('#workspace').isVisible(), false);
  await otherTab.close();
  await page.getByRole('link', { name: 'Leads', exact: true }).click();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  assert.equal(await page.locator('#rows [role=row]').count(), 0);
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#leads-title').textContent(), 'My leads');
  assert.equal(await page.locator('#threshold-count').textContent(), '');
  assert.equal(await page.getByLabel('Snapshot passphrase').inputValue(), '');
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  await page.getByLabel('Snapshot passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByRole('table', { name: 'My leads' }).waitFor();
  await page.clock.fastForward(310000);
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#rows [role=row]').count(), 0);
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  await page.getByLabel('Snapshot passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByRole('table', { name: 'My leads' }).waitFor();
  await page.evaluate(() => {
    const saved = JSON.parse(sessionStorage.getItem('careerscope.admin.session'));
    saved.lastActivity = Date.now() - 310000;
    sessionStorage.setItem('careerscope.admin.session', JSON.stringify(saved));
  });
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#unlock').disabled);
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  await page.getByLabel('Snapshot passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByRole('table', { name: 'My leads' }).waitFor();
  const replaced = await encryptSnapshot({ leads: [] }, passphrase);
  await page.route('**/admin.enc.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(replaced) }),
  );
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#unlock').disabled);
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  await page.unroute('**/admin.enc.json');
  const blocked = await browser.newPage();
  blocked.on('pageerror', (error) => errors.push(error.message));
  await blocked.addInitScript(() =>
    Object.defineProperty(window, 'sessionStorage', {
      get() {
        throw new Error('Storage blocked');
      },
    }),
  );
  await blocked.goto(`http://127.0.0.1:${server.address().port}/admin.html`);
  await blocked.getByLabel('Snapshot passphrase').fill(passphrase);
  await blocked.getByRole('button', { name: 'Unlock', exact: true }).click();
  await blocked.getByRole('table', { name: 'My leads' }).waitFor();
  await blocked.reload();
  await blocked.waitForFunction(() => !document.querySelector('#unlock').disabled);
  assert.equal(await blocked.locator('#workspace').isVisible(), false);
  await blocked.close();
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Admin browser checks passed: wrong password, unlock, refresh session, filters, pagination, safe DOM, lock, desktop/mobile.\n',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
