import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { buildTestApp, seedLeads } from '../apps/api/src/routes/routes.fixtures.ts';

const screenshots = mkdtempSync(join(tmpdir(), 'job-radar-ui-'));
const results = [];
for (const engine of [chromium, firefox, webkit]) {
  const fixture = await buildTestApp({
    LOGIN_ENABLED: 'true',
    APP_API_KEY: '',
    SERVE_WEB: 'true',
    WEB_DIST: resolve('apps/web/dist'),
  });
  try {
    seedLeads(
      fixture,
      Array.from({ length: 120 }, (_, index) => ({
        score: 0.9,
        company: ['Northstar Systems', 'Atlas Product Studio', 'Meridian Engineering'][index % 3],
        title:
          index % 4 === 0
            ? 'Senior Frontend Engineer, Design Systems and Developer Experience'
            : 'Senior Software Engineer',
        location: 'Hyderabad, India',
      })),
    );
    await fixture.container.repos.auth.setup(
      'ui-test@example.com',
      'synthetic ui verification password',
    );
    const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    fixture.env.AUTH_ORIGIN = address;

    const browser = await engine.launch({ headless: true });
    let activePage;
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      activePage = page;
      const errors = [];
      const assets = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (request.url().includes('/assets/')) assets.push(request.url());
      });
      await page.goto(`${address}/login`);
      await page
        .getByRole('heading', { name: 'Sign in', exact: true })
        .waitFor({ timeout: 10000 })
        .catch(async (error) => {
          console.error(engine.name(), errors, await page.locator('body').innerText());
          throw error;
        });
      assert.ok(
        !assets.some((url) => /\/(Leads|Search|Settings|Onboarding)-/.test(url)),
        'Private routes downloaded at login',
      );
      await page.locator('input[name=email]').fill('ui-test@example.com');
      await page.locator('input[name=password]').fill('synthetic ui verification password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('link', { name: 'Profile', exact: true }).waitFor();
      await page.locator('main h1').waitFor();
      const layouts = [];
      for (const width of [1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(
          () =>
            new Promise((resolveFrame) =>
              requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
            ),
        );
        layouts.push(
          await page.evaluate(() => {
            const rootStyle = getComputedStyle(document.documentElement);
            const header = document.querySelector('header');
            const profile = document.querySelector('a[aria-label="Profile"]');
            const brand = document.querySelector('a[aria-label="CareerScope"]');
            const theme = document.querySelector('button[aria-label^="Theme:"]');
            return {
              width: innerWidth,
              overflow: document.documentElement.scrollWidth > innerWidth,
              headerHeight: header.getBoundingClientRect().height,
              expectedHeight:
                parseFloat(rootStyle.getPropertyValue('--spacing-app-header')) *
                  parseFloat(rootStyle.fontSize) +
                1,
              profileHeight: profile.getBoundingClientRect().height,
              headerOverlap:
                brand.getBoundingClientRect().right > theme.getBoundingClientRect().left,
            };
          }),
        );
      }
      for (const route of ['/profile', '/search', '/settings', '/applications']) {
        await page.goto(`${address}${route}`);
        await page.locator('main h1').waitFor();
        layouts.push({
          route,
          width: 320,
          overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        });
      }
      await page.goto(`${address}/leads`);
      await page.locator('main h1').waitFor();
      await page.getByRole('button', { name: 'Fresh matches', exact: true }).click();
      assert.equal(new URL(page.url()).searchParams.get('posted'), '1');
      await page.getByRole('button', { name: 'Saved shortlist', exact: true }).click();
      assert.equal(new URL(page.url()).searchParams.get('statuses'), 'saved');
      assert.equal(new URL(page.url()).searchParams.has('posted'), false);
      await page.reload();
      await page.getByRole('button', { name: 'Saved shortlist', exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('statuses'), 'saved');
      await page.goto(`${address}/leads`);
      await page.locator('main h1').waitFor();
      await page.setViewportSize({ width: 1440, height: 600 });
      const filters = page.getByRole('region', { name: 'Lead filters', exact: true });
      await filters.waitFor();
      assert.ok(await filters.evaluate((element) => element.scrollHeight > element.clientHeight));
      const filterBounds = await filters.boundingBox();
      await page.mouse.move(filterBounds.x + filterBounds.width / 2, filterBounds.y + 100);
      await page.mouse.wheel(0, 1200);
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Lead filters"]').scrollTop > 0,
      );
      await filters.getByRole('combobox', { name: 'Order', exact: true }).focus();
      assert.ok(
        await filters.evaluate((element) => {
          const focused = document.activeElement.getBoundingClientRect();
          const region = element.getBoundingClientRect();
          return focused.top >= region.top && focused.bottom <= region.bottom;
        }),
        'Last filter must be reachable within the scrolling region',
      );
      const slider = filters.getByRole('slider', { name: 'Minimum match', exact: true });
      await slider.focus();
      await slider.press('End');
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Lead filters"] input[type="range"]').value === '100',
      );
      assert.equal(await slider.inputValue(), '100');
      await slider.press('Home');
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Lead filters"] input[type="range"]').value === '0',
      );
      assert.equal(await slider.inputValue(), '0');
      await slider.press('ArrowRight');
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Lead filters"] input[type="range"]').value === '1',
      );
      assert.equal(await slider.inputValue(), '1');
      await slider.press('Home');
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Lead filters"] input[type="range"]').value === '0',
      );
      assert.equal(await page.title(), 'Job leads | CareerScope');
      assert.equal(
        await page.locator('meta[name="robots"]').getAttribute('content'),
        'noindex, nofollow',
      );
      assert.deepEqual(
        await page.evaluate(() => {
          const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
          return ids.filter((id, index) => ids.indexOf(id) !== index);
        }),
        [],
        'Responsive layouts must not duplicate IDs',
      );
      await filters.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: join(screenshots, `${engine.name()}-desktop-light.png`) });
      await page.getByRole('button', { name: 'Theme: Match system', exact: true }).click();
      await page.getByRole('button', { name: 'Theme: Light', exact: true }).click();
      await page.screenshot({ path: join(screenshots, `${engine.name()}-desktop-dark.png`) });
      await page.reload();
      await page.locator('main h1').waitFor();
      const theme = await page.evaluate(() => ({
        dark: document.documentElement.classList.contains('dark'),
        scheme: document.documentElement.style.colorScheme,
        chrome: document.querySelector('meta[name="theme-color"]').content,
      }));
      await page.keyboard.press(engine.name() === 'webkit' ? 'Alt+Tab' : 'Tab');
      const skipFocused = await page
        .getByRole('link', { name: 'Skip to content' })
        .evaluate((element) => element === document.activeElement);
      await page.keyboard.press('Enter');
      const mainFocused = await page
        .locator('main')
        .evaluate((element) => element === document.activeElement);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(screenshots, `${engine.name()}-mobile-dark.png`) });
      results.push({
        browser: engine.name(),
        layouts,
        theme,
        skipFocused,
        mainFocused,
        errors,
        lazyLoading: assets.some((url) => /\/Leads-/.test(url)),
      });
    } catch (error) {
      console.error(
        engine.name(),
        activePage?.url(),
        activePage ? await activePage.locator('body').innerText() : 'No page',
      );
      console.error(JSON.stringify({ screenshots, results }, null, 2));
      throw error;
    } finally {
      await browser.close();
    }
  } finally {
    await fixture.close();
  }
}
process.stdout.write(`${JSON.stringify({ screenshots, results }, null, 2)}\n`);
for (const result of results) {
  assert.deepEqual(result.errors, [], `${result.browser}: page errors`);
  assert.ok(
    result.lazyLoading && result.skipFocused && result.mainFocused,
    `${result.browser}: loading or keyboard navigation failure`,
  );
  assert.deepEqual(result.theme, { dark: true, scheme: 'dark', chrome: '#11151f' });
  for (const layout of result.layouts) {
    assert.ok(
      !layout.overflow && !layout.headerOverlap,
      `${result.browser}: overflow at ${layout.route ?? '/leads'} ${layout.width}px`,
    );
    if (layout.headerHeight !== undefined) {
      assert.equal(
        layout.headerHeight,
        layout.expectedHeight,
        `${result.browser}: sticky offset mismatch`,
      );
      assert.ok(layout.profileHeight >= 40, `${result.browser}: small profile touch target`);
    }
  }
}
