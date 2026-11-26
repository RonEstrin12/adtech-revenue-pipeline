import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeClient } from "../lib/fake-db.js";
import { fixedRates } from "../lib/fx.js";
import { buildPartnerAReport } from "../mock-partners/partner-a-server.js";
import { buildPartnerBCsv } from "../mock-partners/partner-b-drop.js";
import { type Store, validatePartnerDay } from "../validate/run.js";
import { type PartnerDay, loadPartnerDay, loadStatements, readPartnerDay } from "./run.js";

const DATE = "2026-11-25";

function memoryStore(initial: Record<string, string> = {}) {
  const objects = new Map(Object.entries(initial));
  const store: Store = {
    listKeys: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
    getText: async (key) => objects.get(key) ?? "",
    putText: async (key, body) => void objects.set(key, body),
  };
  return { objects, store };
}

/** Clean zone produced by the real stage 3 from the seeded mock partners. */
async function seededCleanZone() {
  const mem = memoryStore({
    [`partner=a/date=${DATE}/fetched_at=1.json`]: JSON.stringify({ data: buildPartnerAReport(DATE) }),
    [`partner=b/date=${DATE}/fetched_at=1.csv`]: buildPartnerBCsv(DATE),
  });
  await validatePartnerDay(mem.store, "a", DATE, fixedRates(3.7));
  await validatePartnerDay(mem.store, "b", DATE, fixedRates(3.7));
  return mem;
}

async function readDay(partner: string): Promise<PartnerDay> {
  const { store } = await seededCleanZone();
  const out = await readPartnerDay(store, partner, DATE);
  assert.equal(out.status, "ok");
  return (out as { day: PartnerDay }).day;
}

const rowsKey = (p: string) => `clean/partner=${p}/date=${DATE}/rows.json`;
const rejKey = (p: string) => `clean/partner=${p}/date=${DATE}/rejected.json`;

describe("readPartnerDay", () => {
  it("reads both files of the seeded partner days", async () => {
    const a = await readDay("a");
    assert.equal(a.clean.rows.length, 8);
    assert.equal(a.rejected.rows.length, 2);
    assert.equal(a.fxSource, "fixed ILS/USD 3.7");
    const b = await readDay("b");
    assert.ok(b.clean.rows.length > 0);
    assert.deepEqual(
      b.rejected.rows.map((r) => r.reason).sort(),
      ["duplicate", "invalid_date", "negative_impressions"],
    );
  });

  it("reports a partner-day with no clean files as missing", async () => {
    const { store } = memoryStore();
    assert.deepEqual(await readPartnerDay(store, "a", DATE), { status: "missing", partner: "a" });
  });

  it("refuses when rows.json and rejected.json come from different raw files", async () => {
    const { objects, store } = await seededCleanZone();
    const rejected = JSON.parse(objects.get(rejKey("a"))!);
    rejected.raw_key = "partner=a/date=2026-11-25/fetched_at=OLDER.json";
    objects.set(rejKey("a"), JSON.stringify(rejected));
    await assert.rejects(readPartnerDay(store, "a", DATE), /raw_key mismatch/);
  });

  it("refuses when only one of the two files exists", async () => {
    const { objects, store } = await seededCleanZone();
    objects.delete(rejKey("b"));
    await assert.rejects(readPartnerDay(store, "b", DATE), /only .*rows\.json exists/);
  });

  it("refuses a file for another day, a wrong count, or a row from another raw file", async () => {
    const tamper = async (key: string, edit: (f: any) => void, expected: RegExp) => {
      const { objects, store } = await seededCleanZone();
      const f = JSON.parse(objects.get(key)!);
      edit(f);
      objects.set(key, JSON.stringify(f));
      await assert.rejects(readPartnerDay(store, "a", DATE), expected);
    };
    await tamper(rowsKey("a"), (f) => (f.date = "2026-11-24"), /expected partner=a date=2026-11-25/);
    await tamper(rowsKey("a"), (f) => f.rows.pop(), /count=8 but has 7 rows/);
    await tamper(rowsKey("a"), (f) => (f.rows[0].raw_key = "other"), /row 1 .*not this partner-day/);
    await tamper(rowsKey("a"), (f) => delete f.fx_source, /no fx_source/);
    await tamper(rejKey("a"), (f) => (f.rows[0].raw_key = "other"), /row 1 is from other/);
  });

  it("refuses unparseable JSON", async () => {
    const { objects, store } = await seededCleanZone();
    objects.set(rowsKey("a"), "{not json");
    await assert.rejects(readPartnerDay(store, "a", DATE), /not valid JSON/);
  });
});

describe("loadPartnerDay", () => {
  const stored = (rows: number, revenue: string) => (text: string) =>
    text.includes("count(*)") ? [{ rows, revenue_usd: revenue }] : [];

  it("locks, deletes both tables, then inserts, all inside one transaction", async () => {
    const day = await readDay("a");
    const client = fakeClient({ respond: stored(8, "1234.5") });
    const result = await loadPartnerDay(client, day);
    const texts = client.log.map((q) => q.text.split(" (")[0]!.trim());
    assert.deepEqual(texts, [
      "BEGIN",
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      "DELETE FROM revenue_daily WHERE partner = $1 AND date = $2",
      "DELETE FROM rejected_rows WHERE partner = $1 AND date = $2",
      "INSERT INTO revenue_daily",
      "INSERT INTO rejected_rows",
      texts[6]!, // the read-back SELECT
      "COMMIT",
    ]);
    assert.match(texts[6]!, /count\(\*\)/);
    assert.deepEqual(result, {
      partner: "a", date: DATE, rawKey: day.rawKey, rowsLoaded: 8, rejectedLoaded: 2, revenueUsd: "1234.5",
    });
  });

  it("rolls back and rethrows when an insert fails, so the old day stays intact", async () => {
    const day = await readDay("b");
    const client = fakeClient({ failOn: /^INSERT INTO rejected_rows/ });
    await assert.rejects(loadPartnerDay(client, day), /boom/);
    const texts = client.log.map((q) => q.text);
    assert.equal(texts.at(-1), "ROLLBACK");
    assert.ok(!texts.includes("COMMIT"));
  });

  it("rolls back when the stored row count does not match the file", async () => {
    const day = await readDay("a");
    const client = fakeClient({ respond: stored(16, "0") });
    await assert.rejects(loadPartnerDay(client, day), /expected 8 rows in revenue_daily after insert, found 16/);
    assert.equal(client.log.at(-1)!.text, "ROLLBACK");
  });

  it("issues the same statements on a re-run (delete + insert, never append)", async () => {
    const day = await readDay("b");
    assert.deepEqual(loadStatements(day), loadStatements(day));
    const first = fakeClient({ respond: stored(day.clean.rows.length, "1") });
    const second = fakeClient({ respond: stored(day.clean.rows.length, "1") });
    await loadPartnerDay(first, day);
    await loadPartnerDay(second, day);
    assert.deepEqual(first.log, second.log);
  });

  it("loads a day with no rejected rows without an empty INSERT", async () => {
    const day = await readDay("a");
    const clean: PartnerDay = { ...day, rejected: { ...day.rejected, count: 0, rows: [] } };
    const client = fakeClient({ respond: stored(8, "1") });
    await loadPartnerDay(client, clean);
    assert.ok(!client.log.some((q) => q.text.startsWith("INSERT INTO rejected_rows")));
    assert.ok(client.log.some((q) => q.text.startsWith("DELETE FROM rejected_rows")));
  });
});
