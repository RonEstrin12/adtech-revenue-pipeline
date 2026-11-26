/** Test fixture (not used by production code): one day's DailyReport. */
import type { DailyReport } from "../report/query.js";

/** Shaped like the seeded day: partner b rejected 3 rows (2 reasons), partner c had every row rejected. */
export const REPORT: DailyReport = {
  date: "2026-11-25",
  totals: { revenue_usd: "2208.320271", impressions: 824500, ecpm_usd: "2.678375", partner_count: 2, row_count: 15 },
  byPartner: [
    { key: "a", revenue_usd: "1444.600000", impressions: 520000, ecpm_usd: "2.778077" },
    { key: "b", revenue_usd: "763.720271", impressions: 304500, ecpm_usd: "2.508112" },
  ],
  bySite: [
    { key: "sports.co.il", revenue_usd: "900.000000", impressions: 300000, ecpm_usd: "3.000000" },
    { key: "news.co.il", revenue_usd: "1308.320271", impressions: 524500, ecpm_usd: null },
  ],
  byAdUnit: [{ key: "video_mid", revenue_usd: "2208.320271", impressions: 824500, ecpm_usd: "2.678375" }],
  dayOverDay: [
    { partner: "a", revenue_usd: "1444.600000", prev_date: "2026-11-24", prev_revenue_usd: "1311.450000", revenue_change_usd: "133.150000", revenue_change_pct: "10.153" },
    { partner: "b", revenue_usd: "763.720271", prev_date: null, prev_revenue_usd: null, revenue_change_usd: null, revenue_change_pct: null },
  ],
  rejects: [
    { partner: "b", reason: "duplicate", rejected: 2, partner_rejected: 3, loaded: 7, reason_share: "0.2", reject_share: "0.3" },
    { partner: "b", reason: "bad_date", rejected: 1, partner_rejected: 3, loaded: 7, reason_share: "0.1", reject_share: "0.3" },
    { partner: "c", reason: "bad_date", rejected: 4, partner_rejected: 4, loaded: 0, reason_share: "1", reject_share: "1" },
  ],
};
