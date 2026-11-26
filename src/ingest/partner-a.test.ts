import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fetchWithRetry } from "./partner-a.js";

/** A tiny local server whose behaviour each test scripts per request. */
let server: Server;
let baseUrl: string;
let handler: (n: number, res: import("node:http").ServerResponse) => void;
let hits = 0;

before(async () => {
  server = createServer((_req, res) => handler(++hits, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const fast = { maxAttempts: 3, baseDelayMs: 1, timeoutMs: 200 };

describe("fetchWithRetry", () => {
  it("returns the body on success", async () => {
    hits = 0;
    handler = (_n, res) => res.end('{"ok":true}');
    assert.equal(await fetchWithRetry(baseUrl, fast), '{"ok":true}');
    assert.equal(hits, 1);
  });

  it("times out a hanging request and retries it", async () => {
    hits = 0;
    handler = (n, res) => {
      if (n === 1) return; // never answers
      res.end("late but fine");
    };
    assert.equal(await fetchWithRetry(baseUrl, fast), "late but fine");
    assert.equal(hits, 2);
  });

  it("times out a response whose body stalls", async () => {
    hits = 0;
    handler = (_n, res) => {
      res.writeHead(200);
      res.write("partial"); // headers sent, body never finishes
    };
    await assert.rejects(fetchWithRetry(baseUrl, { ...fast, maxAttempts: 1 }), /timed out after 200ms/);
  });

  it("gives up after maxAttempts when the partner never answers", async () => {
    hits = 0;
    handler = () => {};
    const started = Date.now();
    await assert.rejects(fetchWithRetry(baseUrl, fast), /timed out after 200ms/);
    assert.equal(hits, 3);
    assert.ok(Date.now() - started < 2_000);
  });

  it("retries 5xx", async () => {
    hits = 0;
    handler = (n, res) => {
      res.statusCode = n < 3 ? 503 : 200;
      res.end(n < 3 ? "down" : "up");
    };
    assert.equal(await fetchWithRetry(baseUrl, fast), "up");
    assert.equal(hits, 3);
  });

  it("does not retry 4xx", async () => {
    hits = 0;
    handler = (_n, res) => {
      res.statusCode = 401;
      res.end('{"error":"invalid api key"}');
    };
    await assert.rejects(fetchWithRetry(baseUrl, fast), /HTTP 401/);
    assert.equal(hits, 1);
  });
});
