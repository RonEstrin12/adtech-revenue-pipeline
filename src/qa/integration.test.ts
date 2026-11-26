/**
 * Integration test for qa_results (db/migrations/003_qa.sql) against a real Postgres
 * (docker compose up -d), in a throwaway schema. Skipped when the database is unreachable.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { migrate, readMigrations } from "../lib/migrate.js";
import { TEST_DATABASE_URL, postgresSkipReason } from "../lib/pg-test.js";
import { fetchDailyReport } from "../report/query.js";
import { type QaResult, runChecks } from "./checks.js";
import { QA_DEFAULTS } from "./config.js";
import { fetchWorstQaStatus, saveQaResults } from "./store.js";

const SCHEMA = `test_qa_${process.pid}_${Date.now()}`;
const D = "2026-11-25";

const skip = await postgresSkipReason();

describe("qa_results (integration)", { skip }, () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const stored = async (date = D) =>
    (
      await client.query(
        `SELECT "check", partner, status, message, details FROM qa_results WHERE date = $1 ORDER BY "check", partner NULLS FIRST`,
        [date],
      )
    ).rows;

  before(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    await migrate(client, await readMigrations());
    // Partner a on both days (-60% day over day), partner b only on the day before.
    for (const [partner, date, revenue] of [["a", "2026-11-24", "10.000000"], ["b", "2026-11-24", "5.000000"], ["a", D, "4.000000"]]) {
      await client.query(
        `INSERT INTO revenue_daily (partner, date, site, ad_unit, impressions, revenue_usd, raw_key, fx_source)
         VALUES ($1, $2, 's1', 'top_banner', 1000, $3, 'raw', 'fx')`,
        [partner, date, revenue],
      );
    }
  });

  after(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await client.end();
  });

  it("runs the checks on the views and stores them; a re-run replaces instead of duplicating", async () => {
    const results = runChecks(await fetchDailyReport(client, D), QA_DEFAULTS);
    assert.equal(await saveQaResults(client, D, results), results.length);
    const first = await stored();
    assert.equal(first.length, results.length);
    assert.deepEqual(
      first.filter((r) => r.status !== "pass").map((r) => [r.check, r.partner, r.status]),
      [
        ["day_over_day", "a", "fail"],
        ["missing_partner_day", "b", "fail"],
      ],
    );
    assert.equal(first.find((r) => r.check === "day_over_day").details.revenue_change_pct, "-60.000000");

    await saveQaResults(client, D, results);
    assert.deepEqual(await stored(), first);
  });

  it("a later run with fewer results leaves no stale rows, and other dates are untouched", async () => {
    const other: QaResult = { check: "zero_totals", partner: null, status: "fail", message: "nothing loaded", details: {} };
    await saveQaResults(client, "2026-11-24", [other]);
    await saveQaResults(client, D, [{ ...other, status: "pass", message: "fixed" }]);
    assert.deepEqual(await stored(), [{ check: "zero_totals", partner: null, status: "pass", message: "fixed", details: {} }]);
    assert.equal((await stored("2026-11-24")).length, 1);
  });

  it("the database rejects an unknown status and a duplicate check for the same date and partner", async () => {
    const r: QaResult = { check: "zero_totals", partner: null, status: "pass", message: "x", details: {} };
    await assert.rejects(saveQaResults(client, "2026-11-20", [{ ...r, status: "maybe" as never }]), /qa_results_status_check/);
    await assert.rejects(saveQaResults(client, "2026-11-20", [r, r]), /qa_results_date_check_partner_idx/);
    assert.equal((await stored("2026-11-20")).length, 0);
  });

  it("fetchWorstQaStatus: worst stored status per date, null when QA has not run", async () => {
    const r: QaResult = { check: "zero_totals", partner: null, status: "pass", message: "x", details: {} };
    await saveQaResults(client, "2026-11-10", [r, { ...r, check: "reject_share", partner: "b", status: "warn" }]);
    await saveQaResults(client, "2026-11-11", [r, { ...r, check: "reject_share", partner: "b", status: "warn" }, { ...r, check: "day_over_day", partner: "a", status: "fail" }]);
    await saveQaResults(client, "2026-11-12", [r]);
    assert.equal(await fetchWorstQaStatus(client, "2026-11-10"), "warn");
    assert.equal(await fetchWorstQaStatus(client, "2026-11-11"), "fail");
    assert.equal(await fetchWorstQaStatus(client, "2026-11-12"), "pass");
    assert.equal(await fetchWorstQaStatus(client, "2026-11-13"), null);
  });
});
