/**
 * Stage 7: the idempotent merge. Read a whole tab, drop the rows of the date being published,
 * add the new rows, sort by date and write the whole tab back.
 *
 * Why read-merge-write instead of appending or editing ranges in place: a tab here is at most a
 * few thousand rows (one per day x partner / site / ad unit), so rewriting it is cheap, and the
 * result never depends on what was there before except for the other dates' rows. A re-run of a
 * date therefore replaces it, a date published out of order lands in its place, and a day with
 * fewer partners than last time leaves no stale rows. The same function serves the dry-run CSVs.
 */
import { isIsoDate } from "../lib/dates.js";
import type { Cell, Row, Tab } from "./rows.js";

/** The date in column A as a string (a Sheet cell can come back as a number or with padding). */
const dateOf = (row: Row): string => String(row[0] ?? "").trim();

const isBlank = (row: Row) => row.every((c) => String(c ?? "").trim() === "");

/** Row ordering: by date; rows without a valid date go last, in their original order. */
function compareRows(a: Row, b: Row): number {
  const da = dateOf(a);
  const db = dateOf(b);
  const va = isIsoDate(da);
  const vb = isIsoDate(db);
  if (va !== vb) return va ? -1 : 1;
  if (!va) return 0;
  return da < db ? -1 : da > db ? 1 : 0;
}

/**
 * Returns the full tab (header + rows) with `date`'s rows replaced by `rows`.
 *
 * - `existing` is the tab as read (header first), or [] for a new or empty tab.
 * - Other dates' rows are kept unchanged; blank rows are dropped.
 * - The sort is stable, so the rows within a date keep the order they were written in.
 * - Throws if the existing header is not ours: the tab was edited or belongs to something else,
 *   and rewriting it could scramble someone's columns.
 */
export function mergeDateRows(existing: Row[], tab: Pick<Tab, "name" | "header">, date: string, rows: Row[]): Row[] {
  if (!isIsoDate(date)) throw new Error(`not a date: "${date}"`);
  for (const row of rows) {
    if (dateOf(row) !== date) throw new Error(`row for ${dateOf(row) || "(no date)"} given while publishing ${date}`);
  }
  const [head, ...body] = existing;
  if (head && !isBlank(head)) {
    const found = head.map((c) => String(c).trim());
    while (found.length > 0 && found.at(-1) === "") found.pop();
    if (found.join("\u0000") !== tab.header.join("\u0000")) {
      throw new Error(
        `tab "${tab.name}" has an unexpected header (${found.join(", ")}); expected ${tab.header.join(", ")}. ` +
          "Rename or clear that tab so it can be rebuilt.",
      );
    }
  }
  const kept = body.filter((r) => !isBlank(r) && dateOf(r) !== date);
  const header: Cell[] = [...tab.header];
  return [header, ...[...kept, ...rows].sort(compareRows)];
}
