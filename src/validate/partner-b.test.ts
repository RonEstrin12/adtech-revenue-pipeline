import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixedRates } from "../lib/fx.js";
import { buildPartnerBCsv } from "../mock-partners/partner-b-drop.js";
import { validatePartnerB } from "./partner-b.js";

const DATE = "2026-11-25";
const KEY = "partner=b/date=2026-11-25/fetched_at=x.csv";
const fx = fixedRates(4); // a round rate keeps the expected numbers obvious
const HEADER = "Date,Website,Placement,Impressions,Revenue,Currency\n";

describe("validatePartnerB on the seeded file", () => {
  const csv = buildPartnerBCsv(DATE);
  const lines = csv.trim().split("\n").slice(1).map((l) => l.split(","));
  const { clean, rejected } = validatePartnerB(csv, KEY, DATE, fx);

  it("keeps 7 clean rows and rejects exactly the deliberate problems", () => {
    assert.equal(clean.length, 7);
    assert.deepEqual(
      rejected.map((r) => [r.line, r.reason]),
      [
        [4, "negative_impressions"],
        [7, "invalid_date"],
        [10, "duplicate"],
      ],
    );
    assert.deepEqual(rejected[1].row, {
      Date: "2026-13-45",
      Website: lines[6][1],
      Placement: lines[6][2],
      Impressions: lines[6][3],
      Revenue: lines[6][4],
      Currency: "USD",
    });
  });

  it("strips the currency symbol and converts ILS to USD", () => {
    const [, site, unit, imps, revenue] = lines[5];
    assert.match(revenue, /^₪/);
    const row = clean.find((r) => r.site === site && r.ad_unit === unit);
    assert.ok(row);
    assert.equal(row.impressions, Number(imps));
    assert.equal(row.revenue_usd, Number(revenue.slice(1)) / 4);
  });

  it("leaves USD rows unconverted", () => {
    const [, site, unit, , revenue, currency] = lines[7];
    assert.equal(currency, "USD");
    assert.equal(clean.find((r) => r.site === site && r.ad_unit === unit)?.revenue_usd, Number(revenue));
  });

  it("converts DD/MM/YYYY to ISO and records lineage", () => {
    assert.ok(clean.every((r) => r.date === DATE && r.partner === "b" && r.raw_key === KEY));
  });
});

describe("validatePartnerB edge cases", () => {
  const reasons = (line: string) => validatePartnerB(HEADER + line + "\n", KEY, DATE, fx).rejected.map((r) => r.reason);

  it("rejects bad fields with a specific reason", () => {
    assert.deepEqual(reasons("30/02/2026,news.co.il,sidebar,10,1.00,ILS"), ["invalid_date"]);
    assert.deepEqual(reasons("24/11/2026,news.co.il,sidebar,10,1.00,ILS"), ["date_mismatch"]);
    assert.deepEqual(reasons("25/11/2026,news.co.il,sidebar,,1.00,ILS"), ["missing_impressions"]);
    assert.deepEqual(reasons("25/11/2026,news.co.il,sidebar,10,,ILS"), ["missing_revenue"]);
    assert.deepEqual(reasons("25/11/2026,news.co.il,sidebar,10,1.00,EUR"), ["unknown_currency"]);
    assert.deepEqual(reasons("25/11/2026,news.co.il,sidebar,10,$1.00,ILS"), ["currency_mismatch"]);
  });

  it("accepts quoted fields and a symbol with spaces", () => {
    const r = validatePartnerB(HEADER + '25/11/2026,"News.co.il ",sidebar,10,"₪ 8.00",ILS\n', KEY, DATE, fx);
    assert.deepEqual(r.rejected, []);
    assert.equal(r.clean[0].site, "news.co.il");
    assert.equal(r.clean[0].revenue_usd, 2);
  });

  it("throws when a column is missing", () => {
    assert.throws(() => validatePartnerB("Date,Website\n", KEY, DATE, fx), /missing columns: Placement/);
  });
});
