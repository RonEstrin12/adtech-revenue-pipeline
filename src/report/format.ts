/**
 * Stage 5: turn a DailyReport (see query.ts) into readable text for the terminal.
 * Pure functions only, so tests can feed in rows without a database.
 *
 * Numbers are rounded here for display only; the exact NUMERIC strings stay in DailyReport.
 */
import type { Breakdown, DailyReport } from "./query.js";

const NA = "n/a";

const fmt = (digits: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function usd(value: string | null): string {
  if (value === null) return NA;
  const n = Number(value);
  return `${n < 0 ? "-" : ""}$${fmt(2).format(Math.abs(n))}`;
}

export function signedUsd(value: string | null): string {
  if (value === null) return NA;
  return Number(value) > 0 ? `+${usd(value)}` : usd(value);
}

export function count(value: number): string {
  return int.format(value);
}

/** A percentage already in percent units ("10.15" -> "+10.15%"). */
export function signedPct(value: string | null): string {
  if (value === null) return NA;
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${fmt(2).format(n)}%`;
}

/** A fraction ("0.2" -> "20.0%"). */
export function share(value: string): string {
  return `${fmt(1).format(Number(value) * 100)}%`;
}

/** Left-aligns the first `textColumns` columns and right-aligns the rest, two spaces apart. `header` may be null. */
export function table(header: string[] | null, rows: string[][], textColumns = 1): string[] {
  const all = header ? [header, ...rows] : rows;
  const columns = Math.max(0, ...all.map((r) => r.length));
  const widths = Array.from({ length: columns }, (_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all.map((r) =>
    "  " + r.map((cell, i) => (i < textColumns ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join("  ").trimEnd(),
  );
}

function breakdownSection(title: string, label: string, rows: Breakdown[]): string[] {
  if (rows.length === 0) return [title, "  (no rows)"];
  return [
    title,
    ...table(
      [label, "revenue", "impressions", "eCPM"],
      rows.map((r) => [r.key, usd(r.revenue_usd), count(r.impressions), usd(r.ecpm_usd)]),
    ),
  ];
}

export function formatReport(r: DailyReport): string {
  const title = `Daily revenue report for ${r.date}`;
  const out: string[] = [title, "=".repeat(title.length)];

  if (!r.totals) {
    out.push(`No revenue loaded for ${r.date}. Run npm run load -- ${r.date} first.`);
    return out.join("\n");
  }

  const t = r.totals;
  out.push(
    "Totals",
    ...table(
      null,
      [
        ["revenue", usd(t.revenue_usd)],
        ["impressions", count(t.impressions)],
        ["eCPM", usd(t.ecpm_usd)],
        ["partners", count(t.partner_count)],
        ["rows", count(t.row_count)],
      ],
    ),
    "",
    ...breakdownSection("By partner", "partner", r.byPartner),
    "",
    ...breakdownSection("By site", "site", r.bySite),
    "",
    ...breakdownSection("By ad unit", "ad unit", r.byAdUnit),
    "",
    "Day over day (revenue vs the previous day)",
  );

  if (r.dayOverDay.length === 0) out.push("  (no rows)");
  else
    out.push(
      ...table(
        ["partner", "revenue", "previous", "change", "change %"],
        r.dayOverDay.map((d) =>
          d.prev_date === null
            ? [d.partner, usd(d.revenue_usd), "no data", NA, NA]
            : [d.partner, usd(d.revenue_usd), usd(d.prev_revenue_usd), signedUsd(d.revenue_change_usd), signedPct(d.revenue_change_pct)],
        ),
      ),
    );

  out.push("", "Rejected rows (share of rows received)");
  if (r.rejects.length === 0) out.push("  (none)");
  else {
    out.push(
      ...table(
        ["partner", "reason", "rejected", "share"],
        r.rejects.map((x) => [x.partner, x.reason, count(x.rejected), share(x.reason_share)]),
        2,
      ),
    );
    // One line per partner: all reasons together.
    const seen = new Set<string>();
    for (const x of r.rejects) {
      if (seen.has(x.partner)) continue;
      seen.add(x.partner);
      out.push(
        `  partner ${x.partner}: ${count(x.partner_rejected)} rejected of ${count(x.partner_rejected + x.loaded)} received (${share(x.reject_share)})`,
      );
    }
  }

  return out.join("\n");
}
