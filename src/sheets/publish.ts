/**
 * Stage 7: publish one date to every tab through a TabStore (the Google Sheet, or the dry-run
 * CSV files). Reads all tabs first, merges in memory, then writes, so a read error or an
 * unexpected header changes nothing.
 */
import { mergeDateRows } from "./merge.js";
import type { Row, Tab, TabRows } from "./rows.js";

export interface TabWrite {
  tab: Tab;
  rows: Row[]; // the full tab, header first
  previous: Row[]; // the tab as it was read, so a store can blank out rows that are now gone
}

/** Where the tabs live. Implemented by GoogleSheetsStore and CsvStore. */
export interface TabStore {
  /** Whole tabs (header first); a missing tab reads as []. */
  read(tabs: Tab[]): Promise<Map<string, Row[]>>;
  write(writes: TabWrite[]): Promise<void>;
}

export interface TabSummary {
  tab: string;
  written: number; // rows for the date
  replaced: number; // rows the date had before
  total: number; // data rows in the tab after the write
}

export async function publishDate(store: TabStore, date: string, tables: TabRows[]): Promise<TabSummary[]> {
  const tabs = tables.map((t) => t.tab);
  const before = await store.read(tabs);
  const writes: TabWrite[] = [];
  const summary: TabSummary[] = [];
  for (const { tab, rows } of tables) {
    const previous = before.get(tab.name) ?? [];
    const merged = mergeDateRows(previous, tab, date, rows);
    writes.push({ tab, rows: merged, previous });
    summary.push({
      tab: tab.name,
      written: rows.length,
      replaced: previous.slice(1).filter((r) => String(r[0] ?? "").trim() === date).length,
      total: merged.length - 1,
    });
  }
  await store.write(writes);
  return summary;
}
