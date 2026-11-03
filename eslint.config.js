// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Node globals for the plain-JS helper scripts under `scripts/`. Those files are not
 * TypeScript, so nothing else declares `URL`/`console`/`process` for `no-undef`.
 * Declared inline rather than importing the `globals` package, which is present in
 * node_modules only transitively and is not a declared dependency of this project.
 */
const NODE_GLOBALS = {
  console: 'readonly',
  process: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  fetch: 'readonly',
};

/**
 * CLI entrypoints where stdout *is* the product (eval report, interactive demo, scenario
 * generator). `console.log` is the intended UX here, so the library-code rule against it
 * does not apply. Scoped to these paths only — the server and src/** remain clean.
 */
const CLI_ENTRYPOINTS = [
  'scripts/**/*.{mjs,js,cjs}',
  'src/scripts/**/*.ts',
  'src/eval/runEvals.ts',
];

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'evals/.cache/**', 'public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: CLI_ENTRYPOINTS,
    languageOptions: { globals: NODE_GLOBALS },
    rules: { 'no-console': 'off' },
  },
);
