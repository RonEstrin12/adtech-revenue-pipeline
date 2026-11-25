/**
 * Ingest partner A: call its REST API and store the response as-is in S3.
 */
import { putRaw, type RawPutResult } from "../lib/s3.js";

const BASE_URL = process.env.PARTNER_A_URL ?? `http://localhost:${process.env.PARTNER_A_PORT ?? 4001}`;
const API_KEY = process.env.PARTNER_A_API_KEY ?? "";

const MAX_ATTEMPTS = 3;

/**
 * Retries network errors and 5xx (the partner may be briefly down),
 * but not 4xx: a bad key or bad date will not fix itself on retry.
 */
async function fetchWithRetry(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "x-api-key": API_KEY } });
      const body = await res.text();
      if (res.ok) return body;
      if (res.status < 500) throw Object.assign(new Error(`HTTP ${res.status}: ${body}`), { retry: false });
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const retryable = (err as { retry?: boolean }).retry !== false;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      const waitMs = 500 * 2 ** (attempt - 1); // 0.5s, 1s, ...
      console.warn(`  partner A attempt ${attempt} failed (${(err as Error).message}), retrying in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

export async function ingestPartnerA(date: string): Promise<RawPutResult> {
  const body = await fetchWithRetry(`${BASE_URL}/api/v1/reports?date=${date}`);
  return putRaw(`partner=a/date=${date}`, "json", body, { source: "partner-a-api" });
}
