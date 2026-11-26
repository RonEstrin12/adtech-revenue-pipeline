/**
 * Postgres connection for the warehouse (stage 4 onwards).
 *
 * Configured with DATABASE_URL (preferred) or the standard PG* variables
 * (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE), which the pg driver reads itself.
 */
import pg from "pg";

/**
 * The one method our SQL code needs. A pg Client/PoolClient satisfies it, and tests
 * inject a fake that records the statements.
 */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export function createPool(env: NodeJS.ProcessEnv = process.env): pg.Pool {
  if (!env.DATABASE_URL && !env.PGHOST) {
    throw new Error("Postgres is not configured: set DATABASE_URL (or PGHOST and friends) in .env");
  }
  return new pg.Pool(env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {});
}

/** Run `fn` inside BEGIN/COMMIT, rolling back on any error. */
export async function withTransaction<T>(client: Queryable, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // keep the original error; the connection is likely broken anyway
    }
    throw err;
  }
}
