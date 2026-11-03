import { createInMemoryRepositories, type InMemoryRepositories } from './repositories/memory.js';
import { createPostgresRepositories } from './repositories/postgres.js';
import type { Repositories } from './repositories/types.js';

export * from './repositories/types.js';
export { createInMemoryRepositories } from './repositories/memory.js';
export { createPostgresRepositories } from './repositories/postgres.js';
export * from './schema.js';

export type RepositoriesKind = 'postgres' | 'memory';

/**
 * Repository factory. The server uses Postgres; tests and the eval harness pass
 * `kind: 'memory'` so neither needs a database (P0 acceptance requirement).
 */
export function createRepositories(options: { kind: RepositoriesKind; databaseUrl?: string }): Repositories {
  if (options.kind === 'memory') {
    if (options.databaseUrl) {
      // intentional: memory repos ignore DATABASE_URL (keeps callers uniform)
    }
    return createInMemoryRepositories() as InMemoryRepositories;
  }
  const databaseUrl = options.databaseUrl;
  if (!databaseUrl) throw new Error('createRepositories: databaseUrl is required for kind "postgres"');
  return createPostgresRepositories(databaseUrl);
}
