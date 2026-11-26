import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeClient } from "./fake-db.js";
import { migrate, readMigrations } from "./migrate.js";

describe("readMigrations", () => {
  it("reads db/migrations/*.sql in order", async () => {
    const ms = await readMigrations();
    assert.equal(ms[0]!.version, "001_init.sql");
    assert.match(ms[0]!.sql, /CREATE TABLE revenue_daily/);
    assert.match(ms[0]!.sql, /PRIMARY KEY \(partner, date, site, ad_unit\)/);
    assert.match(ms[0]!.sql, /CREATE TABLE rejected_rows/);
    assert.equal(ms[1]!.version, "002_analysis_views.sql");
    // Views must be re-runnable: no plain CREATE VIEW / CREATE FUNCTION.
    assert.doesNotMatch(ms[1]!.sql, /CREATE (VIEW|FUNCTION)/);
    assert.match(ms[1]!.sql, /NULLIF\(impressions, 0\)/);
  });
});

describe("migrate", () => {
  const migrations = [
    { version: "001_a.sql", sql: "CREATE TABLE a ()" },
    { version: "002_b.sql", sql: "CREATE TABLE b ()" },
  ];

  it("applies pending migrations, each in its own transaction, and records them", async () => {
    const client = fakeClient({ respond: (t, v) => (t.startsWith("SELECT 1") && v?.[0] === "001_a.sql" ? [{}] : []) });
    const applied = await migrate(client, migrations);
    assert.deepEqual(applied, ["002_b.sql"]);
    const texts = client.log.map((q) => q.text);
    assert.match(texts[0]!, /CREATE TABLE IF NOT EXISTS schema_migrations/);
    assert.ok(!texts.includes("CREATE TABLE a ()"), "already-applied migration must not run again");
    const b = texts.indexOf("CREATE TABLE b ()");
    assert.equal(texts[b + 1], "INSERT INTO schema_migrations (version) VALUES ($1)");
    assert.equal(texts[b + 2], "COMMIT");
  });

  it("rolls back a failing migration and stops", async () => {
    const client = fakeClient({ failOn: /CREATE TABLE a/ });
    await assert.rejects(migrate(client, migrations), /boom/);
    const texts = client.log.map((q) => q.text);
    assert.equal(texts.at(-1), "ROLLBACK");
    assert.ok(!texts.includes("CREATE TABLE b ()"));
  });
});
