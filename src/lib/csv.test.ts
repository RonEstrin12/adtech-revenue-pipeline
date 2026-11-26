import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsv, parseCsvRecords } from "./csv.js";

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
