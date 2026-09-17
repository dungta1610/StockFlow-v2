// Flat config (ESLint 9+). The three `no-restricted-imports` blocks below are the
// architecture boundaries from docs/code-standards.md — they are enforced here so a
// violation fails lint instead of relying on review.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'plans/**', '**/*.config.*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // platform/ is mechanism only: it must never know about business modules.
  {
    files: ['apps/api/src/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/modules/**'], message: 'platform/ must not import modules/ (see docs/code-standards.md).' }] },
      ],
    },
  },

  // The copilot reaches data only through application services — never SQL or repositories.
  {
    files: ['apps/api/src/modules/copilot/**/*.ts'],
    ignores: ['apps/api/src/modules/copilot/infrastructure/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'pg', message: 'copilot must not touch the database directly.' }],
          patterns: [{ group: ['**/infrastructure/**'], message: 'copilot calls application services, not repositories.' }],
        },
      ],
    },
  },

  // The AI harness is a domain-agnostic library.
  {
    files: ['packages/ai-harness/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/apps/**', '@stockflow/api'], message: 'ai-harness must not import the application.' }] },
      ],
    },
  },
);
