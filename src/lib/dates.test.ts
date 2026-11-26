import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPartnerBCsv } from "../mock-partners/partner-b-drop.js";
import { ddMmYyyyToIso, isIsoDate, yesterday } from "./dates.js";

describe("isIsoDate", () => {
  it("accepts real calendar days", () => {
    for (const d of ["2026-11-24", "2026-01-01", "2026-12-31", "2024-02-29", "2000-02-29"]) {
      assert.equal(isIsoDate(d), true, d);
    }
  });

  it("rejects days that do not exist", () => {
    for (const d of ["2026-02-30", "2026-02-29", "1900-02-29", "2026-04-31", "2026-13-45", "2026-00-10", "2026-01-00"]) {
      assert.equal(isIsoDate(d), false, d);
    }
  });

  it("rejects other formats and non-strings", () => {
    for (const d of ["24/11/2026", "2026-1-5", "2026-11-24T00:00:00Z", " 2026-11-24", "", null, undefined, 20261124]) {
      assert.equal(isIsoDate(d), false, String(d));
    }
  });
});

describe("ddMmYyyyToIso", () => {
  it("converts partner B dates", () => {
    assert.equal(ddMmYyyyToIso("24/11/2026"), "2026-11-24");
    assert.equal(ddMmYyyyToIso("29/02/2024"), "2024-02-29");
  });

  it("rejects impossible or malformed dates", () => {
    for (const d of ["30/02/2026", "45/13/2026", "2026-11-24", "2026-13-45", "4/11/2026", ""]) {
      assert.equal(ddMmYyyyToIso(d), null, d);
    }
  });

  it("on the seeded partner B file, rejects only the deliberate impossible date", () => {
    const rows = buildPartnerBCsv("2026-11-24").trim().split("\n").slice(1);
    const dates = rows.map((r) => r.split(",")[0]);
    const bad = dates.filter((d) => ddMmYyyyToIso(d) === null);
    assert.deepEqual(bad, ["2026-13-45"]);
    assert.ok(dates.filter((d) => d !== "2026-13-45").every((d) => ddMmYyyyToIso(d) === "2026-11-24"));
  });
});

describe("yesterday", () => {
  it("is the previous UTC day, across month and year ends", () => {
    assert.equal(yesterday(new Date("2026-11-25T10:00:00Z"), "UTC"), "2026-11-24");
    assert.equal(yesterday(new Date("2026-03-01T00:30:00Z"), "UTC"), "2026-02-28");
    assert.equal(yesterday(new Date("2026-01-01T23:59:00Z"), "UTC"), "2025-12-31");
  });

  it("returns a valid ISO date by default", () => {
    assert.equal(isIsoDate(yesterday()), true);
  });

  it("defaults to Israel time when REPORT_TZ is unset", () => {
    const saved = process.env.REPORT_TZ;
    delete process.env.REPORT_TZ;
    try {
      // 22:30 UTC on Nov 25 is already Nov 26 in Israel.
      assert.equal(yesterday(new Date("2026-11-25T22:30:00Z")), "2026-11-25");
    } finally {
      if (saved !== undefined) process.env.REPORT_TZ = saved;
    }
  });
});

describe("yesterday in a reporting timezone", () => {
  it("uses the calendar day in the given timezone", () => {
    // 22:30 UTC on Nov 25 is already Nov 26 in Israel, so yesterday there is Nov 25.
    const now = new Date("2026-11-25T22:30:00Z");
    assert.equal(yesterday(now, "UTC"), "2026-11-24");
    assert.equal(yesterday(now, "Asia/Jerusalem"), "2026-11-25");
    assert.equal(yesterday(new Date("2026-11-25T03:00:00Z"), "America/New_York"), "2026-11-23");
  });

  it("rejects an unknown timezone", () => {
    assert.throws(() => yesterday(new Date(), "Mars/Base"), RangeError);
  });
});
