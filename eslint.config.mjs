// Self-contained flat ESLint config for this package. Kept local (not inherited from the
// monorepo root) so `npm run lint` is governed only by this plugin's own rules — the root
// lint excludes packages/** because the Sketch runtime globals (`sketch/dom`, native
// `fetch`, CommonJS command exports) are foreign to the app's React-app ruleset.
//
// A light TypeScript sanity pass: typescript-eslint's recommended rules, no `no-undef`
// (TS resolves globals), with `_`-prefixed args allowed to be unused.
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
