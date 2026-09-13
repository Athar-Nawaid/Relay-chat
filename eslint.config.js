import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'server/prisma/generated/**',
      'server/prisma/migrations/**',
    ],
  },
  js.configs.recommended,

  // ---------------------------------------------------------------- server
  {
    files: ['server/**/*.js', 'loadtest/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'warn',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // ---------------------------------------------------------------- client
  {
    files: ['client/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,

      // The new JSX transform makes the React import unnecessary.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',

      /**
       * The original app's stored XSS came from innerHTML with unescaped user
       * content. JSX escapes by default, so the vulnerability is gone — but
       * "the framework handles it" is not a security control. This makes the one
       * escape hatch that would reintroduce it a build failure rather than a
       * code-review question.
       */
      'react/no-danger': 'error',

      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Vite config runs in Node, not the browser.
  {
    files: ['client/vite.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Printing results is the entire purpose of these two.
  {
    files: ['loadtest/**/*.js', 'server/prisma/seed.js'],
    rules: { 'no-console': 'off' },
  },
];
