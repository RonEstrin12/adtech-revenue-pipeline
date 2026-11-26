import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DailyReport, DayOverDay, RejectLine } from "../report/query.js";
import { checkDayOverDay, checkMissingPartnerDays, checkRejectShare, checkZeroTotals, runChecks, worstStatus } from "./checks.js";
import { QA_DEFAULTS, type QaConfig, alertMode, loadQaConfig } from "./config.js";
import { formatQaSummary } from "./format.js";

const D = "2026-11-25";
const CONFIG: QaConfig = QA_DEFAULTS;

/** The real 2026-11-25 numbers from the seeded partners (npm run report -- 2026-11-25). */
const SEEDED: DailyReport = {
  date: D,
  totals: { revenue_usd: "2208.320271", impressions: 825356, ecpm_usd: "2.675620", partner_count: 2, row_count: 15 },
  byPartner: [
    { key: "a", revenue_usd: "1444.600000", impressions: 531040, ecpm_usd: "2.720322" },
    { key: "b", revenue_usd: "763.720271", impressions: 294316, ecpm_usd: "2.594899" },
  ],
  bySite: [],
  byAdUnit: [],
  dayOverDay: [
    { partner: "a", revenue_usd: "1444.600000", prev_date: "2026-11-24", prev_revenue_usd: "1311.450000", revenue_change_usd: "133.150000", revenue_change_pct: "10.152884" },
    { partner: "b", revenue_usd: "763.720271", prev_date: "2026-11-24", prev_revenue_usd: "829.918378", revenue_change_usd: "-66.198107", revenue_change_pct: "-7.976460" },
  ],
  rejects: [
    { partner: "a", reason: "duplicate", rejected: 1, partner_rejected: 2, loaded: 8, reason_share: "0.100000", reject_share: "0.200000" },
    { partner: "a", reason: "missing_revenue", rejected: 1, partner_rejected: 2, loaded: 8, reason_share: "0.100000", reject_share: "0.200000" },
    { partner: "b", reason: "duplicate", rejected: 1, partner_rejected: 3, loaded: 7, reason_share: "0.100000", reject_share: "0.300000" },
    { partner: "b", reason: "invalid_date", rejected: 1, partner_rejected: 3, loaded: 7, reason_share: "0.100000", reject_share: "0.300000" },
    { partner: "b", reason: "negative_impressions", rejected: 1, partner_rejected: 3, loaded: 7, reason_share: "0.100000", reject_share: "0.300000" },
  ],
};

const status = (results: { partner: string | null; status: string }[]) =>
  Object.fromEntries(results.map((r) => [r.partner ?? "day", r.status]));

const rejectLine = (partner: string, rejected: number, loaded: number): RejectLine => ({
  partner,
  reason: "duplicate",
  rejected,
  partner_rejected: rejected,
  loaded,
  reason_share: (rejected / (rejected + loaded)).toFixed(6),
  reject_share: (rejected / (rejected + loaded)).toFixed(6),
});

const dod = (partner: string, pct: string | null, prev: string | null = "100.000000", prevDate: string | null = "2026-11-24"): DayOverDay => ({
  partner,
  revenue_usd: "120.000000",
  prev_date: prevDate,
  prev_revenue_usd: prev,
  revenue_change_usd: prev === null ? null : "20.000000",
  revenue_change_pct: pct,
});

