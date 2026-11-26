/**
 * SQL builders for the stage 4 load. Pure functions, so the exact statements are unit-tested.
 * Every value goes through a $n parameter; nothing from the data is spliced into SQL text.
 */
import type { CanonicalRow, RejectedRow } from "../validate/types.js";

export interface Statement {
  text: string;
  values: unknown[];
}

/** Postgres allows 65535 parameters per statement; stay well below it. */
export const MAX_ROWS_PER_INSERT = 1000;

/** Multi-row INSERT for `table`/`columns`; `casts` optionally adds a ::type per column. */
export function buildInsert(
  table: string,
  columns: readonly string[],
  rows: readonly unknown[][],
  casts: Record<string, string> = {},
): Statement {
  if (rows.length === 0) throw new Error("buildInsert needs at least one row");
  const values: unknown[] = [];
  const tuples = rows.map((row) => {
    if (row.length !== columns.length) throw new Error(`expected ${columns.length} values, got ${row.length}`);
    const params = row.map((v, i) => {
      values.push(v);
      const cast = casts[columns[i]!];
      return `$${values.length}${cast ? `::${cast}` : ""}`;
    });
    return `(${params.join(", ")})`;
  });
  return { text: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`, values };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const REVENUE_COLUMNS = [
  "partner", "date", "site", "ad_unit", "impressions", "revenue_usd", "raw_key", "fx_source",
] as const;

/**
 * Money is sent as a decimal string (stage 3 rounds to 6 places), so Postgres parses it
 * into NUMERIC exactly instead of going through a float.
 */
export const moneyParam = (n: number) => n.toFixed(6);

export function insertRevenueStatements(rows: readonly CanonicalRow[], fxSource: string, size = MAX_ROWS_PER_INSERT): Statement[] {
  return chunk(rows, size).map((part) =>
    buildInsert(
      "revenue_daily",
      REVENUE_COLUMNS,
      part.map((r) => [r.partner, r.date, r.site, r.ad_unit, r.impressions, moneyParam(r.revenue_usd), r.raw_key, fxSource]),
    ),
  );
}

export const REJECTED_COLUMNS = ["partner", "date", "reason", "detail", "raw_key", "line", "original_row"] as const;

export function insertRejectedStatements(
  partner: string,
  date: string,
  rows: readonly RejectedRow[],
  size = MAX_ROWS_PER_INSERT,
): Statement[] {
  return chunk(rows, size).map((part) =>
    buildInsert(
      "rejected_rows",
      REJECTED_COLUMNS,
      // JSON.stringify(undefined) is undefined (SQL NULL); store a JSON null instead.
      part.map((r) => [partner, date, r.reason, r.detail ?? null, r.raw_key, r.line, JSON.stringify(r.row ?? null)]),
      { original_row: "jsonb" },
    ),
  );
}

export function deletePartnerDayStatements(partner: string, date: string): Statement[] {
  return [
    { text: "DELETE FROM revenue_daily WHERE partner = $1 AND date = $2", values: [partner, date] },
    { text: "DELETE FROM rejected_rows WHERE partner = $1 AND date = $2", values: [partner, date] },
  ];
}

/** Serializes concurrent loads of the same partner-day for the rest of the transaction. */
export function lockPartnerDayStatement(partner: string, date: string): Statement {
  return { text: "SELECT pg_advisory_xact_lock(hashtext($1))", values: [`load:${partner}:${date}`] };
}
