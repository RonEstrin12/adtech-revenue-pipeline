import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixedRates } from "../lib/fx.js";
import { buildPartnerAReport } from "../mock-partners/partner-a-server.js";
import { buildPartnerBCsv } from "../mock-partners/partner-b-drop.js";
import { countByReason, validatePartnerDay, type CleanFile, type RejectedFile, type Store } from "./run.js";

const DATE = "2026-11-25";
const fx = fixedRates(3.7);

/** In-memory bucket. */
function memoryStore(initial: Record<string, string> = {}) {
  const objects = new Map(Object.entries(initial));
  const store: Store = {
    listKeys: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
    getText: async (key) => objects.get(key) ?? "",
    putText: async (key, body) => void objects.set(key, body),
  };
  return { objects, store };
}

const aBody = JSON.stringify({ partner: "A", date: DATE, data: buildPartnerAReport(DATE) });
const rawA = (ts: string) => `partner=a/date=${DATE}/fetched_at=${ts}.json`;

describe("validatePartnerDay", () => {
  it("writes clean and rejected files under the clean zone", async () => {
    const { objects, store } = memoryStore({ [rawA("2026-11-26T01")]: aBody });
    const out = await validatePartnerDay(store, "a", DATE, fx);
    assert.equal(out.status, "ok");
    const clean = JSON.parse(objects.get(`clean/partner=a/date=${DATE}/rows.json`)!) as CleanFile;
    const rejected = JSON.parse(objects.get(`clean/partner=a/date=${DATE}/rejected.json`)!) as RejectedFile;
    assert.equal(clean.count, 8);
    assert.equal(clean.raw_key, rawA("2026-11-26T01"));
    assert.equal(rejected.count, 2);
    assert.equal(rejected.raw_key, clean.raw_key);
  });

  it("is idempotent: re-running a day overwrites the same keys with the same content", async () => {
    const { objects, store } = memoryStore({ [`partner=b/date=${DATE}/fetched_at=1.csv`]: buildPartnerBCsv(DATE) });
    await validatePartnerDay(store, "b", DATE, fx);
    const first = new Map(objects);
    await validatePartnerDay(store, "b", DATE, fx);
    assert.deepEqual(objects, first);
    assert.equal(objects.size, 3); // raw + rows.json + rejected.json
  });

  it("reads only the latest raw file for the day", async () => {
    const corrected = JSON.stringify({ data: buildPartnerAReport(DATE).slice(0, 3) });
    const { objects, store } = memoryStore({
      [rawA("2026-11-26T01")]: aBody,
      [rawA("2026-11-26T09")]: corrected,
      [`partner=a/date=2026-11-24/fetched_at=2026-11-27.json`]: aBody, // another day, ignored
    });
    await validatePartnerDay(store, "a", DATE, fx);
    const clean = JSON.parse(objects.get(`clean/partner=a/date=${DATE}/rows.json`)!) as CleanFile;
    assert.equal(clean.raw_key, rawA("2026-11-26T09"));
    assert.equal(clean.count, 3);
  });

  it("reports a missing partner-day without writing anything", async () => {
    const { objects, store } = memoryStore();
    assert.deepEqual(await validatePartnerDay(store, "b", DATE, fx), { partner: "b", status: "missing" });
    assert.equal(objects.size, 0);
  });
});

describe("countByReason", () => {
  it("counts and sorts by reason", () => {
    const row = { raw_key: "k", line: 1, row: {} };
    assert.deepEqual(
      countByReason([
        { ...row, reason: "duplicate" },
        { ...row, reason: "invalid_date" },
        { ...row, reason: "duplicate" },
      ]),
      [
        ["duplicate", 2],
        ["invalid_date", 1],
      ],
    );
  });
});
