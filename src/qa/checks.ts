/**
 * Stage 6: QA checks for one day. Pure functions over the stage 5 DailyReport (src/report/query.ts),
 * so tests feed in rows without a database.
 *
 * Every check returns one result per partner (or one for the whole day) with pass, warn or fail
 * and a message a person can act on. Thresholds come from QaConfig (src/qa/config.ts).
 */
import { count, usd } from "../report/format.js";
import type { DailyReport } from "../report/query.js";
import type { QaConfig } from "./config.js";

export type QaStatus = "pass" | "warn" | "fail";
export type QaCheck = "missing_partner_day" | "reject_share" | "day_over_day" | "zero_totals";

export interface QaResult {
  check: QaCheck;
  partner: string | null; // null: about the whole day
  status: QaStatus;
  message: string;
  details: Record<string, unknown>;
}

const pct = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;
const signedPct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;

/** Higher of two levels: value > max fails, value > warn warns, otherwise passes. Equal to a limit is still inside it. */
function level(value: number, warn: number, max: number): QaStatus {
  if (value > max) return "fail";
  if (value > warn) return "warn";
  return "pass";
}

/** 1. Each expected partner has revenue rows for the date. */
export function checkMissingPartnerDays(report: DailyReport, config: QaConfig): QaResult[] {
  const loaded = new Map(report.byPartner.map((p) => [p.key, p]));
  const rejected = new Map(report.rejects.map((r) => [r.partner, r.partner_rejected]));
  return config.expectedPartners.map((partner): QaResult => {
    const row = loaded.get(partner);
    if (row) {
      return {
        check: "missing_partner_day",
        partner,
        status: "pass",
        message: `partner ${partner} reported for ${report.date}`,
        details: { revenue_usd: row.revenue_usd, impressions: row.impressions },
      };
    }
    const rejects = rejected.get(partner) ?? 0;
    return {
      check: "missing_partner_day",
      partner,
      status: "fail",
      message:
        rejects > 0
          ? `partner ${partner} has no loaded rows for ${report.date}: all ${rejects} rows were rejected`
          : `partner ${partner} has no rows for ${report.date}: check ingest, validate and load for that day`,
      details: { rejected: rejects },
    };
  });
}

/** 2. Share of the partner's rows that were rejected, out of all rows received. */
export function checkRejectShare(report: DailyReport, config: QaConfig): QaResult[] {
  // Every partner with loaded or rejected rows; one with loaded rows and no reject line rejected nothing.
  const partners = [...new Set([...report.byPartner.map((p) => p.key), ...report.rejects.map((r) => r.partner)])].sort();

  return partners.map((partner): QaResult => {
    const line = report.rejects.find((r) => r.partner === partner);
    const rejected = line?.partner_rejected ?? 0;
    const share = line ? Number(line.reject_share) : 0;
    const status = level(share, config.warnRejectShare, config.maxRejectShare);
    const received = line ? line.partner_rejected + line.loaded : undefined;
    const limit = status === "fail" ? ` (fail above ${pct(config.maxRejectShare)})` : status === "warn" ? ` (warn above ${pct(config.warnRejectShare)})` : "";
    return {
      check: "reject_share",
      partner,
      status,
      message: line
        ? `partner ${partner} rejected ${rejected} of ${received} rows (${pct(share)})${limit}`
        : `partner ${partner} rejected no rows`,
      details: {
        reject_share: line?.reject_share ?? "0",
        rejected,
        received: received ?? null,
        reasons: Object.fromEntries(report.rejects.filter((r) => r.partner === partner).map((r) => [r.reason, r.rejected])),
        warn_above: config.warnRejectShare,
        fail_above: config.maxRejectShare,
      },
    };
  });
}

/** 3. Revenue change vs the previous calendar day, per partner. */
export function checkDayOverDay(report: DailyReport, config: QaConfig): QaResult[] {
  return report.dayOverDay.map((d): QaResult => {
    const base = { check: "day_over_day" as const, partner: d.partner };
    const details = {
      revenue_usd: d.revenue_usd,
      prev_date: d.prev_date,
      prev_revenue_usd: d.prev_revenue_usd,
      revenue_change_pct: d.revenue_change_pct,
      warn_above_pct: config.warnDodChangePct,
      fail_above_pct: config.maxDodChangePct,
    };
    if (d.prev_date === null) {
      return { ...base, status: "pass", message: `partner ${d.partner}: no data for the previous day, nothing to compare`, details };
    }
    if (d.revenue_change_pct === null) {
      // Previous revenue was 0: any revenue today is an unbounded change.
      const status: QaStatus = Number(d.revenue_usd) === 0 ? "pass" : "warn";
      return {
        ...base,
        status,
        message: `partner ${d.partner}: revenue ${usd(d.revenue_usd)} vs $0.00 on ${d.prev_date}, change % undefined`,
        details,
      };
    }
    const change = Number(d.revenue_change_pct);
    const status = level(Math.abs(change), config.warnDodChangePct, config.maxDodChangePct);
    const limit = status === "fail" ? ` (fail beyond ±${config.maxDodChangePct}%)` : status === "warn" ? ` (warn beyond ±${config.warnDodChangePct}%)` : "";
    return {
      ...base,
      status,
      message: `partner ${d.partner}: revenue ${signedPct(change)} vs ${d.prev_date} (${usd(d.prev_revenue_usd)} -> ${usd(d.revenue_usd)})${limit}`,
      details,
    };
  });
}

/** 4. Revenue or impressions of 0 for the whole day, or for a partner that did report. */
export function checkZeroTotals(report: DailyReport): QaResult[] {
  const zeros = (revenue: string, impressions: number) =>
    [Number(revenue) === 0 && "revenue", impressions === 0 && "impressions"].filter(Boolean) as string[];

  const t = report.totals;
  const day: QaResult = !t
    ? { check: "zero_totals", partner: null, status: "fail", message: `nothing loaded for ${report.date}`, details: {} }
    : (() => {
        const z = zeros(t.revenue_usd, t.impressions);
        return {
          check: "zero_totals" as const,
          partner: null,
          status: z.length > 0 ? ("fail" as const) : ("pass" as const),
          message: z.length > 0 ? `${z.join(" and ")} 0 for ${report.date}` : `day totals: ${usd(t.revenue_usd)} from ${count(t.impressions)} impressions`,
          details: { revenue_usd: t.revenue_usd, impressions: t.impressions },
        };
      })();

  const partners = report.byPartner.map((p): QaResult => {
    const z = zeros(p.revenue_usd, p.impressions);
    return {
      check: "zero_totals",
      partner: p.key,
      status: z.length > 0 ? "fail" : "pass",
      message: z.length > 0 ? `partner ${p.key}: ${z.join(" and ")} 0 for ${report.date}` : `partner ${p.key}: revenue and impressions above 0`,
      details: { revenue_usd: p.revenue_usd, impressions: p.impressions },
    };
  });
  return [day, ...partners.sort((x, y) => x.partner!.localeCompare(y.partner!))];
}

export function runChecks(report: DailyReport, config: QaConfig): QaResult[] {
  return [
    ...checkMissingPartnerDays(report, config),
    ...checkRejectShare(report, config),
    ...checkDayOverDay(report, config),
    ...checkZeroTotals(report),
  ];
}

export function worstStatus(results: QaResult[]): QaStatus {
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.some((r) => r.status === "warn")) return "warn";
  return "pass";
}
