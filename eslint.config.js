import js from '@eslint/js';
import {defineConfig} from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', {fixStyle: 'inline-type-imports'}],
      '@typescript-eslint/explicit-function-return-type': ['error', {allowExpressions: true}],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-restricted-types': [
        'error',
        {types: {any: 'Use unknown and validate at the boundary.'}},
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_'},
      ],
    },
  },
  {
    files: ['**/tests/**/*.ts', '**/src/testing/**/*.ts', 'apps/cli/src/commands/fake-run.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
);
