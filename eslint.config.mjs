import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      // The web app lints itself: `npm run lint --workspace @careerscope/web` uses apps/web/eslint.config.mjs.
      'apps/web/**',
      'playwright-report/**',
      'test-results/**',
      'data/**',
      '_site/**',
      // Vendored external design-reference exports (Lovable). These are
      // untracked working material the owner drops in the repository root to
      // compare against; they are a separate project with their own
      // package.json, tsconfig and eslint.config.js, and they are NOT
      // CareerScope source. Linting them made `npm run lint` fail on somebody
      // else's unused imports, which is exactly how a gate stops being read.
      // Matched by their marker directory rather than by name, because the
      // export directories are named with a fresh UUID each time.
      '**/.lovable/**',
      '2a333ef7-7f3c-459e-9f7b-e7a21b4e1741/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.{mjs,ts}'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['scripts/check-ui.ts', 'scripts/visual-regression.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // A tool whose entire output is a report has to reach stdout. This has to sit
    // after the general rules above, because flat config lets the last match win.
    files: [
      'scripts/require-ci-success.mjs',
      'scripts/check-deploy-gate.mjs',
      'scripts/check-line-endings.mjs',
    ],
    rules: { 'no-console': 'off' },
  },
  {
    // Tests talk to stdout on purpose — a failing assertion is easier to read
    // with a `console.log` beside it than without one.
    files: ['**/*.test.{ts,tsx}'],
    rules: { 'no-console': 'off' },
  },
);
