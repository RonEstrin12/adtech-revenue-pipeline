import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { googleSheetsConfigFromEnv, parseServiceAccount, parseSpreadsheetId, sheetsMode, sheetsOutDir } from "./config.js";

const KEY = { type: "service_account", client_email: "pipeline@proj.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" };
const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcd";

describe("sheetsMode", () => {
  it("is a dry run unless SHEETS_MODE=google", () => {
    assert.equal(sheetsMode({}), "dry-run");
    assert.equal(sheetsMode({ SHEETS_MODE: "" }), "dry-run");
    assert.equal(sheetsMode({ SHEETS_MODE: " dry-run " }), "dry-run");
    assert.equal(sheetsMode({ SHEETS_MODE: "Google" }), "google");
  });

  it("rejects any other value instead of silently skipping the sheet", () => {
    assert.throws(() => sheetsMode({ SHEETS_MODE: "gogle" }), /SHEETS_MODE must be empty \(dry run\) or "google", got "gogle"/);
  });

  it("writes dry-run CSVs to out/sheets unless SHEETS_OUT_DIR is set", () => {
    assert.equal(sheetsOutDir({}), "out/sheets");
    assert.equal(sheetsOutDir({ SHEETS_OUT_DIR: "/tmp/x" }), "/tmp/x");
  });
});

describe("parseSpreadsheetId", () => {
  it("takes the ID, or extracts it from a pasted sheet URL", () => {
    assert.equal(parseSpreadsheetId(ID), ID);
    assert.equal(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`), ID);
  });

  it("rejects a missing or malformed ID", () => {
    assert.throws(() => parseSpreadsheetId(undefined), /needs SHEETS_SPREADSHEET_ID/);
    assert.throws(() => parseSpreadsheetId("  "), /needs SHEETS_SPREADSHEET_ID/);
    assert.throws(() => parseSpreadsheetId("abc/../x?y"), /does not look like a spreadsheet ID/);
  });
});

describe("parseServiceAccount", () => {
  it("accepts the key JSON inline (a GitHub Actions secret), with \\n escapes in the key", () => {
    assert.deepEqual(parseServiceAccount(JSON.stringify(KEY)), { client_email: KEY.client_email, private_key: KEY.private_key });
  });

  it("accepts a path to the key file", () => {
    const files: Record<string, string> = { "/keys/sa.json": JSON.stringify(KEY) };
    const read = (p: string) => {
      if (!(p in files)) throw Object.assign(new Error("nope"), { code: "ENOENT" });
      return files[p]!;
    };
    assert.equal(parseServiceAccount(" /keys/sa.json ", read).client_email, KEY.client_email);
    assert.throws(() => parseServiceAccount("/keys/missing.json", read), /cannot read service account key file \/keys\/missing.json: ENOENT/);
  });

  it("rejects missing, invalid or incomplete keys without echoing the key", () => {
    assert.throws(() => parseServiceAccount(undefined), /needs GOOGLE_SERVICE_ACCOUNT_JSON/);
    assert.throws(() => parseServiceAccount('{"private_key": "secret'), (e: Error) => /is not valid JSON/.test(e.message) && !e.message.includes("secret"));
    assert.throws(() => parseServiceAccount(JSON.stringify({ ...KEY, client_email: undefined })), /has no client_email/);
    assert.throws(() => parseServiceAccount(JSON.stringify({ ...KEY, private_key: "x" })), /has no private_key/);
    assert.throws(() => parseServiceAccount(JSON.stringify({ ...KEY, type: "authorized_user" })), /not a service account key/);
  });
});

describe("googleSheetsConfigFromEnv", () => {
  it("needs both the spreadsheet ID and the key", () => {
    const env = { SHEETS_SPREADSHEET_ID: ID, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(KEY) };
    assert.equal(googleSheetsConfigFromEnv(env).spreadsheetId, ID);
    assert.throws(() => googleSheetsConfigFromEnv({ ...env, SHEETS_SPREADSHEET_ID: "" }), /SHEETS_SPREADSHEET_ID/);
    assert.throws(() => googleSheetsConfigFromEnv({ ...env, GOOGLE_SERVICE_ACCOUNT_JSON: "" }), /GOOGLE_SERVICE_ACCOUNT_JSON/);
  });
});
