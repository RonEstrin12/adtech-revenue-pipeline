/**
 * Ingest partner A: call its REST API and store the response as-is in S3.
 */
import { putRaw, type RawPutResult } from "../lib/s3.js";

const BASE_URL = process.env.PARTNER_A_URL ?? `http://localhost:${process.env.PARTNER_A_PORT ?? 4001}`;
const API_KEY = process.env.PARTNER_A_API_KEY ?? "";
const TIMEOUT_MS = Number(process.env.PARTNER_A_TIMEOUT_MS ?? 30_000);

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Per attempt, covering both the response headers and the body. */
  timeoutMs?: number;
  maxAttempts?: number;
  /** First backoff wait; doubles on each retry. */
  baseDelayMs?: number;
}

/**
 * Retries network errors, timeouts and 5xx (the partner may be briefly down or slow),
 * but not 4xx: a bad key or bad date will not fix itself on retry.
 */
export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<string> {
  const { headers = {}, timeoutMs = TIMEOUT_MS, maxAttempts = 3, baseDelayMs = 500 } = opts;
  for (let attempt = 1; ; attempt++) {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      let res: Response;
      let body: string;
      try {
        res = await fetch(url, { headers, signal });
        body = await res.text();
      } catch (err) {
        if ((err as Error).name === "TimeoutError") throw new Error(`timed out after ${timeoutMs}ms`);
        throw err;
      }
      if (res.ok) return body;
      if (res.status < 500) throw Object.assign(new Error(`HTTP ${res.status}: ${body}`), { retry: false });
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const retryable = (err as { retry?: boolean }).retry !== false;
      if (!retryable || attempt >= maxAttempts) throw err;
      const waitMs = baseDelayMs * 2 ** (attempt - 1); // 0.5s, 1s, ...
      console.warn(`  partner A attempt ${attempt} failed (${(err as Error).message}), retrying in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

export async function ingestPartnerA(date: string): Promise<RawPutResult> {
  const body = await fetchWithRetry(`${BASE_URL}/api/v1/reports?date=${date}`, {
    headers: { "x-api-key": API_KEY },
  });
  return putRaw(`partner=a/date=${date}`, "json", body, { source: "partner-a-api" });
}
