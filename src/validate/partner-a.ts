/**
 * Partner A: JSON from its REST API, { partner, date, count, data: [{ day, site, unit, imps, rev_usd }] }.
 * Revenue is already in USD.
 */
import { isIsoDate } from "../lib/dates.js";
import { dedupe, normalizeAdUnit, normalizeSite, parseImpressions, parseRevenue, roundMoney } from "./rules.js";
import type { CanonicalRow, RejectedRow, ValidationResult } from "./types.js";

/** Throws on a file we cannot read at all; bad rows inside a good file are rejected one by one. */
export function validatePartnerA(body: string, rawKey: string, date: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`partner A file ${rawKey} is not valid JSON: ${(err as Error).message}`);
  }
  const data = (parsed as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error(`partner A file ${rawKey} has no "data" array`);

  const rejected: RejectedRow[] = [];
  const candidates: { row: CanonicalRow; line: number; source: unknown }[] = [];

  data.forEach((record: Record<string, unknown>, i) => {
    const line = i + 1;
    const reject = (reason: RejectedRow["reason"], detail?: string) =>
      rejected.push({ raw_key: rawKey, line, reason, ...(detail ? { detail } : {}), row: record });

    if (!isIsoDate(record?.day)) return reject("invalid_date", JSON.stringify(record?.day));
    if (record.day !== date) return reject("date_mismatch", `${record.day} in the file for ${date}`);
    const site = normalizeSite(record.site);
    if (!site.ok) return reject(site.reason, site.detail);
    const unit = normalizeAdUnit(record.unit);
    if (!unit.ok) return reject(unit.reason, unit.detail);
    const imps = parseImpressions(record.imps);
    if (!imps.ok) return reject(imps.reason, imps.detail);
    const rev = parseRevenue(record.rev_usd);
    if (!rev.ok) return reject(rev.reason, rev.detail);
    if (rev.value.symbolCurrency && rev.value.symbolCurrency !== "USD") {
      return reject("currency_mismatch", `${rev.value.symbolCurrency} symbol in a USD field`);
    }

    candidates.push({
      line,
      source: record,
      row: {
        date,
        partner: "a",
        site: site.value,
        ad_unit: unit.value,
        impressions: imps.value,
        revenue_usd: roundMoney(rev.value.amount),
        raw_key: rawKey,
      },
    });
  });

  const deduped = dedupe(candidates);
  return { clean: deduped.clean, rejected: [...rejected, ...deduped.rejected].sort((x, y) => x.line - y.line) };
}