describe("config", () => {
  it("uses the documented defaults when nothing is set", () => {
    assert.deepEqual(loadQaConfig({}), QA_DEFAULTS);
    assert.deepEqual(QA_DEFAULTS, { expectedPartners: ["a", "b"], warnRejectShare: 0.25, maxRejectShare: 0.4, warnDodChangePct: 25, maxDodChangePct: 50 });
  });

  it("reads the environment, normalizing the partner list", () => {
    const c = loadQaConfig({ QA_EXPECTED_PARTNERS: " A, b ,c,,a", QA_MAX_REJECT_SHARE: "0.5", QA_WARN_REJECT_SHARE: "0.1", QA_MAX_DOD_CHANGE_PCT: "80", QA_WARN_DOD_CHANGE_PCT: "" });
    assert.deepEqual(c, { expectedPartners: ["a", "b", "c"], warnRejectShare: 0.1, maxRejectShare: 0.5, warnDodChangePct: 25, maxDodChangePct: 80 });
  });

  it("clamps a warn level above the fail level", () => {
    const c = loadQaConfig({ QA_MAX_REJECT_SHARE: "0.1", QA_MAX_DOD_CHANGE_PCT: "5" });
    assert.equal(c.warnRejectShare, 0.1);
    assert.equal(c.warnDodChangePct, 5);
  });

  it("rejects invalid numbers", () => {
    assert.throws(() => loadQaConfig({ QA_MAX_REJECT_SHARE: "40%" }), /QA_MAX_REJECT_SHARE/);
    assert.throws(() => loadQaConfig({ QA_MAX_REJECT_SHARE: "1.5" }), /between 0 and 1/);
    assert.throws(() => loadQaConfig({ QA_MAX_DOD_CHANGE_PCT: "-1" }), /QA_MAX_DOD_CHANGE_PCT/);
  });

  it("alerts are a dry run unless QA_ALERTS=github", () => {
    assert.equal(alertMode({}), "dry-run");
    assert.equal(alertMode({ QA_ALERTS: "slack" }), "dry-run");
    assert.equal(alertMode({ QA_ALERTS: "GitHub" }), "github");
  });
});

describe("missing partner-day", () => {
  it("passes when every expected partner has rows", () => {
    assert.deepEqual(status(checkMissingPartnerDays(SEEDED, CONFIG)), { a: "pass", b: "pass" });
  });

  it("fails for an expected partner without rows, and says when all its rows were rejected", () => {
    const report = { ...SEEDED, byPartner: SEEDED.byPartner.filter((p) => p.key === "a") };
    const results = checkMissingPartnerDays(report, { ...CONFIG, expectedPartners: ["a", "b", "c"] });
    assert.deepEqual(status(results), { a: "pass", b: "fail", c: "fail" });
    assert.match(results[1]!.message, /partner b has no loaded rows for 2026-11-25: all 3 rows were rejected/);
    assert.match(results[2]!.message, /partner c has no rows for 2026-11-25/);
  });

  it("fails every expected partner on an empty day", () => {
    const empty = { ...SEEDED, totals: null, byPartner: [], dayOverDay: [], rejects: [] };
    assert.deepEqual(status(checkMissingPartnerDays(empty, CONFIG)), { a: "fail", b: "fail" });
  });
});

describe("reject share", () => {
  it("seeded data: partner A's 20% passes, partner B's 30% warns", () => {
    const results = checkRejectShare(SEEDED, CONFIG);
    assert.deepEqual(status(results), { a: "pass", b: "warn" });
    assert.equal(results[1]!.message, "partner b rejected 3 of 10 rows (30.0%) (warn above 25.0%)");
    assert.deepEqual(results[1]!.details.reasons, { duplicate: 1, invalid_date: 1, negative_impressions: 1 });
  });

  it("boundaries: equal to a limit stays below it, just above crosses it", () => {
    const at = (share: [number, number]) =>
      checkRejectShare({ ...SEEDED, byPartner: [], rejects: [rejectLine("x", ...share)] }, { ...CONFIG, warnRejectShare: 0.25, maxRejectShare: 0.4 })[0]!.status;
    assert.equal(at([1, 3]), "pass"); // 0.25 exactly
    assert.equal(at([1001, 2999]), "warn"); // 0.25025
    assert.equal(at([2, 3]), "warn"); // 0.4 exactly
    assert.equal(at([4001, 5999]), "fail"); // 0.4001
    assert.equal(at([5, 0]), "fail"); // every row rejected
  });

  it("a partner with no rejects passes at 0%", () => {
    const results = checkRejectShare({ ...SEEDED, rejects: SEEDED.rejects.filter((r) => r.partner === "b") }, CONFIG);
    assert.equal(results[0]!.partner, "a");
    assert.equal(results[0]!.status, "pass");
    assert.equal(results[0]!.message, "partner a rejected no rows");
  });

  it("a zero threshold fails any reject", () => {
    assert.deepEqual(status(checkRejectShare(SEEDED, { ...CONFIG, warnRejectShare: 0, maxRejectShare: 0.2 })), { a: "warn", b: "fail" });
  });
});

