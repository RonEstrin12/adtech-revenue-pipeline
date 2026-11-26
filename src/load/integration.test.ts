/**
 * Integration test against a real Postgres (docker compose up -d).
 * Uses DATABASE_URL, or the local docker-compose database by default, and works in a
 * throwaway schema that is dropped afterwards, so it never touches the real tables.
 * When the database is unreachable the whole suite is skipped, so `npm test` passes without Docker.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { fixedRates } from "../lib/fx.js";
import { migrate, readMigrations } from "../lib/migrate.js";
import { TEST_DATABASE_URL as URL, postgresSkipReason } from "../lib/pg-test.js";
import { buildPartnerAReport } from "../mock-partners/partner-a-server.js";
import { buildPartnerBCsv } from "../mock-partners/partner-b-drop.js";
import { type Store, validatePartnerDay } from "../validate/run.js";
import { type PartnerDay, loadPartnerDay, readPartnerDay } from "./run.js";

const DATE = "2026-11-25";
const SCHEMA = `test_load_${process.pid}_${Date.now()}`;

async function seededDays(): Promise<Record<string, PartnerDay>> {
  const objects = new Map<string, string>([
    [`partner=a/date=${DATE}/fetched_at=1.json`, JSON.stringify({ data: buildPartnerAReport(DATE) })],
    [`partner=b/date=${DATE}/fetched_at=1.csv`, buildPartnerBCsv(DATE)],
  ]);
  const store: Store = {
    listKeys: async (p) => [...objects.keys()].filter((k) => k.startsWith(p)).sort(),
    getText: async (k) => objects.get(k) ?? "",
    putText: async (k, b) => void objects.set(k, b),
  };
  const days: Record<string, PartnerDay> = {};
  for (const p of ["a", "b"]) {
    await validatePartnerDay(store, p, DATE, fixedRates(3.7));
    const out = await readPartnerDay(store, p, DATE);
    assert.equal(out.status, "ok");
    days[p] = (out as { day: PartnerDay }).day;
  }
  return days;
}

const skip = await postgresSkipReason();

describe("load into Postgres (integration)", { skip }, () => {
  const client = new pg.Client({ connectionString: URL });
  let days: Record<string, PartnerDay>;

  const snapshot = async () =>
    (
      await client.query(
        `SELECT (SELECT count(*)::int FROM revenue_daily WHERE date = $1) AS rows,
                (SELECT COALESCE(SUM(revenue_usd), 0)::text FROM revenue_daily WHERE date = $1) AS revenue,
                (SELECT COALESCE(SUM(impressions), 0)::text FROM revenue_daily WHERE date = $1) AS impressions,
                (SELECT count(*)::int FROM rejected_rows WHERE date = $1) AS rejected`,
        [DATE],
      )
    ).rows[0];

  before(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    const all = await readMigrations();
    assert.deepEqual(await migrate(client, all), all.map((m) => m.version));
    days = await seededDays();
  });

  after(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await client.end();
  });

  it("migrate is a no-op the second time", async () => {
    assert.deepEqual(await migrate(client, await readMigrations()), []);
  });

  it("loads the seeded day and a re-run leaves identical counts and sums", async () => {
    await loadPartnerDay(client, days.a!);
    await loadPartnerDay(client, days.b!);
    const first = await snapshot();
    const expectedRows = days.a!.clean.rows.length + days.b!.clean.rows.length;
    assert.equal(first.rows, expectedRows);
    assert.equal(first.rejected, days.a!.rejected.rows.length + days.b!.rejected.rows.length);

    await loadPartnerDay(client, days.a!);
    await loadPartnerDay(client, days.b!);
    assert.deepEqual(await snapshot(), first);
  });

  it("stores revenue exactly and keeps the original rejected row as JSONB", async () => {
    const expected = days.a!.clean.rows.reduce((s, r) => s + Math.round(r.revenue_usd * 1e6), 0);
    const { rows } = await client.query("SELECT SUM(revenue_usd)::text AS s FROM revenue_daily WHERE partner = 'a' AND date = $1", [DATE]);
    assert.equal(rows[0].s, (expected / 1e6).toFixed(6));
    const fx = await client.query("SELECT DISTINCT fx_source FROM revenue_daily");
    assert.deepEqual(fx.rows, [{ fx_source: "fixed ILS/USD 3.7" }]);
    const rej = await client.query("SELECT original_row, raw_key FROM rejected_rows WHERE partner = 'b' AND reason = 'invalid_date'");
    assert.equal(rej.rows.length, 1);
    assert.equal(typeof rej.rows[0].original_row, "object");
    assert.equal(rej.rows[0].raw_key, days.b!.rawKey);
  });

  it("replaces a partner-day when a smaller corrected file is loaded", async () => {
    const smaller: PartnerDay = {
      ...days.a!,
      clean: { ...days.a!.clean, count: 3, rows: days.a!.clean.rows.slice(0, 3) },
      rejected: { ...days.a!.rejected, count: 0, rows: [] },
    };
    await loadPartnerDay(client, smaller);
    const { rows } = await client.query(
      "SELECT (SELECT count(*)::int FROM revenue_daily WHERE partner = 'a') AS r, (SELECT count(*)::int FROM rejected_rows WHERE partner = 'a') AS j",
    );
    assert.deepEqual(rows[0], { r: 3, j: 0 });
    await loadPartnerDay(client, days.a!); // restore
  });

  it("a failing load rolls back and leaves the previous load intact", async () => {
    const before = await snapshot();
    const bad: PartnerDay = {
      ...days.b!,
      clean: { ...days.b!.clean, rows: [...days.b!.clean.rows.slice(1), { ...days.b!.clean.rows[0]!, revenue_usd: -1 }] },
    };
    await assert.rejects(loadPartnerDay(client, bad), /revenue_daily_revenue_usd_check/);
    assert.deepEqual(await snapshot(), before);
  });
});
