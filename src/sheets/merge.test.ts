import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CsvStore } from "./csv-store.js";
import { mergeDateRows } from "./merge.js";
import { publishDate } from "./publish.js";
import { TABS, buildTabRows } from "./rows.js";
import { REPORT } from "./test-fixtures.js";

const TAB = { name: "T", header: ["date", "k", "v"] };
const H = ["date", "k", "v"];

describe("mergeDateRows", () => {
  const sheet = [H, ["2026-11-23", "a", 1], ["2026-11-24", "a", 2], ["2026-11-24", "b", 3], ["2026-11-26", "a", 5]];

  it("replaces only the date's rows and leaves other dates untouched", () => {
    assert.deepEqual(mergeDateRows(sheet, TAB, "2026-11-24", [["2026-11-24", "a", 20]]), [
      H,
      ["2026-11-23", "a", 1],
      ["2026-11-24", "a", 20],
      ["2026-11-26", "a", 5],
    ]);
  });

  it("inserts a new date in date order, keeping the order of rows within the date", () => {
    const merged = mergeDateRows(sheet, TAB, "2026-11-25", [["2026-11-25", "z", 9], ["2026-11-25", "a", 8]]);
    assert.deepEqual(merged.map((r) => `${r[0]}/${r[1]}`), ["date/k", "2026-11-23/a", "2026-11-24/a", "2026-11-24/b", "2026-11-25/z", "2026-11-25/a", "2026-11-26/a"]);
  });

  it("is idempotent: merging the same rows twice gives the same tab", () => {
    const rows = [["2026-11-24", "a", 2], ["2026-11-24", "b", 3]];
    const once = mergeDateRows(sheet, TAB, "2026-11-24", rows);
    assert.deepEqual(mergeDateRows(once, TAB, "2026-11-24", rows), once);
    assert.deepEqual(once, sheet);
  });

  it("starts an empty tab with the header, sorts unsorted input, drops blank rows, keeps undated rows last", () => {
    assert.deepEqual(mergeDateRows([], TAB, "2026-11-25", [["2026-11-25", "a", 1]]), [H, ["2026-11-25", "a", 1]]);
    assert.deepEqual(
      mergeDateRows([H, ["note", "x", ""], ["2026-11-24", "a", 1], ["", "", ""], ["2026-11-20", "a", 0]], TAB, "2026-11-22", []),
      [H, ["2026-11-20", "a", 0], ["2026-11-24", "a", 1], ["note", "x", ""]],
    );
  });

  it("matches the date as text even with padding (what a sheet or CSV may hand back)", () => {
    assert.deepEqual(mergeDateRows([H, [" 2026-11-24 ", "a", 1]], TAB, "2026-11-24", []), [H]);
  });

  it("refuses a foreign header, a row for another date, and a bad date", () => {
    assert.throws(() => mergeDateRows([["Date", "Revenue"], ["x"]], TAB, "2026-11-24", []), /tab "T" has an unexpected header/);
    assert.doesNotThrow(() => mergeDateRows([[...H, "", ""]], TAB, "2026-11-24", [])); // trailing empty cells are fine
    assert.throws(() => mergeDateRows([], TAB, "2026-11-24", [["2026-11-25", "a", 1]]), /row for 2026-11-25 given while publishing 2026-11-24/);
    assert.throws(() => mergeDateRows([], TAB, "2026-02-30", []), /not a date/);
  });
});

describe("publishDate to CSV files (the dry run)", () => {
  const dirs: string[] = [];
  after(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it("writes one CSV per tab; re-running a date replaces its rows instead of appending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sheets-"));
    dirs.push(dir);
    const store = new CsvStore(dir);
    const day = (date: string) => buildTabRows({ ...REPORT, date }, "pass");

    await publishDate(store, "2026-11-25", day("2026-11-25"));
    await publishDate(store, "2026-11-23", day("2026-11-23"));
    const first = await readFile(join(dir, TABS.byPartner.file), "utf8");
    const summary = await publishDate(store, "2026-11-25", day("2026-11-25"));

    assert.equal(await readFile(join(dir, TABS.byPartner.file), "utf8"), first);
    assert.deepEqual(summary.find((s) => s.tab === "By partner"), { tab: "By partner", written: 3, replaced: 3, total: 6 });
    assert.equal(
      await readFile(join(dir, TABS.daily.file), "utf8"),
      "date,revenue_usd,impressions,ecpm_usd,partners,rows,rejected,qa_status\n" +
        "2026-11-23,2208.320271,824500,2.678375,2,15,7,pass\n" +
        "2026-11-25,2208.320271,824500,2.678375,2,15,7,pass\n",
    );
  });
});
