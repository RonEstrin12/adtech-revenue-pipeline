import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsv, parseCsvRecords, toCsv } from "./csv.js";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF and blank lines", () => {
    assert.deepEqual(parseCsv('a,"b,c","say ""hi"""\r\n\r\n1,2,3'), [
      ["a", "b,c", 'say "hi"'],
      ["1", "2", "3"],
    ]);
  });

  it("maps records by header and fills short lines with empty strings", () => {
    assert.deepEqual(parseCsvRecords("﻿x, y\n1\n").records, [{ x: "1", y: "" }]);
  });
});

describe("toCsv", () => {
  it("quotes only when needed and round-trips through parseCsv", () => {
    const rows = [["date", "note", "n"], ["2026-11-25", 'a,b "c"\nd', 1.5], ["2026-11-26", "", 0]];
    const text = toCsv(rows);
    assert.equal(text, 'date,note,n\n2026-11-25,"a,b ""c""\nd",1.5\n2026-11-26,,0\n');
    assert.deepEqual(parseCsv(text), rows.map((r) => r.map(String)));
    assert.equal(toCsv([]), "");
  });
});
