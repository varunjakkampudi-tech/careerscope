import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright';

// Real, numeric visual-regression / design-parity check: screenshots a live
// route and compares it pixel-by-pixel against a reference PNG (either a
// stored baseline for regression, or a crop of an owner-supplied design
// image for parity scoring). Reports an actual percentage match rather than
// a subjective "looks close" judgement, and always writes a diff image so a
// reported score can be inspected, not just trusted.
//
// Usage:
//   node --import tsx scripts/visual-regression.ts <name> <url> <referencePng> [--update]
//
// `--update` writes the current screenshot as the new baseline/reference
// instead of comparing (first run, or an intentional accepted redesign).

type Options = {
  width: number;
  height: number;
  fullPage: boolean;
  signIn?: { email: string; password: string };
};

async function screenshot(url: string, options: Options): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: options.width, height: options.height },
    });
    if (options.signIn) {
      await page.goto(url, { waitUntil: 'networkidle' });
      const emailField = page.getByLabel('Email', { exact: true });
      await emailField.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      if (await emailField.isVisible().catch(() => false)) {
        await emailField.fill(options.signIn.email);
        await page.getByLabel('Password', { exact: true }).fill(options.signIn.password);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.waitForURL(/\/dashboard/, { timeout: 10000 }).catch(() => {});
        await page.waitForLoadState('networkidle');
      }
    }
    await page.goto(url, { waitUntil: 'networkidle' });
    return await page.screenshot({ fullPage: options.fullPage });
  } finally {
    await browser.close();
  }
}

function toPng(buffer: Buffer): PNG {
  return PNG.sync.read(buffer);
}

export async function compare(
  name: string,
  url: string,
  referencePath: string,
  options: Options = { width: 1440, height: 900, fullPage: false },
): Promise<{ matchPercent: number; diffPath: string; actualPath: string }> {
  const outDir = new URL('../test-results/visual/', import.meta.url);
  mkdirSync(outDir, { recursive: true });
  const actualBuffer = await screenshot(url, options);
  const actualPath = new URL(`${name}-actual.png`, outDir).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  writeFileSync(actualPath, actualBuffer);

  const reference = toPng(readFileSync(referencePath));
  const actual = toPng(actualBuffer);
  // Reference (a design export) and the live screenshot are very unlikely to
  // share exact pixel dimensions — resize the actual capture's comparison
  // canvas to the reference's dimensions so pixelmatch has same-sized
  // buffers to work with. This is a real limitation (not sub-pixel exact),
  // recorded rather than hidden: this score is a structural/color similarity
  // measure at the reference's resolution, not a claim of literal identical
  // pixel dimensions.
  const width = reference.width;
  const height = reference.height;
  const resized = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(actual.height - 1, Math.round((y / height) * actual.height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(actual.width - 1, Math.round((x / width) * actual.width));
      const sourceIndex = (actual.width * sourceY + sourceX) << 2;
      const targetIndex = (width * y + x) << 2;
      resized.data[targetIndex] = actual.data[sourceIndex]!;
      resized.data[targetIndex + 1] = actual.data[sourceIndex + 1]!;
      resized.data[targetIndex + 2] = actual.data[sourceIndex + 2]!;
      resized.data[targetIndex + 3] = actual.data[sourceIndex + 3]!;
    }
  }

  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(reference.data, resized.data, diff.data, width, height, {
    threshold: 0.15,
  });
  const matchPercent = Math.round((1 - mismatched / (width * height)) * 10000) / 100;
  const diffPath = new URL(`${name}-diff.png`, outDir).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  writeFileSync(diffPath, PNG.sync.write(diff));
  return { matchPercent, diffPath, actualPath };
}

async function main() {
  const [name, url, referencePath, flag] = process.argv.slice(2);
  if (!name || !url || !referencePath) {
    console.error(
      'Usage: node --import tsx scripts/visual-regression.ts <name> <url> <referencePng> [--update]',
    );
    process.exitCode = 1;
    return;
  }
  const signIn =
    process.env.VISUAL_EMAIL && process.env.VISUAL_PASSWORD
      ? { email: process.env.VISUAL_EMAIL, password: process.env.VISUAL_PASSWORD }
      : undefined;
  if (flag === '--update') {
    const buffer = await screenshot(url, { width: 1440, height: 900, fullPage: false, signIn });
    writeFileSync(referencePath, buffer);
    console.log(`Baseline updated: ${referencePath}`);
    return;
  }
  const result = await compare(name, url, referencePath, {
    width: 1440,
    height: 900,
    fullPage: false,
    signIn,
  });
  console.log(`${name}: ${result.matchPercent}% match`);
  console.log(`  actual: ${result.actualPath}`);
  console.log(`  diff:   ${result.diffPath}`);
}

await main();
