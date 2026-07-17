import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

export default [
  {
    ignores: ['dist/', 'dist-export/', 'node_modules/'],
  },
  js.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'svelte/no-useless-mustaches': ['error', { ignoreStringEscape: true }],
    },
  },
  {
    files: ['**/*.test.js', 'vitest.setup.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
  },
  {
    files: ['*.config.js', 'vite.config.*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
