/**
 * Two test tiers, one runner.
 *
 * The packages and the API are pure Node — no DOM, no globals, fast. The web app
 * needs jsdom, and jsdom costs roughly a second of startup per worker, so running
 * everything in it would tax the ~200 node tests to serve the handful of
 * component ones. `projects` keeps each tier in the environment it actually
 * needs, and `vitest run` still runs both with one command.
 *
 * Note the web tier's include covers `.test.tsx` as well as `.test.ts`. The node
 * tier's glob is `.test.ts` only and always was, which is why component tests
 * were invisible to the runner before this file grew a second project rather
 * than a wider glob.
 */

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = Object.fromEntries(
  ['shared', 'resume', 'matching', 'providers'].map((name) => [
    `@job-radar/${name}`,
    fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
  ]),
);

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          include: ['packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts'],
          environment: 'node',
          globals: false,
        },
      },
      {
        resolve: { alias },
        // esbuild picks the JSX runtime up from apps/web/tsconfig.json, but only
        // for files it resolves under that project. Stating it here means a test
        // file that lands outside `src/` still compiles rather than failing on a
        // bare `<div>`.
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          globals: false,
          setupFiles: ['./apps/web/vitest.setup.ts'],
          // Testing Library reads this to decide whether to print the DOM on a
          // failed query. The default dumps 7000 characters of Tailwind classes
          // into the terminal and buries the assertion that failed.
          onConsoleLog: () => undefined,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/types.ts', '**/constants.ts'],
    },
  },
});
