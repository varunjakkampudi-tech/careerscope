import { defineConfig } from 'drizzle-kit';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';

export default defineConfig({
  dialect: 'postgresql',
  schema: fileURLToPath(new URL('./packages/core/src/schema.ts', import.meta.url)),
  out: relative(process.cwd(), fileURLToPath(new URL('./migrations', import.meta.url))),
});
