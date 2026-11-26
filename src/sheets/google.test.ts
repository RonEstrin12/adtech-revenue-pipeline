/**
 * Google auth and the Sheets client, tested only against an in-memory fake of the token endpoint
 * and the Sheets API v4 (an injected fetch), with a throwaway RSA key made here. No test talks to Google.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, it } from "node:test";
import { type FetchLike, SHEETS_SCOPE, TOKEN_URL, fetchAccessToken, signJwt } from "./google-auth.js";
import { GoogleSheets, GoogleSheetsStore, SHEETS_API, padToCover, quoteTab } from "./google-sheets.js";
import { publishDate } from "./publish.js";
import { type Cell, TABS, buildTabRows } from "./rows.js";
import { REPORT } from "./test-fixtures.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const ACCOUNT = { client_email: "pipeline@test-proj.iam.gserviceaccount.com", private_key: PEM };
const ID = "sheet-id-0123456789";
const NOW = new Date("2026-11-26T06:00:00Z");

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/** Checks an RS256 JWT against the throwaway public key; returns its claims. */
function verifyJwt(jwt: string) {
  const [h, p, s] = jwt.split(".");
  assert.ok(h && p && s, "three parts");
  assert.deepEqual(decode(h), { alg: "RS256", typ: "JWT" });
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")), "signature verifies");
  return decode(p);
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** A fake of oauth2.googleapis.com/token and the Sheets API, holding tabs as arrays of rows. */
function fakeGoogle(opts: { tabs?: Record<string, Cell[][]>; failWrite?: number; failToken?: boolean } = {}) {
  const tabs = new Map<string, Cell[][]>(Object.entries(opts.tabs ?? {}));
  const calls: { method: string; url: string; auth?: string; body?: any }[] = [];
  let tokens = 0;

  const fetchFn: FetchLike = async (url, init) => {
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    const raw = init.body === undefined ? undefined : String(init.body);
    calls.push({ method, url, auth: headers.Authorization, body: raw });

    if (url === TOKEN_URL) {
      if (opts.failToken) return json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400);
      const form = new URLSearchParams(raw);
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      verifyJwt(form.get("assertion")!);
      tokens++;
      return json({ access_token: `tok-${tokens}`, expires_in: 3599, token_type: "Bearer" });
    }

    assert.ok(url.startsWith(`${SHEETS_API}/${ID}`), `unexpected URL ${url}`);
    assert.match(headers.Authorization ?? "", /^Bearer tok-\d+$/);
    const u = new URL(url);
    const rest = decodeURIComponent(u.pathname.slice(`/v4/spreadsheets/${ID}`.length));
    const body = raw ? JSON.parse(raw) : undefined;
    calls.at(-1)!.body = body;
    const unquote = (range: string) => range.replace(/!.*$/, "").replace(/^'(.*)'$/, "$1").replace(/''/g, "'");

    if (method === "GET" && rest === "") {
      assert.equal(u.searchParams.get("fields"), "sheets.properties.title");
      return json({ sheets: [...tabs.keys()].map((title) => ({ properties: { title } })) });
    }
    if (method === "POST" && rest === ":batchUpdate") {
      for (const r of body.requests) {
        const title = r.addSheet.properties.title;
        if (tabs.has(title)) return json({ error: { message: `A sheet with the name "${title}" already exists` } }, 400);
        tabs.set(title, []);
      }
      return json({ replies: [] });
    }
    if (method === "GET" && rest === "/values:batchGet") {
      assert.equal(u.searchParams.get("valueRenderOption"), "UNFORMATTED_VALUE");
      const valueRanges = u.searchParams.getAll("ranges").map((range) => {
        const t = tabs.get(unquote(range));
        if (!t) throw new Error(`fake: no tab ${range}`);
        // Like the API: trailing empty cells and rows are left out.
        const trimmed = t.map((r) => { const c = [...r]; while (c.length && c.at(-1) === "") c.pop(); return c; });
        while (trimmed.length && trimmed.at(-1)!.length === 0) trimmed.pop();
        return trimmed.length ? { range, values: trimmed } : { range };
      });
      return json({ valueRanges });
    }
    if (method === "POST" && rest === "/values:batchUpdate") {
      if (opts.failWrite) return json({ error: { code: opts.failWrite, message: "The caller does not have permission" } }, opts.failWrite);
      assert.equal(body.valueInputOption, "RAW");
      for (const d of body.data) {
        assert.match(d.range, /!A1$/);
        const t = tabs.get(unquote(d.range))!;
        d.values.forEach((row: Cell[], i: number) => {
          t[i] ??= [];
          row.forEach((cell, j) => (t[i]![j] = cell)); // "" clears a cell, as in the API
        });
      }
      return json({ totalUpdatedCells: 1 });
    }
    return json({ error: { message: `fake: unhandled ${method} ${rest}` } }, 500);
  };

  /** A tab without empty cells and rows, as a person would see it. */
  const visible = (title: string) =>
    (tabs.get(title) ?? []).map((r) => { const c = [...r]; while (c.length && c.at(-1) === "") c.pop(); return c; }).filter((r) => r.length > 0);
  return { fetchFn, calls, tabs, visible, tokenCount: () => tokens };
}

