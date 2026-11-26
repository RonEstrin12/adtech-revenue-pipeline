/**
 * Stage 5: print one day's revenue summary from the analysis views.
 *
 *   npm run report -- 2026-11-25     (defaults to yesterday, in REPORT_TZ)
 *
 * Needs the views from db/migrations/002_analysis_views.sql (npm run migrate).
 * Exits non-zero when nothing is loaded for the date, so a scheduler notices.
 */
import { isIsoDate, yesterday } from "../lib/dates.js";
import { createPool } from "../lib/db.js";
import { formatReport } from "./format.js";
import { fetchDailyReport } from "./query.js";

const date = process.argv[2] ?? yesterday();
if (!isIsoDate(date)) {
  console.error("Usage: npm run report -- YYYY-MM-DD (a real calendar date)");
  process.exitCode = 1;
} else {
  const pool = createPool();
  try {
    const report = await fetchDailyReport(pool, date);
    console.log(formatReport(report));
    process.exitCode = report.totals ? 0 : 1;
  } catch (err) {
    console.error(`❌ report failed: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
