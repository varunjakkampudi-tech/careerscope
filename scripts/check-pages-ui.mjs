import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import process from 'node:process';
import { chromium, firefox, webkit } from 'playwright';
import { encryptSnapshot } from '../mobile-site/snapshot-crypto.mjs';
import { pageFiles, stagePages } from './stage-pages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'test-results/pages');
const baseline = join(root, 'test-results/pages-baseline');
const update = process.argv.includes('--update-baselines');
await mkdir(output, { recursive: true });
await mkdir(baseline, { recursive: true });
const passphrase = 'synthetic-visual-fixture-only';
const leads = Array.from({ length: 65 }, (_, index) => ({
  title:
    index === 0
      ? 'Senior React Engineer - Platform and Accessibility'
      : `Software Engineer ${index}`,
  company: index === 0 ? 'International Software Research and Development' : 'Example Technologies',
  location: 'India / Remote',
  source: index % 2 ? 'lever' : 'linkedin',
  score: index % 2 ? 0.65 : 0.95,
  status: index % 2 ? 'saved' : 'new',
  postedAt: '2026-09-09T00:00:00Z',
  url: `https://www.linkedin.com/jobs/view/${1000 + index}/`,
}));
const publicSnapshot = {
  updatedAt: '2026-09-09T00:00:00Z',
  jobs: leads.map(({ title, company, location, source, postedAt, url }) => ({
    title,
    company,
    location,
    source,
    postedAt,
    url,
  })),
};
const envelope = await encryptSnapshot(
  {
    version: 1,
    updatedAt: publicSnapshot.updatedAt,
    profile: { updatedAt: publicSnapshot.updatedAt, hasResume: true },
    leads,
  },
  passphrase,
);
const fixtureSource = join(output, 'fixture');
await mkdir(fixtureSource, { recursive: true });
for (const name of pageFiles) {
  const content =
    name === 'jobs.json'
      ? JSON.stringify(publicSnapshot)
      : name === 'admin.enc.json'
        ? JSON.stringify(envelope)
        : await readFile(join(root, 'mobile-site', name));
  await writeFile(join(fixtureSource, name), content);
}
const staged = join(output, `staged-${Date.now()}`);
await stagePages(fixtureSource, staged);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const name = path === '/careerscope/' ? 'index.html' : path.replace(/^\/careerscope\//, '');
  if (!pageFiles.includes(name)) {
    response.writeHead(404).end();
    return;
  }
  const type = name.endsWith('.html')
    ? 'text/html'
    : name.endsWith('.css')
      ? 'text/css'
      : name.endsWith('.svg')
        ? 'image/svg+xml'
        : name.endsWith('.json')
          ? 'application/json'
          : name.endsWith('.xml')
            ? 'application/xml'
            : name.endsWith('.txt')
              ? 'text/plain'
              : 'text/javascript';
  response.setHeader('Content-Type', type);
  response.end(await readFile(join(staged, name)));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/careerscope/`;
const results = [];
const limitations = [];
let capturing = false;

async function audit(page) {
  const findings = await page.evaluate(() => {
    const errors = [];
    const warnings = [];
    const visible = (node) => node.checkVisibility({ checkVisibilityCSS: true });
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
    if (new Set(ids).size !== ids.length) errors.push('Duplicate IDs');
    if (document.documentElement.scrollWidth > innerWidth) errors.push('Horizontal overflow');
    if (document.querySelectorAll('main').length !== 1) errors.push('Missing main landmark');
    if ([...document.querySelectorAll('h1')].filter(visible).length !== 1)
      errors.push('Heading hierarchy');
    for (const node of document.querySelectorAll('input,select,button,a')) {
      if (!visible(node)) continue;
      const label =
        node.getAttribute('aria-label') ||
        node.labels?.[0]?.textContent ||
        node.textContent ||
        node.querySelector('img')?.alt;
      if (!label?.trim()) errors.push(`Unnamed control: ${node.id || node.tagName}`);
      if (
        (node.tagName === 'INPUT' || node.tagName === 'SELECT' || node.tagName === 'BUTTON') &&
        node.getBoundingClientRect().height < 24 &&
        node.type !== 'checkbox'
      )
        errors.push(`Small target: ${node.id}`);
    }
    for (const image of document.images)
      if (!image.hasAttribute('alt') || !image.complete || image.naturalWidth === 0)
        errors.push('Image missing alt or not loaded');
    for (const link of document.querySelectorAll('a[target="_blank"]'))
      if (!link.rel.includes('noopener') || !link.rel.includes('noreferrer'))
        errors.push('Unsafe external link');
    const rgb = (color) =>
      color
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number);
    const luminance = (color) =>
      rgb(color)
        .map((value) => {
          const scaled = value / 255;
          return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (first, second) => {
      const values = [luminance(first), luminance(second)].sort(
        (firstValue, secondValue) => secondValue - firstValue,
      );
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const rootStyle = getComputedStyle(document.documentElement);
    for (const selector of [
      'body',
      '.muted',
      '.posting',
      '.role-link',
      '.match',
      'button',
      'input',
      'select',
    ]) {
      const node = [...document.querySelectorAll(selector)].find(visible);
      if (!node) continue;
      const style = getComputedStyle(node);
      if (!style.getPropertyValue('--ink').trim()) {
        warnings.push(
          `Computed contrast unavailable for rendered ${selector}; inherited theme tokens absent from browser style API`,
        );
        continue;
      }
      let parent = node;
      let background = getComputedStyle(parent).backgroundColor;
      while (background === 'rgba(0, 0, 0, 0)' && parent.parentElement) {
        parent = parent.parentElement;
        background = getComputedStyle(parent).backgroundColor;
      }
      if (background === 'rgba(0, 0, 0, 0)') background = rootStyle.backgroundColor;
      if (contrast(style.color, background) < 4.5)
        errors.push(
          `Text contrast below 4.5:1: ${selector} (${style.color} on ${background}; theme ${document.documentElement.dataset.theme})`,
        );
    }
    return { errors, warnings };
  });
  limitations.push(...findings.warnings);
  assert.deepEqual(findings.errors, []);
}

async function capture(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await audit(page);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  capturing = true;
  let image;
  try {
    image = await page.screenshot({ animations: 'allow', caret: 'initial' });
  } finally {
    capturing = false;
  }
  await writeFile(join(output, `${name}.png`), image);
  if (update) await writeFile(join(baseline, `${name}.png`), image);
  else
    assert.ok(
      image.equals(await readFile(join(baseline, `${name}.png`))),
      `Visual difference: ${name}. Inspect before updating the baseline.`,
    );
  results.push(name);
}

try {
  for (const [engineName, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        if (
          engineName === 'webkit' &&
          capturing &&
          message.text().startsWith('Refused to apply a stylesheet because its hash')
        ) {
          limitations.push(
            'WebKit blocks Playwright screenshot-only inline stylesheet injection under the unchanged strict CSP',
          );
        } else errors.push(message.text());
      });
      await page.goto(base);
      await page.locator('#jobs li').first().waitFor();
      assert.equal(
        await page.locator('meta[name="robots"]').getAttribute('content'),
        'index,follow',
      );
      await page.keyboard.press(engineName === 'webkit' ? 'Alt+Tab' : 'Tab');
      assert.equal(
        await page.evaluate(() => document.activeElement.textContent.trim()),
        'Skip to content',
      );
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'main-content');
      await page.locator('#theme').selectOption('dark');
      await page.getByRole('link', { name: 'Admin login' }).click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      await page.reload();
      assert.equal(await page.locator('#theme').inputValue(), 'dark');
      await page.locator('#theme').selectOption('system');
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      for (const state of ['public', 'locked', 'admin']) {
        await page.goto(state === 'public' ? base : `${base}admin.html`);
        if (state === 'public') await page.locator('#jobs li').first().waitFor();
        if (state === 'admin') {
          await page.getByLabel('Snapshot passphrase').fill(passphrase);
          await page.getByRole('button', { name: 'Unlock', exact: true }).click();
          await page.getByRole('table', { name: 'My leads' }).waitFor();
        }
        for (const theme of ['light', 'dark']) {
          await page.locator('#theme').selectOption(theme);
          for (const width of [320, 390, 768, 1024, 1440, 1920]) {
            await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
            await capture(page, `${engineName}-${state}-${theme}-${width}`);
          }
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#filter-panel > summary').click();
      await page.locator('#search').fill('no-match-fixture');
      await page.locator('#empty').waitFor({ state: 'visible' });
      await capture(page, `${engineName}-admin-empty-mobile`);
      await page.getByRole('button', { name: 'Lock', exact: true }).click();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'passphrase');
      assert.equal(
        await page.locator('meta[name="robots"]').getAttribute('content'),
        'noindex,nofollow,noarchive',
      );
      await page.getByLabel('Snapshot passphrase').fill('incorrect-fixture');
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await page.getByRole('alert').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#passphrase').getAttribute('aria-invalid'), 'true');
      await capture(page, `${engineName}-admin-error-mobile`);
      await page.goto(base);
      await page.locator('#jobs li').first().waitFor();
      await page.getByLabel('Search', { exact: true }).fill('no-match-fixture');
      await page.locator('#empty').waitFor({ state: 'visible' });
      await capture(page, `${engineName}-public-empty-mobile`);
      await page.getByLabel('Search', { exact: true }).fill('');
      await page.route('**/jobs.json', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...publicSnapshot,
            jobs: [...publicSnapshot.jobs, { ...publicSnapshot.jobs[0], url: 'invalid' }],
          }),
        }),
      );
      await page.getByRole('button', { name: 'Refresh jobs' }).click();
      await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
      assert.match(await page.locator('#count').textContent(), /^65 jobs/);
      assert.equal(await page.locator('#error').isVisible(), false);
      await page.unroute('**/jobs.json');
      await page.route('**/jobs.json', (route) =>
        route.fulfill({ status: 503, body: 'Unavailable' }),
      );
      await page.getByRole('button', { name: 'Refresh jobs' }).click();
      await page.locator('#error').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#jobs li').count(), 50);
      await capture(page, `${engineName}-public-error-mobile`);
      assert.equal(await page.evaluate(() => sessionStorage.length), 0);
      assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), ['careerscope.theme']);
      assert.deepEqual(
        errors.filter((message) => !message.includes('503')),
        [],
      );
      await context.close();
      process.stdout.write(
        `${engineName}: visual matrix, theme persistence, keyboard, semantics/contrast, public/admin states passed.\n`,
      );
    } finally {
      await browser.close();
    }
  }
  await writeFile(
    join(output, 'summary.json'),
    JSON.stringify(
      {
        mode: update ? 'baseline creation' : 'baseline comparison',
        screenshots: results.length,
        cases: results,
        limitations: [...new Set(limitations)],
      },
      null,
      2,
    ),
  );
  if (limitations.length)
    process.stdout.write(
      `Contrast sampling limitations: ${[...new Set(limitations)].join('; ')}. These are not accessibility passes.\n`,
    );
  process.stdout.write(
    `${results.length} visual cases ${update ? 'captured as local baselines' : 'matched local baselines'}.\n`,
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}
