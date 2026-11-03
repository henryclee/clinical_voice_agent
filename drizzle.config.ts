import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * `db:generate` reads the Drizzle schema and writes SQL migrations to ./migrations.
 * `db:migrate` (src/db/migrate.ts) applies them at runtime.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:***@localhost:5432/clinical_voice',
  },
  verbose: true,
  strict: true,
});
