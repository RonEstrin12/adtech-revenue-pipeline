import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeClient } from "../lib/fake-db.js";
import type { QaResult } from "./checks.js";
import { QA_SQL, saveQaResults } from "./store.js";

const RESULTS: QaResult[] = [
  { check: "zero_totals", partner: null, status: "pass", message: "ok", details: { impressions: 1 } },
  { check: "reject_share", partner: "b", status: "warn", message: "30%", details: {} },
];

describe("saveQaResults", () => {
  it("replaces the date's results in one transaction", async () => {
    const client = fakeClient();
    await saveQaResults(client, "2026-11-25", RESULTS);
    assert.deepEqual(client.log.map((q) => q.text), ["BEGIN", QA_SQL.lock, QA_SQL.delete, QA_SQL.insert, "COMMIT"]);
    assert.deepEqual(client.log[2]!.values, ["2026-11-25"]);
    assert.deepEqual(JSON.parse(client.log[3]!.values![1] as string), RESULTS);
  });

  it("rolls back, keeping the previous results, when the insert fails", async () => {
    const client = fakeClient({ failOn: /INSERT INTO qa_results/ });
    await assert.rejects(saveQaResults(client, "2026-11-25", RESULTS), /boom/);
    assert.equal(client.log.at(-1)!.text, "ROLLBACK");
  });
});
