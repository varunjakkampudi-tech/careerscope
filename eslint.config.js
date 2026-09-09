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
      'mobile-export/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['mobile-site/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['scripts/check-ui.mjs'],
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
    // Tests talk to stdout on purpose — a failing assertion is easier to read
    // with a `console.log` beside it than without one.
    files: ['**/*.test.{ts,tsx}'],
    rules: { 'no-console': 'off' },
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
