/**
 * Stage 4: load one day of clean rows and rejected rows into Postgres.
 *
 *   npm run load -- 2026-11-25     (defaults to yesterday, in REPORT_TZ)
 *
 * Each partner-day is replaced in its own transaction. A missing or inconsistent
 * partner-day does not stop the other partners, but the run exits non-zero.
 */
import { isIsoDate, yesterday } from "../lib/dates.js";
import { createPool } from "../lib/db.js";
import { BUCKET, getText, listKeys } from "../lib/s3.js";
import { PARTNERS } from "../validate/run.js";
import { loadPartnerDay, readPartnerDay } from "./run.js";

const date = process.argv[2] ?? yesterday();
if (!isIsoDate(date)) {
  console.error("Usage: npm run load -- YYYY-MM-DD (a real calendar date)");
  process.exitCode = 1;
} else {
  const pool = createPool();
  let failures = 0;
  let totalRows = 0;
  let totalRejected = 0;
  console.log(`Loading clean zone for ${date} into Postgres`);
  try {
    const client = await pool.connect();
    try {
      for (const partner of Object.keys(PARTNERS)) {
        try {
          const read = await readPartnerDay({ listKeys, getText }, partner, date);
          if (read.status === "missing") {
            failures++;
            console.error(`  ❌ partner ${partner.toUpperCase()}: no clean files for ${date} (run npm run validate first)`);
            continue;
          }
          const r = await loadPartnerDay(client, read.day);
          totalRows += r.rowsLoaded;
          totalRejected += r.rejectedLoaded;
          console.log(`  ✅ partner ${partner.toUpperCase()}: ${r.rowsLoaded} rows loaded, ${r.rejectedLoaded} rejected, revenue_usd ${r.revenueUsd}`);
          console.log(`     from s3://${BUCKET}/${r.rawKey}`);
        } catch (err) {
          failures++;
          console.error(`  ❌ partner ${partner.toUpperCase()}: ${(err as Error).message}`);
        }
      }
      const total = await client.query("SELECT COALESCE(SUM(revenue_usd), 0)::text AS total FROM revenue_daily WHERE date = $1", [date]);
      console.log(`Total: ${totalRows} rows loaded, ${totalRejected} rejected`);
      console.log(`Total revenue_usd in revenue_daily for ${date}: ${total.rows[0].total}`);
    } finally {
      client.release();
    }
  } catch (err) {
    failures++;
    console.error(`❌ load failed: ${(err as Error).message}`);
  } finally {
    await pool.end();
  }
  process.exitCode = failures ? 1 : 0;
}
