/**
 * Stage 5: read one day's summary from the analysis views (db/migrations/002_analysis_views.sql).
 *
 * This is the data half of the report: no formatting here, so stage 7 (Google Sheets) can
 * reuse it. Money, eCPM and shares stay decimal strings exactly as Postgres returns NUMERIC,
 * counts are numbers, and a NULL (eCPM with 0 impressions, no previous day) stays null.
 */
import type { Queryable } from "../lib/db.js";

export interface Totals {
  revenue_usd: string;
  impressions: number;
  ecpm_usd: string | null;
  partner_count: number;
  row_count: number;
}

export interface Breakdown {
  key: string; // partner, site or ad unit
  revenue_usd: string;
  impressions: number;
  ecpm_usd: string | null;
}

export interface DayOverDay {
  partner: string;
  revenue_usd: string;
  prev_date: string | null;
  prev_revenue_usd: string | null;
  revenue_change_usd: string | null;
  revenue_change_pct: string | null;
}

export interface RejectLine {
  partner: string;
  reason: string;
  rejected: number;
  partner_rejected: number;
  loaded: number;
  reason_share: string;
  reject_share: string;
}

export interface DailyReport {
  date: string;
  totals: Totals | null; // null when nothing is loaded for the date
  byPartner: Breakdown[];
  bySite: Breakdown[];
  byAdUnit: Breakdown[];
  dayOverDay: DayOverDay[];
  rejects: RejectLine[];
}

// bigint and count(*) come back from pg as strings. Counts are cast to int; impressions to float8,
// which is exact up to 2^53 and so cannot overflow the way int would above 2.1 billion a day.
// ORDER BY names v.revenue_usd so it sorts the NUMERIC column, not the ::text output column.
const breakdown = (view: string, column: string) =>
  `SELECT ${column} AS key, revenue_usd::text, impressions::float8, ecpm_usd::text
   FROM ${view} v WHERE date = $1 ORDER BY v.revenue_usd DESC, ${column}`;

export const REPORT_QUERIES = {
  totals: `SELECT revenue_usd::text, impressions::float8, ecpm_usd::text, partner_count::int, row_count::int
           FROM v_daily_totals WHERE date = $1`,
  byPartner: breakdown("v_daily_by_partner", "partner"),
  bySite: breakdown("v_daily_by_site", "site"),
  byAdUnit: breakdown("v_daily_by_ad_unit", "ad_unit"),
  dayOverDay: `SELECT partner, revenue_usd::text, to_char(prev_date, 'YYYY-MM-DD') AS prev_date,
                      prev_revenue_usd::text, revenue_change_usd::text, revenue_change_pct::text
               FROM v_partner_day_over_day WHERE date = $1 ORDER BY partner`,
  rejects: `SELECT partner, reason, rejected::int, partner_rejected::int, loaded::int,
                   reason_share::text, reject_share::text
            FROM v_reject_summary WHERE date = $1 ORDER BY partner, rejected DESC, reason`,
} as const;

export async function fetchDailyReport(db: Queryable, date: string): Promise<DailyReport> {
  const q = async <T>(text: string) => (await db.query(text, [date])).rows as T[];
  return {
    date,
    totals: (await q<Totals>(REPORT_QUERIES.totals))[0] ?? null,
    byPartner: await q<Breakdown>(REPORT_QUERIES.byPartner),
    bySite: await q<Breakdown>(REPORT_QUERIES.bySite),
    byAdUnit: await q<Breakdown>(REPORT_QUERIES.byAdUnit),
    dayOverDay: await q<DayOverDay>(REPORT_QUERIES.dayOverDay),
    rejects: await q<RejectLine>(REPORT_QUERIES.rejects),
  };
}
