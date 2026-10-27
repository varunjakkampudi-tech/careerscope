/**
 * Node-only test project for the packages and the API: no DOM, no globals, fast.
 * Web tests run under node:test (see `test:unit`); a jsdom project returns when
 * component tests do.
 */

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = Object.fromEntries(
  ['shared', 'resume', 'matching', 'providers'].map((name) => [
    `@careerscope/${name}`,
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
          include: ['packages/{shared,resume,matching,providers}/src/**/*.test.ts'],
          environment: 'node',
          globals: false,
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
