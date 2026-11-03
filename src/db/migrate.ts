import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate as runDrizzleMigrations } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../common/logger.js';

const MIGRATIONS_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** Apply all generated Drizzle migrations. Idempotent (drizzle tracks applied SQL). */
export async function migrate(databaseUrl?: string): Promise<void> {
  const url = databaseUrl ?? loadEnv({ requireRequired: false }).databaseUrl;
  const pool = new Pool({ connectionString: url, max: 1 });
  const logger = createLogger({ name: 'migrate' });
  try {
    await runDrizzleMigrations(pool as never, { migrationsFolder: MIGRATIONS_FOLDER });
    logger.info({ migrationsFolder: MIGRATIONS_FOLDER }, 'migrations applied');
  } finally {
    await pool.end();
  }
}

// `npm run db:migrate` entry point.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  migrate()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('Migration failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
