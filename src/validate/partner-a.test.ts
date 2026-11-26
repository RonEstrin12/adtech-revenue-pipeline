import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPartnerAReport } from "../mock-partners/partner-a-server.js";
import { validatePartnerA } from "./partner-a.js";

const DATE = "2026-11-25";
const KEY = "partner=a/date=2026-11-25/fetched_at=x.json";
const envelope = (data: unknown[]) => JSON.stringify({ partner: "A", date: DATE, count: data.length, data });

describe("validatePartnerA on the seeded report", () => {
  const report = buildPartnerAReport(DATE);
  const { clean, rejected } = validatePartnerA(envelope(report), KEY, DATE);

  it("keeps 8 clean rows and rejects exactly the deliberate problems", () => {
    assert.equal(clean.length, 8);
    assert.deepEqual(
      rejected.map((r) => [r.line, r.reason]),
      [
        [5, "missing_revenue"],
        [10, "duplicate"],
      ],
    );
  });

  it("normalizes whitespace and casing in site names", () => {
    assert.equal(report[1].site, "  News.co.il ");
    const row = clean.find((r) => r.ad_unit === report[1].unit && r.site === "news.co.il");
    assert.ok(row);
    assert.equal(row.impressions, report[1].imps);
    assert.deepEqual([...new Set(clean.map((r) => r.site))].sort(), ["news.co.il", "recipes.co.il", "sports.co.il"]);
  });

  it("maps to canonical rows with lineage and keeps the original record on rejects", () => {
    assert.deepEqual(clean[0], {
      date: DATE,
      partner: "a",
      site: "news.co.il",
      ad_unit: report[0].unit,
      impressions: report[0].imps,
      revenue_usd: report[0].rev_usd,
      raw_key: KEY,
    });
    assert.deepEqual(rejected[0].row, report[4]);
    assert.equal(rejected[0].raw_key, KEY);
  });

  it("has one row per site and ad unit", () => {
    const keys = clean.map((r) => `${r.site}|${r.ad_unit}`);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe("validatePartnerA edge cases", () => {
  const base = { day: DATE, site: "news.co.il", unit: "sidebar", imps: 10, rev_usd: 1.5 };
  const reasons = (records: unknown[]) => validatePartnerA(envelope(records), KEY, DATE).rejected.map((r) => r.reason);

  it("rejects bad fields with a specific reason", () => {
    assert.deepEqual(reasons([{ ...base, day: "2026-02-30" }]), ["invalid_date"]);
    assert.deepEqual(reasons([{ ...base, day: "2026-11-24" }]), ["date_mismatch"]);
    assert.deepEqual(reasons([{ ...base, site: "   " }]), ["missing_site"]);
    assert.deepEqual(reasons([{ ...base, unit: "popup" }]), ["unknown_ad_unit"]);
    assert.deepEqual(reasons([{ ...base, imps: null }]), ["missing_impressions"]);
    assert.deepEqual(reasons([{ ...base, imps: 1.5 }]), ["invalid_impressions"]);
    assert.deepEqual(reasons([{ ...base, imps: -1 }]), ["negative_impressions"]);
    assert.deepEqual(reasons([{ ...base, rev_usd: -2 }]), ["negative_revenue"]);
    assert.deepEqual(reasons([{ ...base, rev_usd: "abc" }]), ["invalid_revenue"]);
  });

  it("flags a repeated key with different numbers as a conflict, keeping the first", () => {
    const { clean, rejected } = validatePartnerA(envelope([base, { ...base, imps: 99 }]), KEY, DATE);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].impressions, 10);
    assert.equal(rejected[0].reason, "duplicate_conflict");
  });

  it("dedupes rows that only match after site normalization", () => {
    const { clean, rejected } = validatePartnerA(envelope([base, { ...base, site: " NEWS.co.il" }]), KEY, DATE);
    assert.equal(clean.length, 1);
    assert.equal(rejected[0].reason, "duplicate");
  });

  it("throws on a file it cannot read", () => {
    assert.throws(() => validatePartnerA("not json", KEY, DATE), /not valid JSON/);
    assert.throws(() => validatePartnerA("{}", KEY, DATE), /no "data" array/);
  });
});
