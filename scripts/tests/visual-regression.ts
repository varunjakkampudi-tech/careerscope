/**
 * Visual regression for the public sign-in screen. The baselines are PNG files in
 * scripts/tests/visual-baselines, and they must be generated on the same Linux image CI uses,
 * because font rasterisation differs between operating systems.
 *
 * Usage:
 *   CAREERSCOPE_VISUAL_BASE=http://127.0.0.1:5280 node --import tsx scripts/tests/visual-regression.ts
 *   Add VISUAL_UPDATE=1 to write the baselines instead of comparing.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const baseUrl = process.env.CAREERSCOPE_VISUAL_BASE ?? 'http://127.0.0.1:5280';
const updating = process.env.VISUAL_UPDATE === '1';
const baselineDir = fileURLToPath(new URL('./visual-baselines/', import.meta.url));
// A pixel counts as changed when any channel differs by more than this, which ignores anti-aliasing noise.
const channelTolerance = 8;
// The share of changed pixels allowed before the screenshot counts as a regression.
const maxChangedRatio = 0.0005;

const screens = [
  { name: 'sign-in-mobile', width: 390, height: 844 },
  { name: 'sign-in-desktop', width: 1280, height: 800 },
] as const;

const stableCss = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
  }
`;

async function captureScreen(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  screen: (typeof screens)[number],
): Promise<Buffer> {
  const context = await browser.newContext({
    viewport: { width: screen.width, height: screen.height },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  try {
    const page = await context.newPage();
    // The screen must not depend on live data: every API call is answered as signed out.
    await page.route('**/api/**', (route) =>
      route.fulfill({
        status: route.request().url().endsWith('/api/session') ? 200 : 401,
        contentType: 'application/json',
        body: route.request().url().endsWith('/api/session')
          ? JSON.stringify({ authenticated: false })
          : JSON.stringify({ error: 'unauthenticated' }),
      }),
    );
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: stableCss });
    await page.evaluate(() => document.fonts.ready);
    return await page.screenshot({ fullPage: true, animations: 'disabled' });
  } finally {
    await context.close();
  }
}

/**
 * The comparison script runs as plain text in the browser. Bundling it through tsx would add helper
 * calls that do not exist in the page, so it is kept as a string.
 */
const comparePixelsScript = `async ({ expectedUrl, actualUrl, tolerance }) => {
  const load = (src) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  const [left, right] = await Promise.all([load(expectedUrl), load(actualUrl)]);
  if (left.width !== right.width || left.height !== right.height) {
    return { changed: Number.POSITIVE_INFINITY, total: 1, sizeMatches: false };
  }
  const read = (image) => {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context2d = canvas.getContext('2d');
    context2d.drawImage(image, 0, 0);
    return context2d.getImageData(0, 0, image.width, image.height).data;
  };
  const a = read(left);
  const b = read(right);
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i] - b[i]) > tolerance ||
      Math.abs(a[i + 1] - b[i + 1]) > tolerance ||
      Math.abs(a[i + 2] - b[i + 2]) > tolerance ||
      Math.abs(a[i + 3] - b[i + 3]) > tolerance
    )
      changed += 1;
  }
  return { changed, total: a.length / 4, sizeMatches: true };
}`;

/** Counts pixels that differ between two PNGs. The comparison runs in a browser canvas, so no image library is needed. */
async function changedRatio(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  expected: Buffer,
  actual: Buffer,
): Promise<{ changed: number; total: number; sizeMatches: boolean }> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const argument = {
      expectedUrl: `data:image/png;base64,${expected.toString('base64')}`,
      actualUrl: `data:image/png;base64,${actual.toString('base64')}`,
      tolerance: channelTolerance,
    };
    return await page.evaluate(`(${comparePixelsScript})(${JSON.stringify(argument)})`);
  } finally {
    await context.close();
  }
}

async function main() {
  await mkdir(baselineDir, { recursive: true });
  const browser = await chromium.launch({
    args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'],
  });
  try {
    for (const screen of screens) {
      const actual = await captureScreen(browser, screen);
      const path = `${baselineDir}${screen.name}.png`;
      if (updating) {
        await writeFile(path, actual);
        process.stdout.write(`PASS wrote baseline ${screen.name}
`);
        continue;
      }
      const expected = await readFile(path).catch(() => {
        throw new Error(
          `missing baseline ${screen.name}; run with VISUAL_UPDATE=1 on the CI image`,
        );
      });
      const result = await changedRatio(browser, expected, actual);
      assert.equal(result.sizeMatches, true, `${screen.name} changed size`);
      const ratio = result.changed / result.total;
      assert.ok(
        ratio <= maxChangedRatio,
        `${screen.name}: ${result.changed} pixels changed (${(ratio * 100).toFixed(3)}%)`,
      );
      process.stdout.write(`PASS ${screen.name} (${result.changed} changed pixels)
`);
    }
  } finally {
    await browser.close();
  }
}

await main();