describe("signJwt / fetchAccessToken", () => {
  it("signs an RS256 JWT for the service account that verifies with its public key", () => {
    const jwt = signJwt({ iss: ACCOUNT.client_email, n: 1 }, PEM);
    assert.deepEqual(verifyJwt(jwt), { iss: ACCOUNT.client_email, n: 1 });
    assert.doesNotMatch(jwt, /[+/=]/, "base64url, no padding");
    const [h, p, s] = jwt.split(".");
    assert.equal(verify("sha256", Buffer.from(`${h}.${p}x`), publicKey, Buffer.from(s!, "base64url")), false, "tampering breaks it");
  });

  it("asks Google's token endpoint for a spreadsheets-scoped token with the signed assertion", async () => {
    const g = fakeGoogle();
    assert.equal(await fetchAccessToken(ACCOUNT, g.fetchFn, NOW), "tok-1");
    const call = g.calls[0]!;
    assert.equal(call.method, "POST");
    assert.equal(call.url, "https://oauth2.googleapis.com/token");
    const claims = verifyJwt(new URLSearchParams(call.body).get("assertion")!);
    const iat = NOW.getTime() / 1000;
    assert.deepEqual(claims, { iss: ACCOUNT.client_email, scope: SHEETS_SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 });
    assert.equal(SHEETS_SCOPE, "https://www.googleapis.com/auth/spreadsheets");
  });

  it("fails clearly on a refused token, a bad response, or a key that cannot sign", async () => {
    await assert.rejects(fetchAccessToken(ACCOUNT, fakeGoogle({ failToken: true }).fetchFn), /Google token request failed: 400 .*invalid_grant/);
    await assert.rejects(fetchAccessToken(ACCOUNT, async () => json({ token_type: "Bearer" })), /has no access_token/);
    await assert.rejects(fetchAccessToken(ACCOUNT, async () => new Response("<html>")), /not JSON/);
    await assert.rejects(fetchAccessToken({ ...ACCOUNT, private_key: "-----BEGIN PRIVATE KEY-----\nxx\n-----END PRIVATE KEY-----" }, fakeGoogle().fetchFn), /cannot sign/);
  });
});

