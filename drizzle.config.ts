import { defineConfig } from 'drizzle-kit';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';

// drizzle-kit globs these paths, and a backslash is an escape character in glob
// syntax, so a Windows path has to be normalised or it silently matches nothing.
const posix = (value: string) => value.replaceAll('\\', '/');

export default defineConfig({
  dialect: 'postgresql',
  schema: posix(fileURLToPath(new URL('./packages/core/src/schema.ts', import.meta.url))),
  out: posix(relative(process.cwd(), fileURLToPath(new URL('./migrations', import.meta.url)))),
});
