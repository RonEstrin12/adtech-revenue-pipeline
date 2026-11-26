/**
 * Apply pending SQL migrations from db/migrations/:  npm run migrate
 */
import { createPool } from "../lib/db.js";
import { migrate, readMigrations } from "../lib/migrate.js";

const pool = createPool();
try {
  const migrations = await readMigrations();
  const client = await pool.connect(); // one connection: transactions must not hop between pool clients
  let applied: string[];
  try {
    applied = await migrate(client, migrations);
  } finally {
    client.release();
  }
  for (const v of migrations.map((m) => m.version)) {
    console.log(`  ${applied.includes(v) ? "applied        " : "already applied"}  ${v}`);
  }
  console.log(`${applied.length} migration(s) applied, ${migrations.length - applied.length} already up to date`);
} catch (err) {
  console.error(`❌ migrate failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
