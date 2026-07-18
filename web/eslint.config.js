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
    files: ['src/**/*.{js,svelte}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'lucide',
              message: 'Import Lucide icons through src/shared/icons.js.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/shared/icons.js'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['src/**/*.svelte'],
    rules: {
      'svelte/no-restricted-html-elements': [
        'error',
        {
          elements: ['svg'],
          message:
            'Use a Lucide icon from src/shared/icons.js. Add a targeted override only for non-icon data visualization.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'SvelteElement[name.name="span"] > SvelteText[value=/[←›]/]',
          message: 'Use a Lucide icon from src/shared/icons.js instead of a Unicode icon glyph.',
        },
      ],
    },
  },
  {
    files: ['src/components/session/chat/ContextUsage.svelte'],
    rules: {
      'svelte/no-restricted-html-elements': 'off',
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
