import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CanonicalRow, RejectedRow } from "../validate/types.js";
import {
  buildInsert,
  deletePartnerDayStatements,
  insertRejectedStatements,
  insertRevenueStatements,
  lockPartnerDayStatement,
  moneyParam,
} from "./sql.js";

const row = (site: string, revenue: number): CanonicalRow => ({
  date: "2026-11-25", partner: "b", site, ad_unit: "sidebar", impressions: 100, revenue_usd: revenue, raw_key: "partner=b/x.csv",
});

describe("buildInsert", () => {
  it("numbers parameters across rows and applies casts", () => {
    const s = buildInsert("t", ["a", "b"], [[1, "x"], [2, "y"]], { b: "jsonb" });
    assert.equal(s.text, "INSERT INTO t (a, b) VALUES ($1, $2::jsonb), ($3, $4::jsonb)");
    assert.deepEqual(s.values, [1, "x", 2, "y"]);
  });

  it("keeps hostile values out of the SQL text", () => {
    const s = buildInsert("t", ["a"], [["'); DROP TABLE t; --"]]);
    assert.equal(s.text, "INSERT INTO t (a) VALUES ($1)");
  });

  it("rejects empty input and ragged rows", () => {
    assert.throws(() => buildInsert("t", ["a"], []), /at least one row/);
    assert.throws(() => buildInsert("t", ["a", "b"], [[1]]), /expected 2 values/);
  });
});

describe("insertRevenueStatements", () => {
  it("maps canonical rows to revenue_daily columns, money as an exact decimal string", () => {
    const [s, ...rest] = insertRevenueStatements([row("news.co.il", 189.040541)], "fixed ILS/USD 3.7");
    assert.equal(rest.length, 0);
    assert.match(s!.text, /^INSERT INTO revenue_daily \(partner, date, site, ad_unit, impressions, revenue_usd, raw_key, fx_source\)/);
    assert.deepEqual(s!.values, ["b", "2026-11-25", "news.co.il", "sidebar", 100, "189.040541", "partner=b/x.csv", "fixed ILS/USD 3.7"]);
  });

  it("splits large days into chunks and returns nothing for an empty day", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`s${i}`, i));
    assert.deepEqual(insertRevenueStatements(rows, "fx", 2).map((s) => s.values.length / 8), [2, 2, 1]);
    assert.deepEqual(insertRevenueStatements([], "fx"), []);
  });

  it("formats money without float noise", () => {
    assert.equal(moneyParam(0.1 + 0.2), "0.300000");
    assert.equal(moneyParam(1234), "1234.000000");
  });
});

describe("insertRejectedStatements", () => {
  it("stores the original row as JSONB and a missing detail as NULL", () => {
    const rejected: RejectedRow[] = [
      { raw_key: "k", line: 3, reason: "invalid_date", detail: "13/45", row: { Date: "45/13/2026", Revenue: "₪1" } },
      { raw_key: "k", line: 4, reason: "duplicate", row: undefined },
    ];
    const [s] = insertRejectedStatements("b", "2026-11-25", rejected);
    assert.match(s!.text, /\(partner, date, reason, detail, raw_key, line, original_row\)/);
    assert.match(s!.text, /\$7::jsonb\), \(.*\$14::jsonb\)$/);
    assert.deepEqual(s!.values, [
      "b", "2026-11-25", "invalid_date", "13/45", "k", 3, '{"Date":"45/13/2026","Revenue":"₪1"}',
      "b", "2026-11-25", "duplicate", null, "k", 4, "null",
    ]);
  });
});

describe("partner-day statements", () => {
  it("deletes from both tables, scoped to partner and date", () => {
    const [rev, rej] = deletePartnerDayStatements("a", "2026-11-25");
    assert.equal(rev!.text, "DELETE FROM revenue_daily WHERE partner = $1 AND date = $2");
    assert.equal(rej!.text, "DELETE FROM rejected_rows WHERE partner = $1 AND date = $2");
    assert.deepEqual(rev!.values, ["a", "2026-11-25"]);
  });

  it("locks on the partner-day", () => {
    assert.deepEqual(lockPartnerDayStatement("a", "2026-11-25").values, ["load:a:2026-11-25"]);
  });
});
