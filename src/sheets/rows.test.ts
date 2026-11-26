import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TABS, buildTabRows, fractionToPct, num } from "./rows.js";
import { REPORT } from "./test-fixtures.js";

const D = "2026-11-25";

describe("num / fractionToPct", () => {
  it("turns NUMERIC strings into numbers and missing values into empty cells", () => {
    assert.equal(num("2208.320271"), 2208.320271);
    assert.equal(num(null), "");
    assert.equal(num(undefined), "");
    assert.throws(() => num("n/a"), /not a number/);
    assert.equal(fractionToPct("0.3"), 30); // not 30.000000000000004
    assert.equal(fractionToPct("0.123456"), 12.3456);
    assert.equal(fractionToPct(null), "");
  });
});

describe("buildTabRows", () => {
  const tables = buildTabRows(REPORT, "warn");
  const rows = (name: string) => tables.find((t) => t.tab.name === name)!.rows;

  it("builds every tab, each row starting with the date and as wide as its header", () => {
    assert.deepEqual(tables.map((t) => t.tab.name), ["Daily", "By partner", "By site", "By ad unit"]);
    for (const t of tables) for (const r of t.rows) {
      assert.equal(r[0], D);
      assert.equal(r.length, t.tab.header.length, t.tab.name);
    }
  });

  it("Daily: totals as numbers, rejected rows counted once per partner, worst QA status", () => {
    assert.deepEqual(rows("Daily"), [[D, 2208.320271, 824500, 2.678375, 2, 15, 7, "warn"]]);
    assert.equal(buildTabRows(REPORT, null)[0]!.rows[0]!.at(-1), "not run");
  });

  it("By partner: sorted by partner, day-over-day %, reject %; an all-rejected partner shows with 0 revenue", () => {
    assert.deepEqual(rows("By partner"), [
      [D, "a", 1444.6, 520000, 2.778077, 10.153, 0, 0],
      [D, "b", 763.720271, 304500, 2.508112, "", 3, 30],
      [D, "c", 0, 0, "", "", 4, 100],
    ]);
  });

  it("By site and By ad unit: sorted by name, eCPM empty when it is NULL", () => {
    assert.deepEqual(rows("By site"), [
      [D, "news.co.il", 1308.320271, 524500, ""],
      [D, "sports.co.il", 900, 300000, 3],
    ]);
    assert.deepEqual(rows("By ad unit"), [[D, "video_mid", 2208.320271, 824500, 2.678375]]);
  });

  it("numbers are numbers, never formatted strings", () => {
    const daily = rows("Daily")[0]!;
    for (const i of [1, 2, 3, 4, 5, 6]) assert.equal(typeof daily[i], "number", TABS.daily.header[i]);
  });

  it("refuses a day with nothing loaded", () => {
    assert.throws(() => buildTabRows({ ...REPORT, totals: null }, null), /nothing is loaded for 2026-11-25/);
  });
});
