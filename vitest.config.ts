import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Unit tests must never require infrastructure. Integration tests that need
    // Postgres skip themselves (with a visible reason) when the DB is unreachable.
    pool: 'threads',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/scripts/**'],
      thresholds: {
        perFile: false,
        'src/escalation/**': { lines: 95, functions: 95, statements: 95 },
      },
    },
  },
});
