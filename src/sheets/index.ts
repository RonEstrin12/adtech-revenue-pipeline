/**
 * Stage 7: publish one day's summary to the Google Sheet.
 *
 *   npm run sheets -- 2026-11-25     (defaults to yesterday, in REPORT_TZ)
 *
 * Reads the stage 5 views through fetchDailyReport and the worst status in qa_results, builds the
 * rows for each tab (rows.ts) and replaces that date's rows in every tab (merge.ts).
 * Exits non-zero on bad config, an API error, or when nothing is loaded for the date.
 *
 * SAFETY: Google is called only when SHEETS_MODE=google. Otherwise this is a dry run that writes
 * the same tabs to local CSV files (out/sheets/ by default) and prints a summary.
 */
import { resolve } from "node:path";
import { isIsoDate, yesterday } from "../lib/dates.js";
import { createPool } from "../lib/db.js";
import { fetchWorstQaStatus } from "../qa/store.js";
import { fetchDailyReport } from "../report/query.js";
import { googleSheetsConfigFromEnv, sheetsMode, sheetsOutDir } from "./config.js";
import { CsvStore } from "./csv-store.js";
import { GoogleSheets, GoogleSheetsStore } from "./google-sheets.js";
import { type TabStore, publishDate } from "./publish.js";
import { buildTabRows } from "./rows.js";

async function main(date: string): Promise<number> {
  // Config first, so a bad setting fails before any database or network work.
  const mode = sheetsMode();
  let store: TabStore;
  let target: string;
  if (mode === "google") {
    const config = googleSheetsConfigFromEnv();
    store = new GoogleSheetsStore(new GoogleSheets(config));
    target = `Google Sheet ${config.spreadsheetId} as ${config.serviceAccount.client_email}`;
  } else {
    const csv = new CsvStore(sheetsOutDir());
    store = csv;
    target = `${resolve(csv.dir)} (dry run; set SHEETS_MODE=google with SHEETS_SPREADSHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON to write the sheet)`;
  }

  const pool = createPool();
  let report;
  let qaStatus;
  try {
    report = await fetchDailyReport(pool, date);
    qaStatus = await fetchWorstQaStatus(pool, date);
  } finally {
    await pool.end();
  }
  if (!report.totals) {
    console.error(`❌ nothing is loaded for ${date}: run npm run load -- ${date} first. The sheet was not changed.`);
    return 1;
  }

  const summary = await publishDate(store, date, buildTabRows(report, qaStatus));
  console.log(`Sheets ${date} -> ${target}`);
  for (const s of summary) {
    console.log(`  ${s.tab.padEnd(11)} ${String(s.written).padStart(3)} row(s) for ${date} (replaced ${s.replaced}), ${s.total} data row(s) in the tab`);
  }
  console.log(`QA status for ${date}: ${qaStatus ?? "not run"}`);
  return 0;
}

const date = process.argv[2] ?? yesterday();
if (!isIsoDate(date)) {
  console.error("Usage: npm run sheets -- YYYY-MM-DD (a real calendar date)");
  process.exitCode = 1;
} else {
  try {
    process.exitCode = await main(date);
  } catch (err) {
    console.error(`❌ sheets failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
