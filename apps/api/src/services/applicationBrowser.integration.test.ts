import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { expect, it, vi } from 'vitest';
import { ApplicationBrowser } from './applicationBrowser.js';

it.skipIf(!existsSync(chromium.executablePath()))(
  'fills a synthetic form, refuses secrets and rejects a changed approved control',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'application-browser-test-'));
    const real = await chromium.launch({ headless: true });
    const context = await real.newContext();
    const page = await context.newPage();
    const html =
      '<html><body><h1>Example careers</h1><label>Name<input name="name"></label><label>Password<input type="password"></label><label>Resume<input type="file"></label><button type="button">Continue</button></body></html>';
    const originalRoute = context.route.bind(context);
    vi.spyOn(context, 'route').mockImplementation(async () => {
      return originalRoute('**/*', async (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: html }),
      );
    });
    const launch = vi
      .spyOn(chromium, 'launchPersistentContext')
      .mockResolvedValue(context as BrowserContext);
    const browser = new ApplicationBrowser(directory);
    try {
      await browser.open('https://careers.example.com/apply');
      const snapshot = (await browser.inspect()) as {
        frames: { fields: { ref: string; label: string }[] }[];
      };
      const fields = snapshot.frames.flatMap((frame) => frame.fields);
      const ref = (label: string) => fields.find((field) => field.label === label)!.ref;
      await browser.fill(ref('Name'), 'Synthetic Candidate');
      expect(await page.getByLabel('Name', { exact: true }).inputValue()).toBe(
        'Synthetic Candidate',
      );
      await expect(browser.fill(ref('Password'), 'not-a-real-secret')).rejects.toThrow(/secrets/);
      await browser.upload(ref('Resume'), {
        name: 'fixture.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('fixture'),
      });
      expect(
        await page
          .getByLabel('Resume')
          .evaluate(
            (element) => (element as unknown as { files: { name: string }[] }).files[0]?.name,
          ),
      ).toBe('fixture.pdf');
      await page.getByRole('button', { name: 'Continue', exact: true }).evaluate((element) => {
        (element as unknown as { textContent: string }).textContent = 'Submit application';
      });
      await expect(browser.click(ref('Continue'))).rejects.toThrow(/changed/);
      const after = (await browser.inspect()) as {
        frames: { fields: { ref: string; label: string }[] }[];
      };
      const button = after.frames
        .flatMap((frame) => frame.fields)
        .find((field) => field.label === 'Submit application')!;
      await browser.click(button.ref);
    } finally {
      launch.mockRestore();
      await browser.close();
      await real.close();
      await rm(directory, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  },
);
