/**
 * Stage 7: a minimal Google Sheets API v4 client with fetch, and the TabStore that publishes through it.
 *
 * Calls per run (https://developers.google.com/sheets/api/reference/rest):
 *   GET  /v4/spreadsheets/{id}?fields=sheets.properties.title     which tabs exist
 *   POST /v4/spreadsheets/{id}:batchUpdate  (addSheet)            create missing tabs, header row frozen
 *   GET  /v4/spreadsheets/{id}/values:batchGet                    read every tab, unformatted values
 *   POST /v4/spreadsheets/{id}/values:batchUpdate (RAW)           write every tab back in one request
 *
 * valueInputOption RAW stores strings as strings and numbers as numbers: "2026-11-25" stays text
 * (Sheets would otherwise turn it into a date serial), and revenue stays a number you can sum.
 * The fetch function is injected; tests use a fake and never reach Google.
 */
import { type FetchLike, fetchAccessToken } from "./google-auth.js";
import type { GoogleSheetsConfig } from "./config.js";
import type { TabStore, TabWrite } from "./publish.js";
import type { Cell, Row, Tab } from "./rows.js";

export const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

/** A tab name as an A1 range: always quoted, with ' doubled ("By partner" -> 'By partner'). */
export const quoteTab = (name: string) => `'${name.replace(/'/g, "''")}'`;

export class GoogleSheets {
  private token: Promise<string> | null = null;

  constructor(
    private readonly config: GoogleSheetsConfig,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  private accessToken(): Promise<string> {
    // One token per run, fetched on the first call; a failed fetch is not cached.
    this.token ??= fetchAccessToken(this.config.serviceAccount, this.fetchFn).catch((err) => {
      this.token = null;
      throw err;
    });
    return this.token;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const token = await this.accessToken();
    const res = await this.fetchFn(`${SHEETS_API}/${encodeURIComponent(this.config.spreadsheetId)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const hint =
        res.status === 403
          ? ` (share the sheet with ${this.config.serviceAccount.client_email} as Editor, and enable the Google Sheets API)`
          : res.status === 404
            ? " (check SHEETS_SPREADSHEET_ID)"
            : "";
      throw new Error(`Google Sheets ${method} ${path.split("?")[0]} failed: ${res.status}${hint} ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async tabTitles(): Promise<string[]> {
    const meta = await this.call<{ sheets?: { properties: { title: string } }[] }>("GET", "?fields=sheets.properties.title");
    return (meta.sheets ?? []).map((s) => s.properties.title);
  }

  async addTabs(titles: string[]): Promise<void> {
    if (titles.length === 0) return;
    await this.call("POST", ":batchUpdate", {
      requests: titles.map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })),
    });
  }

  /** Whole tabs, in the order asked. Trailing empty rows and cells are omitted by the API. */
  async readTabs(titles: string[]): Promise<Row[][]> {
    if (titles.length === 0) return [];
    const params = new URLSearchParams({ majorDimension: "ROWS", valueRenderOption: "UNFORMATTED_VALUE" });
    for (const t of titles) params.append("ranges", quoteTab(t));
    const res = await this.call<{ valueRanges?: { values?: Cell[][] }[] }>("GET", `/values:batchGet?${params}`);
    return titles.map((_, i) => res.valueRanges?.[i]?.values ?? []);
  }

  /** Writes each tab from A1 in one request. */
  async writeTabs(data: { title: string; values: Row[] }[]): Promise<void> {
    if (data.length === 0) return;
    await this.call("POST", "/values:batchUpdate", {
      valueInputOption: "RAW",
      data: data.map((d) => ({ range: `${quoteTab(d.title)}!A1`, majorDimension: "ROWS", values: d.values })),
    });
  }
}

/**
 * Pads `rows` with "" so every cell `previous` covered is overwritten: "" clears a cell in the
 * Sheets API. A date with fewer rows than before, or a shorter tab, then leaves nothing stale,
 * and the whole tab is still written in one request (no clear-then-write window that could lose data).
 */
export function padToCover(rows: Row[], previous: Row[]): Row[] {
  const width = Math.max(0, ...rows.map((r) => r.length), ...previous.map((r) => r.length));
  const height = Math.max(rows.length, previous.length);
  return Array.from({ length: height }, (_, i) => {
    const row = rows[i] ?? [];
    return [...row, ...Array<Cell>(width - row.length).fill("")];
  });
}

export class GoogleSheetsStore implements TabStore {
  constructor(private readonly sheets: GoogleSheets) {}

  async read(tabs: Tab[]): Promise<Map<string, Row[]>> {
    const existing = new Set(await this.sheets.tabTitles());
    await this.sheets.addTabs(tabs.map((t) => t.name).filter((n) => !existing.has(n)));
    const values = await this.sheets.readTabs(tabs.map((t) => t.name));
    return new Map(tabs.map((t, i) => [t.name, values[i]!]));
  }

  async write(writes: TabWrite[]): Promise<void> {
    await this.sheets.writeTabs(writes.map((w) => ({ title: w.tab.name, values: padToCover(w.rows, w.previous) })));
  }
}
