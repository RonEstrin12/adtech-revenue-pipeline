/**
 * Integration test for the stage 5 views (db/migrations/002_analysis_views.sql) against a real
 * Postgres (docker compose up -d). Works in a throwaway schema with hand-written rows whose
 * results are computed by hand below; skipped when the database is unreachable.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { migrate, readMigrations } from "../lib/migrate.js";
import { TEST_DATABASE_URL, postgresSkipReason } from "../lib/pg-test.js";
import { fetchDailyReport } from "./query.js";

const SCHEMA = `test_views_${process.pid}_${Date.now()}`;
const D = "2026-11-25";

// partner, date, site, ad_unit, impressions, revenue_usd
const REVENUE: [string, string, string, string, number, string][] = [
  ["a", "2026-11-21", "s1", "top_banner", 0, "0.500000"], // a day with 0 impressions in total
  ["c", "2026-11-23", "s3", "video_mid", 100, "1.000000"], // c skips 11-24: no previous day on 11-25
  ["a", "2026-11-24", "s1", "top_banner", 1000, "2.000000"],
  ["a", "2026-11-24", "s2", "sidebar", 3000, "3.000000"],
  ["b", "2026-11-24", "s1", "top_banner", 2000, "10.000000"],
  ["d", "2026-11-24", "s3", "sidebar", 10, "0.000000"], // previous revenue 0: change % is NULL
  ["a", D, "s1", "top_banner", 2000, "4.500000"],
  ["a", D, "s2", "sidebar", 0, "1.000000"], // impressions 0 on a row with revenue
  ["b", D, "s1", "top_banner", 1000, "5.000000"],
  ["c", D, "s3", "video_mid", 0, "0.000000"], // partner c and video_mid: eCPM NULL
  ["d", D, "s3", "sidebar", 500, "2.000000"],
];

// partner, date, reason
const REJECTED: [string, string, string][] = [
  ["a", D, "duplicate"],
  ["a", D, "duplicate"],
  ["a", D, "missing_revenue"],
  ["e", D, "invalid_date"], // a partner-day where every row was rejected
  ["a", "2026-11-24", "duplicate"], // another day: must not leak into D
];

const skip = await postgresSkipReason();

describe("analysis views (integration)", { skip }, () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const one = async (sql: string, values: unknown[] = []) => (await client.query(sql, values)).rows;

  before(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    await migrate(client, await readMigrations());
    for (const [partner, date, site, ad_unit, impressions, revenue] of REVENUE) {
      await client.query(
        `INSERT INTO revenue_daily (partner, date, site, ad_unit, impressions, revenue_usd, raw_key, fx_source)
         VALUES ($1, $2, $3, $4, $5, $6, 'raw', 'fx')`,
        [partner, date, site, ad_unit, impressions, revenue],
      );
    }
    for (const [i, [partner, date, reason]] of REJECTED.entries()) {
      await client.query(
        `INSERT INTO rejected_rows (partner, date, reason, raw_key, line, original_row) VALUES ($1, $2, $3, 'raw', $4, '{}')`,
        [partner, date, reason, i + 1],
      );
    }
  });

  after(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await client.end();
  });

  it("the views migration can be run again (CREATE OR REPLACE)", async () => {
    const views = (await readMigrations()).find((m) => m.version === "002_analysis_views.sql");
    assert.ok(views);
    await client.query(views.sql);
  });

  it("v_daily_totals: sums, eCPM, partner and row counts", async () => {
    const rows = await one(
      `SELECT revenue_usd::text, impressions::text, ecpm_usd::text, partner_count::int, row_count::int
       FROM v_daily_totals WHERE date = $1`,
      [D],
    );
    // 4.5 + 1 + 5 + 0 + 2 = 12.5 over 3,500 impressions -> 12.5 / 3500 * 1000 = 3.5714285...
    assert.deepEqual(rows, [{ revenue_usd: "12.500000", impressions: "3500", ecpm_usd: "3.571429", partner_count: 4, row_count: 5 }]);
  });

  it("eCPM is NULL, not an error, when impressions are 0", async () => {
    const totals = await one("SELECT revenue_usd::text, ecpm_usd FROM v_daily_totals WHERE date = '2026-11-21'");
    assert.deepEqual(totals, [{ revenue_usd: "0.500000", ecpm_usd: null }]);
    assert.equal(await one("SELECT analysis_ecpm(0, 0) AS e").then((r) => r[0].e), null);
  });

  it("v_daily_by_partner, v_daily_by_site, v_daily_by_ad_unit", async () => {
    const report = await fetchDailyReport(client, D);
    // Ordered by revenue, highest first.
    assert.deepEqual(report.byPartner, [
      { key: "a", revenue_usd: "5.500000", impressions: 2000, ecpm_usd: "2.750000" },
      { key: "b", revenue_usd: "5.000000", impressions: 1000, ecpm_usd: "5.000000" },
      { key: "d", revenue_usd: "2.000000", impressions: 500, ecpm_usd: "4.000000" },
      { key: "c", revenue_usd: "0.000000", impressions: 0, ecpm_usd: null },
    ]);
    assert.deepEqual(report.bySite, [
      { key: "s1", revenue_usd: "9.500000", impressions: 3000, ecpm_usd: "3.166667" },
      { key: "s3", revenue_usd: "2.000000", impressions: 500, ecpm_usd: "4.000000" },
      { key: "s2", revenue_usd: "1.000000", impressions: 0, ecpm_usd: null },
    ]);
    assert.deepEqual(report.byAdUnit, [
      { key: "top_banner", revenue_usd: "9.500000", impressions: 3000, ecpm_usd: "3.166667" },
      { key: "sidebar", revenue_usd: "3.000000", impressions: 500, ecpm_usd: "6.000000" },
      { key: "video_mid", revenue_usd: "0.000000", impressions: 0, ecpm_usd: null },
    ]);
    assert.deepEqual(await one("SELECT site, partner_count::int FROM v_daily_by_site WHERE date = $1 ORDER BY site", [D]), [
      { site: "s1", partner_count: 2 },
      { site: "s2", partner_count: 1 },
      { site: "s3", partner_count: 2 },
    ]);
  });

  it("v_partner_day_over_day: change vs the previous calendar day only", async () => {
    const report = await fetchDailyReport(client, D);
    assert.deepEqual(report.dayOverDay, [
      // 5.5 vs 5.0: +0.5, +10%
      { partner: "a", revenue_usd: "5.500000", prev_date: "2026-11-24", prev_revenue_usd: "5.000000", revenue_change_usd: "0.500000", revenue_change_pct: "10.000000" },
      // 5 vs 10: -5, -50%
      { partner: "b", revenue_usd: "5.000000", prev_date: "2026-11-24", prev_revenue_usd: "10.000000", revenue_change_usd: "-5.000000", revenue_change_pct: "-50.000000" },
      // last data on 11-23, not 11-24: no comparison
      { partner: "c", revenue_usd: "0.000000", prev_date: null, prev_revenue_usd: null, revenue_change_usd: null, revenue_change_pct: null },
      // previous revenue 0: absolute change only
      { partner: "d", revenue_usd: "2.000000", prev_date: "2026-11-24", prev_revenue_usd: "0.000000", revenue_change_usd: "2.000000", revenue_change_pct: null },
    ]);
    const first = await one("SELECT prev_date, revenue_change_usd FROM v_partner_day_over_day WHERE partner = 'b' AND date = '2026-11-24'");
    assert.deepEqual(first, [{ prev_date: null, revenue_change_usd: null }]);
  });

  it("v_reject_summary: counts and share of rows received, per day", async () => {
    const report = await fetchDailyReport(client, D);
    // partner a: 3 rejected + 2 loaded = 5 received
    assert.deepEqual(report.rejects, [
      { partner: "a", reason: "duplicate", rejected: 2, partner_rejected: 3, loaded: 2, reason_share: "0.400000", reject_share: "0.600000" },
      { partner: "a", reason: "missing_revenue", rejected: 1, partner_rejected: 3, loaded: 2, reason_share: "0.200000", reject_share: "0.600000" },
      { partner: "e", reason: "invalid_date", rejected: 1, partner_rejected: 1, loaded: 0, reason_share: "1.000000", reject_share: "1.000000" },
    ]);
  });

  it("a date with nothing loaded gives an empty report", async () => {
    const report = await fetchDailyReport(client, "2026-01-01");
    assert.deepEqual(report, { date: "2026-01-01", totals: null, byPartner: [], bySite: [], byAdUnit: [], dayOverDay: [], rejects: [] });
  });
});