describe("GoogleSheets client", () => {
  const config = { spreadsheetId: ID, serviceAccount: ACCOUNT };

  it("quotes tab names for A1 ranges", () => {
    assert.equal(quoteTab("By partner"), "'By partner'");
    assert.equal(quoteTab("Bob's"), "'Bob''s'");
  });

  it("pads the write so every previously filled cell is overwritten", () => {
    assert.deepEqual(padToCover([["h", "i"], ["1"]], [["h", "i", "x"], ["1", 2], ["3"]]), [["h", "i", ""], ["1", "", ""], ["", "", ""]]);
  });

  it("creates missing tabs, reads, and writes every tab back in one request with one token", async () => {
    const g = fakeGoogle({ tabs: { Daily: [], Notes: [["keep me"]] } });
    const store = new GoogleSheetsStore(new GoogleSheets(config, g.fetchFn));
    await publishDate(store, "2026-11-25", buildTabRows(REPORT, "warn"));

    assert.deepEqual(g.calls.map((c) => `${c.method} ${c.url.replace(SHEETS_API + "/" + ID, "").split("?")[0]}`), [
      `POST ${TOKEN_URL}`,
      "GET ",
      "POST :batchUpdate",
      "GET /values:batchGet",
      "POST /values:batchUpdate",
    ]);
    assert.equal(g.tokenCount(), 1);
    const add = g.calls[2]!.body.requests.map((r: any) => r.addSheet.properties);
    assert.deepEqual(add.map((p: any) => p.title), ["By partner", "By site", "By ad unit"]);
    assert.equal(add[0].gridProperties.frozenRowCount, 1);
    assert.deepEqual(g.visible("Daily"), [[...TABS.daily.header], ["2026-11-25", 2208.320271, 824500, 2.678375, 2, 15, 7, "warn"]]);
    assert.deepEqual(g.visible("Notes"), [["keep me"]], "other tabs are not touched");
    for (const c of g.calls) assert.ok(!c.url.startsWith(SHEETS_API) || c.auth === "Bearer tok-1");
  });

  it("is idempotent against the sheet: re-running a date replaces it, other dates stay, fewer rows leave nothing stale", async () => {
    const g = fakeGoogle();
    const publish = (date: string, report = REPORT) =>
      publishDate(new GoogleSheetsStore(new GoogleSheets(config, g.fetchFn)), date, buildTabRows({ ...report, date }, null));

    await publish("2026-11-25");
    await publish("2026-11-23");
    await publish("2026-11-24");
    const once = g.visible("By partner");
    await publish("2026-11-25");
    assert.deepEqual(g.visible("By partner"), once);
    assert.equal(once.length, 1 + 3 * 3);
    assert.deepEqual(once.slice(1).map((r) => `${r[0]}/${r[1]}`), [
      "2026-11-23/a", "2026-11-23/b", "2026-11-23/c",
      "2026-11-24/a", "2026-11-24/b", "2026-11-24/c",
      "2026-11-25/a", "2026-11-25/b", "2026-11-25/c",
    ]);

    // 2026-11-24 again, now with only partner a: its b and c rows go, and the tab shrinks cleanly.
    await publish("2026-11-24", { ...REPORT, byPartner: REPORT.byPartner.slice(0, 1), rejects: [] });
    assert.deepEqual(g.visible("By partner").slice(1).map((r) => `${r[0]}/${r[1]}`), [
      "2026-11-23/a", "2026-11-23/b", "2026-11-23/c", "2026-11-24/a", "2026-11-25/a", "2026-11-25/b", "2026-11-25/c",
    ]);
    assert.deepEqual(g.visible("Daily").map((r) => r[0]), ["date", "2026-11-23", "2026-11-24", "2026-11-25"]);
  });

  it("writes nothing when a tab has someone else's header", async () => {
    const g = fakeGoogle({ tabs: { Daily: [["Date", "Revenue"], ["2026-11-01", 5]] } });
    await assert.rejects(
      publishDate(new GoogleSheetsStore(new GoogleSheets(config, g.fetchFn)), "2026-11-25", buildTabRows(REPORT, null)),
      /tab "Daily" has an unexpected header/,
    );
    assert.ok(!g.calls.some((c) => c.url.includes("values:batchUpdate")));
  });

  it("reports API errors with a hint, and token errors before any Sheets call", async () => {
    const denied = fakeGoogle({ failWrite: 403 });
    await assert.rejects(
      publishDate(new GoogleSheetsStore(new GoogleSheets(config, denied.fetchFn)), "2026-11-25", buildTabRows(REPORT, null)),
      /Google Sheets POST \/values:batchUpdate failed: 403 \(share the sheet with pipeline@test-proj.iam.gserviceaccount.com as Editor/,
    );
    const noToken = fakeGoogle({ failToken: true });
    await assert.rejects(new GoogleSheets(config, noToken.fetchFn).tabTitles(), /token request failed: 400/);
    assert.equal(noToken.calls.length, 1);
  });
});
