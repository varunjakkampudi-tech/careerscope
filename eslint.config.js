import js from '@eslint/js';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'playwright-report/**',
      'test-results/**',
      'data/**',
      '_site/**',
      'v2/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['mobile-site/*.{js,mjs}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      'scripts/check-ui.mjs',
      'scripts/check-admin-ui.mjs',
      'scripts/check-pages-ui.mjs',
      'scripts/check-public-workspace.mjs',
    ],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: [
      'scripts/check-agents.mjs',
      'scripts/control-center.mjs',
      'scripts/backup-session.mjs',
      'scripts/release-gate.mjs',
      'scripts/product.mjs',
      'scripts/check-release-gate.mjs',
      'scripts/agile.mjs',
      'scripts/engineering-ui.mjs',
      'scripts/check-agile-gates.mjs',
      'scripts/require-ci-success.mjs',
      'scripts/check-deploy-gate.mjs',
      'scripts/check-line-endings.mjs',
    ],
    languageOptions: { globals: globals.node },
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
      'scripts/check-agents.mjs',
      'scripts/control-center.mjs',
      'scripts/backup-session.mjs',
      'scripts/release-gate.mjs',
      'scripts/product.mjs',
      'scripts/check-release-gate.mjs',
      'scripts/agile.mjs',
      'scripts/engineering-ui.mjs',
      'scripts/check-agile-gates.mjs',
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
  {
    files: ['apps/api/src/db/migrate.ts', 'apps/api/src/db/seed.ts'],
    rules: { 'no-console': ['warn', { allow: ['log', 'warn', 'error'] }] },
  },
  {
    // The web app only. Two rule sets that the compiler cannot supply:
    //
    //  - **Rules of hooks.** A conditional or out-of-order hook call type-checks
    //    perfectly and then corrupts state at runtime. This is the one React
    //    lint rule that catches a whole class of silent bugs.
    //  - **jsx-a11y.** The leads table is hand-rolled ARIA `role="table"` divs
    //    and the drawer is a deliberately non-modal `role="dialog"` — both are
    //    exactly the sort of thing that is one attribute away from announcing
    //    nothing at all, and neither `tsc` nor a human re-reading it reliably
    //    catches that.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
);