describe("day over day", () => {
  it("seeded data: +10.15% and -7.98% pass", () => {
    const results = checkDayOverDay(SEEDED, CONFIG);
    assert.deepEqual(status(results), { a: "pass", b: "pass" });
    assert.equal(results[0]!.message, "partner a: revenue +10.15% vs 2026-11-24 ($1,311.45 -> $1,444.60)");
  });

  it("boundaries in both directions", () => {
    const at = (pct: string) => checkDayOverDay({ ...SEEDED, dayOverDay: [dod("x", pct)] }, CONFIG)[0]!.status;
    assert.equal(at("25.000000"), "pass");
    assert.equal(at("-25.000000"), "pass");
    assert.equal(at("25.000001"), "warn");
    assert.equal(at("-50.000000"), "warn");
    assert.equal(at("50.000001"), "fail");
    assert.equal(at("-50.000001"), "fail");
    assert.equal(at("-100.000000"), "fail");
  });

  it("no previous day passes; previous revenue 0 warns unless today is also 0", () => {
    const results = checkDayOverDay(
      { ...SEEDED, dayOverDay: [dod("first", null, null, null), dod("fromzero", null, "0.000000"), { ...dod("stillzero", null, "0.000000"), revenue_usd: "0.000000" }] },
      CONFIG,
    );
    assert.deepEqual(status(results), { first: "pass", fromzero: "warn", stillzero: "pass" });
    assert.match(results[0]!.message, /no data for the previous day/);
    assert.match(results[1]!.message, /vs \$0\.00 on 2026-11-24, change % undefined/);
  });

  it("the fail message names the limit", () => {
    const [r] = checkDayOverDay({ ...SEEDED, dayOverDay: [dod("b", "-60.000000")] }, CONFIG);
    assert.match(r!.message, /revenue -60\.00% .*\(fail beyond ±50%\)$/);
  });
});

describe("zero totals", () => {
  it("seeded data passes for the day and each partner", () => {
    assert.deepEqual(status(checkZeroTotals(SEEDED)), { day: "pass", a: "pass", b: "pass" });
  });

  it("fails on nothing loaded", () => {
    const results = checkZeroTotals({ ...SEEDED, totals: null, byPartner: [] });
    assert.deepEqual(status(results), { day: "fail" });
    assert.equal(results[0]!.message, "nothing loaded for 2026-11-25");
  });

  it("fails on 0 revenue or 0 impressions, for the day and per partner", () => {
    const report: DailyReport = {
      ...SEEDED,
      totals: { ...SEEDED.totals!, impressions: 0 },
      byPartner: [
        { key: "b", revenue_usd: "0.000000", impressions: 0, ecpm_usd: null },
        { key: "a", revenue_usd: "0.000000", impressions: 5, ecpm_usd: "0" },
        { key: "c", revenue_usd: "0.000001", impressions: 1, ecpm_usd: "0.001" }, // smallest non-zero amounts pass
      ],
    };
    const results = checkZeroTotals(report);
    assert.deepEqual(status(results), { day: "fail", a: "fail", b: "fail", c: "pass" });
    assert.equal(results[0]!.message, "impressions 0 for 2026-11-25");
    assert.equal(results[2]!.message, "partner b: revenue and impressions 0 for 2026-11-25");
  });
});

describe("runChecks and summary", () => {
  it("seeded day: 9 results, worst is warn", () => {
    const results = runChecks(SEEDED, CONFIG);
    assert.equal(results.length, 2 + 2 + 2 + 3);
    assert.equal(worstStatus(results), "warn");
    assert.equal(worstStatus(results.filter((r) => r.status === "pass")), "pass");
    assert.equal(worstStatus([...results, { ...results[0]!, status: "fail" }]), "fail");
  });

  it("prints one line per result and the overall outcome", () => {
    const text = formatQaSummary(D, runChecks(SEEDED, CONFIG));
    const lines = text.split("\n");
    assert.equal(lines[0], "QA checks for 2026-11-25");
    assert.ok(lines.some((l) => /^  WARN\s+reject_share\s+b\s+partner b rejected 3 of 10 rows/.test(l)), text);
    assert.ok(lines.some((l) => /^  pass\s+zero_totals\s+-\s+day totals/.test(l)), text);
    assert.equal(lines.at(-1), "Result: WARN (0 fail, 1 warn, 8 pass)");
  });
});
