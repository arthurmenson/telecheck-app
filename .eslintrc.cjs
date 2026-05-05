/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'prettier',
  ],
  settings: {
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
        project: './tsconfig.json',
      },
      node: {
        extensions: ['.js', '.ts'],
      },
    },
    'import/extensions': ['.ts', '.tsx', '.js', '.jsx'],
  },
  rules: {
    // Tenant-isolation discipline: forbid raw SQL strings outside migrations/
    // (will be tightened by appsec-expert agent's review with custom rules)
    'no-restricted-syntax': [
      'error',
      {
        selector: 'CallExpression[callee.property.name="$queryRawUnsafe"]',
        message:
          'Raw unsafe queries forbidden — use Prisma typed queries with tenant context. See CLAUDE.md hard rules (I-023).',
      },
    ],

    // Forbidden glossary aliases (per Contracts Pack v5.2 GLOSSARY)
    'id-denylist': [
      'error',
      'prescription', // use medication_request
      'chatbot', // use Mode 1 / Mode 2
      'customer', // use tenant
    ],

    // Import hygiene
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc' },
      },
    ],
    'import/no-unresolved': 'error',
    'import/no-cycle': 'error',

    // TypeScript strictness
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    // Explicit return types are nice-to-have but not safety-critical, and the
    // CI script uses `--max-warnings 0` so a `warn` here would block the
    // whole pipeline. Re-enable as `error` once a follow-on commit annotates
    // every public function.
    '@typescript-eslint/explicit-function-return-type': 'off',
    // CommonJS interop with ESM `default` imports (fastify-helmet, pino, etc.)
    // legitimately uses the named export as default. The rule produces false
    // positives for these libraries without giving us safety in return.
    'import/no-named-as-default': 'off',
    // Disabled: skeleton `async fn() { throw new Error('not implemented') }`
    // patterns hit this rule but the throw-without-await is intentional for
    // route-handler placeholders that the foundation requires to be `async`
    // (Fastify hook signatures). Re-enable per-file if specific violations
    // matter once handlers are implemented.
    '@typescript-eslint/require-await': 'off',
  },
  overrides: [
    {
      files: ['tests/**/*.ts', '**/*.test.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/explicit-function-return-type': 'off',
        // Tests routinely reference promises in expect(...).toThrow(...) chains
        // and other patterns where eslint-typescript can't statically prove the
        // promise is consumed; relax for test files only.
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/no-misused-promises': 'off',
        // The id-denylist (prescription/chatbot/customer) is the LINT-LEVEL
        // glossary enforcement; tests intentionally reference these aliases
        // to assert the static-analysis test catches them. Allow in test files.
        'id-denylist': 'off',
      },
    },
    {
      files: ['*.cjs'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
    {
      // vitest.config.ts + vitest.bench.config.ts are tooling configs; lint
      // with typeless rules (not included in tsconfig.json's project, so
      // type-aware rules fail).
      files: ['vitest.config.ts', 'vitest.bench.config.ts'],
      parserOptions: {
        project: null,
      },
      rules: {
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/no-misused-promises': 'off',
        '@typescript-eslint/require-await': 'off',
      },
    },
  ],
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'coverage/',
    '*.cjs',
    '.eslintrc.cjs',
    '.tsbuildinfo',
    // vitest.config.ts + vitest.bench.config.ts (Sprint 7 / TLC-018) are
    // not in tsconfig.json's `include` (intentionally — tooling configs,
    // not source) so type-aware lint rules can't parse them. Vitest
    // validates them at test/bench time, so we don't lose coverage by
    // excluding them from ESLint.
    'vitest.config.ts',
    'vitest.bench.config.ts',
  ],
};
