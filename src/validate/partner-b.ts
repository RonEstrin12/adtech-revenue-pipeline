/**
 * Partner B: CSV with Date (DD/MM/YYYY), Website, Placement, Impressions, Revenue, Currency.
 * Revenue is in ILS for most sites and USD for some; everything is converted to USD.
 */
import { parseCsvRecords } from "../lib/csv.js";
import { ddMmYyyyToIso } from "../lib/dates.js";
import type { FxRates } from "../lib/fx.js";
import { dedupe, normalizeAdUnit, normalizeSite, parseImpressions, parseRevenue, roundMoney } from "./rules.js";
import type { CanonicalRow, RejectedRow, ValidationResult } from "./types.js";

const COLUMNS = ["Date", "Website", "Placement", "Impressions", "Revenue", "Currency"];

/** Throws on a file we cannot read at all; bad rows inside a good file are rejected one by one. */
export function validatePartnerB(body: string, rawKey: string, date: string, fx: FxRates): ValidationResult {
  const { header, records } = parseCsvRecords(body);
  const missing = COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`partner B file ${rawKey} is missing columns: ${missing.join(", ")}`);

  const rejected: RejectedRow[] = [];
  const candidates: { row: CanonicalRow; line: number; source: unknown }[] = [];

  records.forEach((record, i) => {
    const line = i + 1;
    const reject = (reason: RejectedRow["reason"], detail?: string) =>
      rejected.push({ raw_key: rawKey, line, reason, ...(detail ? { detail } : {}), row: record });

    const day = ddMmYyyyToIso(record.Date.trim());
    if (!day) return reject("invalid_date", JSON.stringify(record.Date));
    if (day !== date) return reject("date_mismatch", `${day} in the file for ${date}`);
    const site = normalizeSite(record.Website);
    if (!site.ok) return reject(site.reason, site.detail);
    const unit = normalizeAdUnit(record.Placement);
    if (!unit.ok) return reject(unit.reason, unit.detail);
    const imps = parseImpressions(record.Impressions);
    if (!imps.ok) return reject(imps.reason, imps.detail);
    const rev = parseRevenue(record.Revenue);
    if (!rev.ok) return reject(rev.reason, rev.detail);

    const currency = record.Currency.trim().toUpperCase();
    const rate = fx.usdPer(currency);
    if (rate === null) return reject("unknown_currency", JSON.stringify(record.Currency));
    if (rev.value.symbolCurrency && rev.value.symbolCurrency !== currency) {
      return reject("currency_mismatch", `${rev.value.symbolCurrency} symbol but Currency=${currency}`);
    }

    candidates.push({
      line,
      source: record,
      row: {
        date,
        partner: "b",
        site: site.value,
        ad_unit: unit.value,
        impressions: imps.value,
        revenue_usd: roundMoney(rev.value.amount * rate),
        raw_key: rawKey,
      },
    });
  });

  const deduped = dedupe(candidates);
  return { clean: deduped.clean, rejected: [...rejected, ...deduped.rejected].sort((x, y) => x.line - y.line) };
}
