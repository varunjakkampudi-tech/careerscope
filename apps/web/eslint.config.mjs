import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import jsxA11y from 'eslint-plugin-jsx-a11y';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-config-next registers react-hooks and enables only six jsx-a11y
    // rules. The leads table is hand-rolled ARIA `role="table"` markup and the
    // drawer is a deliberately non-modal `role="dialog"`; the compiler cannot
    // check either, so the full jsx-a11y recommended rule set is enabled here
    // against the plugin object eslint-config-next already registered.
    files: ['**/*.{ts,tsx}'],
    rules: { ...jsxA11y.flatConfigs.recommended.rules },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),
]);

export default eslintConfig;
