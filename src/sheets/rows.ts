/**
 * Stage 7: turn one day's DailyReport (src/report/query.ts) into rows for the Google Sheet tabs.
 * Pure functions, so tests feed in reports without a database.
 *
 * Every tab is a long, append-style table: a header row, then one row per date (and partner,
 * site or ad unit), with the date in column A. That keeps the merge in merge.ts simple and lets
 * people filter, chart or pivot the sheet over time.
 *
 * Numbers are written as numbers. Money and eCPM come from Postgres NUMERIC strings and are
 * converted with Number(), which is exact to well past a cent for these amounts. A value that does
 * not exist (eCPM with 0 impressions, no previous day) is an empty cell, never "n/a" or 0.
 */
import type { QaStatus } from "../qa/checks.js";
import type { Breakdown, DailyReport } from "../report/query.js";

export type Cell = string | number;
export type Row = Cell[];

export interface Tab {
  name: string; // tab title in the spreadsheet
  file: string; // dry-run CSV file name in SHEETS_OUT_DIR
  header: string[];
}

/** Column A of every tab is the date (YYYY-MM-DD), which merge.ts keys on. */
export const TABS = {
  daily: {
    name: "Daily",
    file: "daily.csv",
    header: ["date", "revenue_usd", "impressions", "ecpm_usd", "partners", "rows", "rejected", "qa_status"],
  },
  byPartner: {
    name: "By partner",
    file: "by-partner.csv",
    header: ["date", "partner", "revenue_usd", "impressions", "ecpm_usd", "dod_change_pct", "rejected", "reject_pct"],
  },
  bySite: {
    name: "By site",
    file: "by-site.csv",
    header: ["date", "site", "revenue_usd", "impressions", "ecpm_usd"],
  },
  byAdUnit: {
    name: "By ad unit",
    file: "by-ad-unit.csv",
    header: ["date", "ad_unit", "revenue_usd", "impressions", "ecpm_usd"],
  },
} as const satisfies Record<string, Tab>;

export const ALL_TABS: Tab[] = Object.values(TABS);

export interface TabRows {
  tab: Tab;
  rows: Row[]; // this date's rows, without the header
}

/** NUMERIC string (or null) to a number cell (or an empty cell). */
export function num(value: string | null | undefined): Cell {
  if (value === null || value === undefined || value.trim() === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`not a number: "${value}"`);
  return n;
}

/** A fraction ("0.3") as percent units (30), rounded to 4 decimals so 0.3 does not become 30.000000000000004. */
export function fractionToPct(value: string | null | undefined): Cell {
  const n = num(value);
  return typeof n === "number" ? Math.round(n * 100 * 10_000) / 10_000 : "";
}

const byKey = (a: Breakdown, b: Breakdown) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Rows rejected per partner (v_reject_summary repeats partner_rejected on every reason line). */
function rejectsByPartner(report: DailyReport): Map<string, { rejected: number; share: string }> {
  const out = new Map<string, { rejected: number; share: string }>();
  for (const r of report.rejects) out.set(r.partner, { rejected: r.partner_rejected, share: r.reject_share });
  return out;
}

/**
 * The date's rows for every tab. `qaStatus` is the worst status in qa_results, or null when QA
 * has not run for the date ("not run"). Throws when nothing is loaded for the date: there is
 * nothing to publish, and an all-zero row would look like a real day.
 */
export function buildTabRows(report: DailyReport, qaStatus: QaStatus | null): TabRows[] {
  const { date, totals } = report;
  if (!totals) throw new Error(`nothing is loaded for ${date}`);

  const rejects = rejectsByPartner(report);
  const rejectedTotal = [...rejects.values()].reduce((sum, r) => sum + r.rejected, 0);
  const dod = new Map(report.dayOverDay.map((d) => [d.partner, d.revenue_change_pct]));

  // Partners with loaded rows, plus any partner whose rows were all rejected (revenue 0, so it is visible).
  const partners: Breakdown[] = [...report.byPartner];
  for (const partner of rejects.keys()) {
    if (!partners.some((p) => p.key === partner)) partners.push({ key: partner, revenue_usd: "0", impressions: 0, ecpm_usd: null });
  }

  const breakdown = (rows: Breakdown[]): Row[] =>
    [...rows].sort(byKey).map((b) => [date, b.key, num(b.revenue_usd), b.impressions, num(b.ecpm_usd)]);

  return [
    {
      tab: TABS.daily,
      rows: [
        [
          date,
          num(totals.revenue_usd),
          totals.impressions,
          num(totals.ecpm_usd),
          totals.partner_count,
          totals.row_count,
          rejectedTotal,
          qaStatus ?? "not run",
        ],
      ],
    },
    {
      tab: TABS.byPartner,
      rows: partners.sort(byKey).map((p) => {
        const r = rejects.get(p.key);
        return [
          date,
          p.key,
          num(p.revenue_usd),
          p.impressions,
          num(p.ecpm_usd),
          num(dod.get(p.key)),
          r?.rejected ?? 0,
          r ? fractionToPct(r.share) : 0,
        ];
      }),
    },
    { tab: TABS.bySite, rows: breakdown(report.bySite) },
    { tab: TABS.byAdUnit, rows: breakdown(report.byAdUnit) },
  ];
}
