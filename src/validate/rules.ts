/**
 * Checks shared by every partner. Each returns either a value or a reject reason,
 * so the partner validators read as a list of steps.
 */
import type { CanonicalRow, RejectReason, RejectedRow, ValidationResult } from "./types.js";

export type Check<T> = { ok: true; value: T } | { ok: false; reason: RejectReason; detail?: string };

const ok = <T>(value: T): Check<T> => ({ ok: true, value });
const fail = (reason: RejectReason, detail?: string): Check<never> => ({ ok: false, reason, detail });

/** Ad units the publisher sells. A new unit is rejected until it is added here on purpose. */
export const KNOWN_AD_UNITS: ReadonlySet<string> = new Set(["top_banner", "sidebar", "video_mid"]);

export function normalizeSite(value: unknown): Check<string> {
  const site = typeof value === "string" ? value.trim().toLowerCase() : "";
  return site ? ok(site) : fail("missing_site");
}

export function normalizeAdUnit(value: unknown): Check<string> {
  const unit = typeof value === "string" ? value.trim().toLowerCase() : "";
  return KNOWN_AD_UNITS.has(unit) ? ok(unit) : fail("unknown_ad_unit", JSON.stringify(value));
}

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** Accepts a number or a numeric string; must be a whole number >= 0. */
export function parseImpressions(value: unknown): Check<number> {
  if (isBlank(value)) return fail("missing_impressions");
  const n = typeof value === "number" ? value : /^\s*-?\d+\s*$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n)) return fail("invalid_impressions", JSON.stringify(value));
  if (n < 0) return fail("negative_impressions", String(n));
  return ok(n);
}

/**
 * Accepts a number or a numeric string. Currency symbols and spaces are stripped
 * ("₪123.40" -> 123.40); the symbol found, if any, is returned so the caller can
 * check it against the currency column.
 */
export function parseRevenue(value: unknown): Check<{ amount: number; symbolCurrency: string | null }> {
  if (isBlank(value)) return fail("missing_revenue");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail("invalid_revenue", String(value));
    return value < 0 ? fail("negative_revenue", String(value)) : ok({ amount: value, symbolCurrency: null });
  }
  if (typeof value !== "string") return fail("invalid_revenue", JSON.stringify(value));

  const symbols: Record<string, string> = { "₪": "ILS", $: "USD" };
  const found = [...new Set([...value].filter((ch) => ch in symbols))];
  if (found.length > 1) return fail("invalid_revenue", value);
  const stripped = value.replace(/[₪$\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(stripped)) return fail("invalid_revenue", value);
  const amount = Number(stripped);
  if (amount < 0) return fail("negative_revenue", value);
  return ok({ amount, symbolCurrency: found.length ? symbols[found[0]] : null });
}

/** Rounds away float noise from currency conversion; well below a cent. */
export const roundMoney = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Keeps one row per (date, site, ad_unit), the key stage 4 upserts on.
 * A repeat with the same numbers is a plain `duplicate`. A repeat with different
 * numbers is a `duplicate_conflict`: the first row is kept and the later one is
 * rejected, so QA sees that the partner sent two versions.
 */
export function dedupe(candidates: { row: CanonicalRow; line: number; source: unknown }[]): ValidationResult {
  const seen = new Map<string, CanonicalRow>();
  const clean: CanonicalRow[] = [];
  const rejected: RejectedRow[] = [];
  for (const { row, line, source } of candidates) {
    const key = `${row.date}|${row.site}|${row.ad_unit}`;
    const first = seen.get(key);
    if (!first) {
      seen.set(key, row);
      clean.push(row);
      continue;
    }
    const same = first.impressions === row.impressions && first.revenue_usd === row.revenue_usd;
    rejected.push({
      raw_key: row.raw_key,
      line,
      reason: same ? "duplicate" : "duplicate_conflict",
      detail: `same date, site and ad_unit as an earlier row`,
      row: source,
    });
  }
  return { clean, rejected };
}
