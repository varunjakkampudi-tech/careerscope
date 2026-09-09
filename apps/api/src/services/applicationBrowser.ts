import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(address, prefix, 'ipv4');
}
blocked.addSubnet('::', 128, 'ipv6');
blocked.addSubnet('::1', 128, 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('ff00::', 8, 'ipv6');

export function publicApplicationUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    (isIP(hostname) && blocked.check(hostname, isIP(hostname) === 6 ? 'ipv6' : 'ipv4'))
  ) {
    throw new Error('Application pages must use a public HTTPS URL.');
  }
  return url;
}

export class ApplicationBrowser {
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private controls = new Map<
    string,
    { locator: Locator; label: string; type: string; tag: string; signature: string; url: string }
  >();
  private allowedOrigins = new Set<string>();

  constructor(private readonly directory: string) {}

  async open(url: string): Promise<void> {
    this.allowedOrigins.add(publicApplicationUrl(url).origin);
    this.context = await chromium.launchPersistentContext(this.directory, {
      headless: false,
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 900 },
    });
    await this.context.route('**/*', async (route) => {
      try {
        const target = publicApplicationUrl(route.request().url());
        const addresses = await lookup(target.hostname, { all: true });
        if (
          !addresses.length ||
          addresses.some(({ address, family }) =>
            blocked.check(address, family === 6 ? 'ipv6' : 'ipv4'),
          )
        ) {
          return await route.abort();
        }
        if (
          !['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) &&
          !this.allowedOrigins.has(target.origin)
        ) {
          return await route.abort();
        }
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.context.on('page', (page) => {
      this.page = page;
    });
    this.context.setDefaultTimeout(12_000);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  url(): string {
    return this.page?.url() ?? '';
  }

  async text(): Promise<string> {
    if (!this.page) throw new Error('Browser is not open.');
    return (
      await Promise.all(
        this.page.frames().map((frame) =>
          frame
            .locator('body')
            .innerText()
            .catch(() => ''),
        ),
      )
    ).join('\n');
  }

  async inspect(): Promise<unknown> {
    if (!this.page) throw new Error('Browser is not open.');
    publicApplicationUrl(this.page.url());
    this.controls.clear();
    const frames = [];
    for (const frame of this.page.frames()) {
      const elements = frame.locator(
        'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="checkbox"],[role="combobox"]',
      );
      const fields = [];
      for (let index = 0; index < Math.min(await elements.count(), 200); index += 1) {
        const locator = elements.nth(index);
        if (!(await locator.isVisible())) continue;
        const data = await locator.evaluate((element) => {
          const input = element as unknown as {
            tagName: string;
            type?: string;
            name?: string;
            textContent?: string;
            labels?: { textContent?: string }[];
            options?: ArrayLike<{ value: string; label: string }>;
            getAttribute(name: string): string | null;
          };
          return {
            tag: input.tagName.toLowerCase(),
            type: input.type || '',
            label:
              input.getAttribute('aria-label') ||
              input.labels?.[0]?.textContent?.trim() ||
              input.getAttribute('placeholder') ||
              input.textContent?.trim().slice(0, 160) ||
              input.name ||
              'Unnamed control',
            options: input.options
              ? Array.from(input.options).map((option) => ({
                  value: option.value,
                  label: option.label,
                }))
              : undefined,
          };
        });
        const ref = String(this.controls.size + 1);
        const signature = await locator.evaluate(
          (element) => (element as unknown as { outerHTML: string }).outerHTML,
        );
        this.controls.set(ref, { locator, ...data, signature, url: this.url() });
        fields.push({ ref, ...data });
      }
      const text = await frame
        .locator('body')
        .innerText()
        .catch(() => '');
      frames.push({ url: frame.url(), text: text.slice(0, 18000), fields });
    }
    return { url: this.url(), frames };
  }

  control(ref: string) {
    const control = this.controls.get(ref);
    if (!control) throw new Error('Unknown control; inspect the current page again.');
    return control;
  }

  async fill(ref: string, value: string): Promise<void> {
    const control = this.control(ref);
    await this.validateControl(ref);
    if (
      /password|otp|verification.?code|one.?time|captcha/i.test(`${control.type} ${control.label}`)
    ) {
      throw new Error('Ask the user to enter secrets or CAPTCHA directly in the browser.');
    }
    if (!['input', 'select', 'textarea'].includes(control.tag))
      throw new Error('Only standard form fields can be filled.');
    if (control.tag === 'select') await control.locator.selectOption(value);
    else if (['checkbox', 'radio'].includes(control.type))
      await control.locator.setChecked(value === 'true');
    else await control.locator.fill(value);
  }

  async upload(
    ref: string,
    file: { name: string; mimeType: string; buffer: Buffer },
  ): Promise<void> {
    await this.validateControl(ref);
    if (this.control(ref).type !== 'file') throw new Error('Choose a file input.');
    await this.control(ref).locator.setInputFiles(file);
  }

  async validateControl(ref: string): Promise<void> {
    const control = this.control(ref);
    const signature = await control.locator.evaluate(
      (element) => (element as unknown as { outerHTML: string }).outerHTML,
    );
    if (this.url() !== control.url || signature !== control.signature)
      throw new Error('Page or control changed. Inspect again and request fresh approval.');
  }

  async click(ref: string): Promise<void> {
    await this.validateControl(ref);
    publicApplicationUrl(this.url());
    this.allowedOrigins.add(new URL(this.url()).origin);
    await this.control(ref).locator.click();
    this.controls.clear();
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
  }
}
