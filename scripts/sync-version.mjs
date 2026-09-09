import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const root = fileURLToPath(new URL('../', import.meta.url));

export function versionFiles(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Expected a major.minor.patch release version.');
  return {
    'apps/web/src/lib/brand.ts': `export const APP_NAME = 'CareerScope';\nexport const APP_VERSION = '${version}';\n`,
    'mobile-site/version.js': `document.querySelectorAll('[data-app-version]').forEach((element) => {\n  element.textContent = 'v${version}';\n});\n`,
  };
}

export function syncVersion({ check = false, read = readFileSync, write = writeFileSync } = {}) {
  const { version } = JSON.parse(read(resolve(root, 'package.json'), 'utf8'));
  for (const [file, content] of Object.entries(versionFiles(version))) {
    const path = resolve(root, file);
    if (check) {
      if (read(path, 'utf8') !== content)
        throw new Error(`Version mismatch in ${file}. Run npm run version:sync.`);
    } else write(path, content);
  }
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = syncVersion({ check: process.argv.includes('--check') });
  process.stdout.write(`Release version: ${version}\n`);
}
