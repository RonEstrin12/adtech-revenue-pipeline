/**
 * Stage 7 dry run: the tabs as local CSV files (default out/sheets/<tab>.csv), merged exactly
 * like the Google Sheet, so the dry run shows what the sheet would contain. Nothing leaves the machine.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv, toCsv } from "../lib/csv.js";
import type { TabStore, TabWrite } from "./publish.js";
import type { Row, Tab } from "./rows.js";

export class CsvStore implements TabStore {
  constructor(readonly dir: string) {}

  path(tab: Tab): string {
    return join(this.dir, tab.file);
  }

  async read(tabs: Tab[]): Promise<Map<string, Row[]>> {
    const out = new Map<string, Row[]>();
    for (const tab of tabs) {
      try {
        out.set(tab.name, parseCsv(await readFile(this.path(tab), "utf8")));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        out.set(tab.name, []);
      }
    }
    return out;
  }

  async write(writes: TabWrite[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const { tab, rows } of writes) {
      // Write a temp file and rename it, so an interrupted run never leaves half a CSV.
      const tmp = `${this.path(tab)}.tmp`;
      await writeFile(tmp, toCsv(rows), "utf8");
      await rename(tmp, this.path(tab));
    }
  }
}
