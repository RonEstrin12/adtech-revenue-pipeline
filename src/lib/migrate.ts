/**
 * Minimal SQL migration runner: applies db/migrations/*.sql in file-name order,
 * each in its own transaction, and records it in schema_migrations so it never runs twice.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Queryable, withTransaction } from "./db.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

/** Arbitrary constant: serializes concurrent migrate runs. */
const MIGRATE_LOCK_ID = 4_400_001;

export interface Migration {
  version: string; // file name, e.g. "001_init.sql"
  sql: string;
}

export async function readMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(files.map(async (version) => ({ version, sql: await readFile(join(dir, version), "utf-8") })));
}

/**
 * Applies the migrations that are not recorded yet. `client` must be a single connection
 * (not a Pool), because each migration runs in its own transaction.
 * Returns the versions applied by this run.
 */
export async function migrate(client: Queryable, migrations: Migration[]): Promise<string[]> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    text        PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const applied: string[] = [];
  for (const m of migrations) {
    const ran = await withTransaction(client, async () => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATE_LOCK_ID]);
      const seen = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [m.version]);
      if (seen.rows.length > 0) return false;
      await client.query(m.sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [m.version]);
      return true;
    });
    if (ran) applied.push(m.version);
  }
  return applied;
}
