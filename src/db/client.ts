import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export function createPool(databaseUrl: string, max = 10): Pool {
  return new Pool({ connectionString: databaseUrl, max });
}

export function createDb(databaseUrl: string): { db: Db; pool: Pool } {
  const pool = createPool(databaseUrl);
  return { db: drizzle(pool, { schema }), pool };
}
