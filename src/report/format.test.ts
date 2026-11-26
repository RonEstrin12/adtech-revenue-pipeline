import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeClient } from "../lib/fake-db.js";
import { count, formatReport, share, signedPct, signedUsd, table, usd } from "./format.js";
import { type DailyReport, REPORT_QUERIES, fetchDailyReport } from "./query.js";

const REPORT: DailyReport = {
  date: "2026-11-25",
  totals: { revenue_usd: "2208.320271", impressions: 825356, ecpm_usd: "2.675620", partner_count: 2, row_count: 15 },
  byPartner: [
    { key: "a", revenue_usd: "1444.600000", impressions: 531040, ecpm_usd: "2.720322" },
    { key: "b", revenue_usd: "763.720271", impressions: 294316, ecpm_usd: "2.594899" },
  ],
  bySite: [{ key: "news.co.il", revenue_usd: "1000.000000", impressions: 0, ecpm_usd: null }],
  byAdUnit: [{ key: "video_mid", revenue_usd: "1208.320271", impressions: 125000, ecpm_usd: "9.666562" }],
  dayOverDay: [
    { partner: "a", revenue_usd: "1444.600000", prev_date: "2026-11-24", prev_revenue_usd: "1311.450000", revenue_change_usd: "133.150000", revenue_change_pct: "10.152884" },
    { partner: "b", revenue_usd: "763.720271", prev_date: "2026-11-24", prev_revenue_usd: "829.918378", revenue_change_usd: "-66.198107", revenue_change_pct: "-7.976647" },
    { partner: "c", revenue_usd: "5.000000", prev_date: null, prev_revenue_usd: null, revenue_change_usd: null, revenue_change_pct: null },
  ],
  rejects: [
    { partner: "a", reason: "duplicate", rejected: 1, partner_rejected: 2, loaded: 8, reason_share: "0.100000", reject_share: "0.200000" },
    { partner: "a", reason: "missing_revenue", rejected: 1, partner_rejected: 2, loaded: 8, reason_share: "0.100000", reject_share: "0.200000" },
    { partner: "b", reason: "invalid_date", rejected: 3, partner_rejected: 3, loaded: 7, reason_share: "0.300000", reject_share: "0.300000" },
  ],
};

describe("number formatting", () => {
  it("formats money, counts, signed changes and shares", () => {
    assert.equal(usd("2208.320271"), "$2,208.32");
    assert.equal(usd("-66.198107"), "-$66.20");
    assert.equal(usd(null), "n/a");
    assert.equal(signedUsd("133.15"), "+$133.15");
    assert.equal(signedUsd("-66.198107"), "-$66.20");
    assert.equal(signedUsd("0"), "$0.00");
    assert.equal(count(825356), "825,356");
    assert.equal(signedPct("10.152884"), "+10.15%");
    assert.equal(signedPct("-7.976647"), "-7.98%");
    assert.equal(signedPct(null), "n/a");
    assert.equal(share("0.2"), "20.0%");
    assert.equal(share("1.000000"), "100.0%");
  });

  it("aligns tables: first column left, the rest right", () => {
    assert.deepEqual(table(["k", "value"], [["long key", "1"], ["x", "1,000"]]), [
      "  k         value",
      "  long key      1",
      "  x         1,000",
    ]);
    assert.deepEqual(table(null, [["a", "1"], ["bb", "22"]]), ["  a    1", "  bb  22"]);
    assert.deepEqual(table(null, [["a", "x", "1"], ["b", "yyy", "22"]], 2), ["  a  x     1", "  b  yyy  22"]);
  });
});

describe("formatReport", () => {
  const text = formatReport(REPORT);
  const lines = text.split("\n");

  it("prints the sections in order: totals, partner, site, ad unit, day over day, rejects", () => {
    const order = ["Totals", "By partner", "By site", "By ad unit", "Day over day (revenue vs the previous day)", "Rejected rows (share of rows received)"];
    const at = order.map((h) => lines.indexOf(h));
    assert.ok(at.every((i) => i > 0), `missing a section in:\n${text}`);
    assert.deepEqual([...at].sort((x, y) => x - y), at);
    assert.equal(lines[0], "Daily revenue report for 2026-11-25");
  });

  it("prints totals and breakdown rows", () => {
    assert.ok(lines.includes("  revenue      $2,208.32"), text);
    assert.ok(lines.includes("  impressions    825,356"), text);
    assert.ok(lines.includes("  eCPM             $2.68"), text);
    assert.ok(lines.some((l) => /^  a\s+\$1,444\.60\s+531,040\s+\$2\.72$/.test(l)), text);
    assert.ok(lines.some((l) => /^  video_mid\s+\$1,208\.32\s+125,000\s+\$9\.67$/.test(l)), text);
  });

  it("shows n/a for eCPM with 0 impressions", () => {
    assert.ok(lines.some((l) => /^  news\.co\.il\s+\$1,000\.00\s+0\s+n\/a$/.test(l)), text);
  });

  it("shows day-over-day changes, and n/a when there is no previous day", () => {
    assert.ok(lines.some((l) => /^  a\s+\$1,444\.60\s+\$1,311\.45\s+\+\$133\.15\s+\+10\.15%$/.test(l)), text);
    assert.ok(lines.some((l) => /^  b\s+\$763\.72\s+\$829\.92\s+-\$66\.20\s+-7\.98%$/.test(l)), text);
    assert.ok(lines.some((l) => /^  c\s+\$5\.00\s+no data\s+n\/a\s+n\/a$/.test(l)), text);
  });

  it("shows rejects per reason and one total line per partner", () => {
    assert.ok(lines.some((l) => /^  a\s+duplicate\s+1\s+10\.0%$/.test(l)), text);
    assert.ok(lines.includes("  partner a: 2 rejected of 10 received (20.0%)"), text);
    assert.ok(lines.includes("  partner b: 3 rejected of 10 received (30.0%)"), text);
    assert.equal(lines.filter((l) => l.startsWith("  partner a:")).length, 1);
  });

  it("says so when nothing is loaded for the date", () => {
    const empty = formatReport({ ...REPORT, totals: null, byPartner: [], bySite: [], byAdUnit: [], dayOverDay: [], rejects: [] });
    assert.match(empty, /No revenue loaded for 2026-11-25\. Run npm run load -- 2026-11-25 first\./);
    assert.doesNotMatch(empty, /By partner/);
  });

  it("shows (none) when there are no rejects", () => {
    assert.match(formatReport({ ...REPORT, rejects: [] }), /Rejected rows \(share of rows received\)\n  \(none\)$/);
  });
});

describe("fetchDailyReport", () => {
  it("runs one query per section, all bound to the date", async () => {
    const client = fakeClient({ respond: (t) => (t === REPORT_QUERIES.totals ? [REPORT.totals] : []) });
    const report = await fetchDailyReport(client, "2026-11-25");
    assert.deepEqual(client.log.map((q) => q.text), Object.values(REPORT_QUERIES));
    assert.ok(client.log.every((q) => q.values?.length === 1 && q.values[0] === "2026-11-25"));
    assert.deepEqual(report.totals, REPORT.totals);
    assert.deepEqual(report.byPartner, []);
  });
});
