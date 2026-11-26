/** The one row shape every partner is mapped to (see docs/ARCHITECTURE.md, "Canonical row"). */
export interface CanonicalRow {
  date: string; // YYYY-MM-DD
  partner: string; // "a", "b"
  site: string; // trimmed, lowercased
  ad_unit: string;
  impressions: number; // integer >= 0
  revenue_usd: number; // >= 0
  raw_key: string; // S3 key of the source file
}

export type RejectReason =
  | "invalid_date"
  | "date_mismatch"
  | "missing_site"
  | "unknown_ad_unit"
  | "missing_impressions"
  | "invalid_impressions"
  | "negative_impressions"
  | "missing_revenue"
  | "invalid_revenue"
  | "negative_revenue"
  | "unknown_currency"
  | "currency_mismatch"
  | "duplicate"
  | "duplicate_conflict";

export interface RejectedRow {
  raw_key: string;
  /** 1-based position of the record in the source file (CSV: data line, header excluded). */
  line: number;
  reason: RejectReason;
  detail?: string;
  /** The record exactly as the partner sent it. */
  row: unknown;
}

export interface ValidationResult {
  clean: CanonicalRow[];
  rejected: RejectedRow[];
}
