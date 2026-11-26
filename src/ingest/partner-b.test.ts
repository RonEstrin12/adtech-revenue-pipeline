import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { sha256, type putRaw, type RawPutResult } from "../lib/s3.js";
import { buildPartnerBCsv } from "../mock-partners/partner-b-drop.js";
import { MissingFileError, ingestPartnerB } from "./partner-b.js";

const DATE = "2026-11-24";

/** In-memory stand-in for putRaw with the same sha256 dedup rule. */
function fakeStore() {
  const objects: { key: string; hash: string; body: string }[] = [];
  const put: typeof putRaw = async (prefix, ext, body): Promise<RawPutResult> => {
    const bytes = Buffer.byteLength(body);
    const latest = objects.filter((o) => o.key.startsWith(`${prefix}/`)).at(-1);
    if (latest?.hash === sha256(body)) return { key: latest.key, status: "unchanged", bytes };
    const key = `${prefix}/fetched_at=${objects.length}.${ext}`;
    objects.push({ key, hash: sha256(body), body });
    return { key, status: "stored", bytes };
  };
  return { objects, put };
}

let inbox: string;
beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), "partner-b-"));
});
afterEach(() => rmSync(inbox, { recursive: true, force: true }));

const drop = (body = buildPartnerBCsv(DATE)) => writeFileSync(join(inbox, `report_${DATE}.csv`), body);
const processed = join("processed", `report_${DATE}.csv`);

describe("ingestPartnerB", () => {
  it("stores the seeded file unchanged and moves it to processed/", async () => {
    const store = fakeStore();
    drop();
    const r = await ingestPartnerB(DATE, { inbox, put: store.put });
    assert.equal(r.status, "stored");
    assert.equal(store.objects[0].body, buildPartnerBCsv(DATE)); // raw kept byte-for-byte, dirty rows included
    assert.equal(existsSync(join(inbox, `report_${DATE}.csv`)), false);
    assert.equal(existsSync(join(inbox, processed)), true);
  });

  it("re-running an already-processed day is unchanged, not an error", async () => {
    const store = fakeStore();
    drop();
    const first = await ingestPartnerB(DATE, { inbox, put: store.put });
    const again = await ingestPartnerB(DATE, { inbox, put: store.put });
    assert.equal(again.status, "unchanged");
    assert.equal(again.key, first.key);
    assert.equal(store.objects.length, 1);
    assert.equal(existsSync(join(inbox, processed)), true);
  });

  it("a corrected file dropped after processing is stored as a new version", async () => {
    const store = fakeStore();
    drop();
    await ingestPartnerB(DATE, { inbox, put: store.put });
    drop(buildPartnerBCsv(DATE) + "24/11/2026,news.co.il,sidebar,1,1.00,ILS\n");
    const r = await ingestPartnerB(DATE, { inbox, put: store.put });
    assert.equal(r.status, "stored");
    assert.equal(store.objects.length, 2);
    assert.match(readFileSync(join(inbox, processed), "utf-8"), /sidebar,1,1\.00/);
  });

  it("re-uploads from processed/ if the raw zone lost the file", async () => {
    mkdirSync(join(inbox, "processed"));
    writeFileSync(join(inbox, processed), buildPartnerBCsv(DATE));
    const store = fakeStore();
    const r = await ingestPartnerB(DATE, { inbox, put: store.put });
    assert.equal(r.status, "stored");
  });

  it("throws MissingFileError when the partner has not delivered", async () => {
    const store = fakeStore();
    await assert.rejects(ingestPartnerB(DATE, { inbox, put: store.put }), MissingFileError);
    assert.equal(store.objects.length, 0);
  });

  it("does not move the file if the upload fails", async () => {
    drop();
    const failing: typeof putRaw = async () => {
      throw new Error("S3 down");
    };
    await assert.rejects(ingestPartnerB(DATE, { inbox, put: failing }), /S3 down/);
    assert.equal(existsSync(join(inbox, `report_${DATE}.csv`)), true);
  });
});
