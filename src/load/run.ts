/**
 * Stage 4 for one partner-day: read the clean zone and replace that partner-day in Postgres.
 *
 *   clean/partner=<p>/date=<d>/rows.json      -> revenue_daily
 *   clean/partner=<p>/date=<d>/rejected.json  -> rejected_rows
 *
 * Idempotency: one transaction deletes the partner-day from both tables, then inserts it again.
 * Re-running a day, or loading after stage 3 was re-run on a corrected raw file, replaces the
 * day instead of adding to it, so revenue is never counted twice.
 */
import { isIsoDate } from "../lib/dates.js";
import { type Queryable, withTransaction } from "../lib/db.js";
import { type CleanFile, type RejectedFile, cleanPrefix } from "../validate/run.js";
import {
  type Statement,
  deletePartnerDayStatements,
  insertRejectedStatements,
  insertRevenueStatements,
  lockPartnerDayStatement,
} from "./sql.js";

export interface CleanStore {
  listKeys(prefix: string): Promise<string[]>;
  getText(key: string): Promise<string>;
}

/** Both clean files for one partner-day, checked to belong together. */
export interface PartnerDay {
  partner: string;
  date: string;
  rawKey: string;
  fxSource: string;
  clean: CleanFile;
  rejected: RejectedFile;
}

export type ReadOutcome = { status: "missing"; partner: string } | { status: "ok"; day: PartnerDay };

function parseJson<T>(key: string, body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch (err) {
    throw new Error(`${key} is not valid JSON: ${(err as Error).message}`);
  }
}

function checkHeader(key: string, file: { date?: unknown; partner?: unknown; raw_key?: unknown; count?: unknown; rows?: unknown }, partner: string, date: string) {
  if (file.partner !== partner || file.date !== date) {
    throw new Error(`${key} is for partner=${String(file.partner)} date=${String(file.date)}, expected partner=${partner} date=${date}`);
  }
  if (typeof file.raw_key !== "string" || !file.raw_key) throw new Error(`${key} has no raw_key`);
  if (!Array.isArray(file.rows)) throw new Error(`${key} has no rows array`);
  if (file.count !== file.rows.length) throw new Error(`${key} says count=${String(file.count)} but has ${file.rows.length} rows`);
}

/**
 * Reads rows.json and rejected.json for a partner-day. Refuses (throws) when only one of them
 * exists, when they come from different raw files (stage 3 was interrupted between the two
 * writes), or when a row does not belong to this partner-day.
 */
export async function readPartnerDay(store: CleanStore, partner: string, date: string): Promise<ReadOutcome> {
  if (!isIsoDate(date)) throw new Error(`invalid date "${date}"`);
  const prefix = cleanPrefix(partner, date);
  const cleanKey = `${prefix}rows.json`;
  const rejectedKey = `${prefix}rejected.json`;
  const keys = new Set(await store.listKeys(prefix));
  const hasClean = keys.has(cleanKey);
  const hasRejected = keys.has(rejectedKey);
  if (!hasClean && !hasRejected) return { status: "missing", partner };
  if (!hasClean || !hasRejected) {
    throw new Error(`only ${hasClean ? cleanKey : rejectedKey} exists; re-run npm run validate -- ${date}`);
  }

  const clean = parseJson<CleanFile>(cleanKey, await store.getText(cleanKey));
  const rejected = parseJson<RejectedFile>(rejectedKey, await store.getText(rejectedKey));
  checkHeader(cleanKey, clean, partner, date);
  checkHeader(rejectedKey, rejected, partner, date);
  if (clean.raw_key !== rejected.raw_key) {
    throw new Error(
      `raw_key mismatch: rows.json is from ${clean.raw_key} but rejected.json is from ${rejected.raw_key}; ` +
        `refusing to load, re-run npm run validate -- ${date}`,
    );
  }
  if (typeof clean.fx_source !== "string" || !clean.fx_source) throw new Error(`${cleanKey} has no fx_source`);
  for (const [i, r] of clean.rows.entries()) {
    if (r.partner !== partner || r.date !== date || r.raw_key !== clean.raw_key) {
      throw new Error(`${cleanKey} row ${i + 1} is for ${r.partner}/${r.date} from ${r.raw_key}, not this partner-day`);
    }
  }
  for (const [i, r] of rejected.rows.entries()) {
    if (r.raw_key !== clean.raw_key) throw new Error(`${rejectedKey} row ${i + 1} is from ${r.raw_key}, not ${clean.raw_key}`);
  }
  return { status: "ok", day: { partner, date, rawKey: clean.raw_key, fxSource: clean.fx_source, clean, rejected } };
}

/** Every statement of one partner-day load, in order (without BEGIN/COMMIT). */
export function loadStatements(day: PartnerDay): Statement[] {
  return [
    lockPartnerDayStatement(day.partner, day.date),
    ...deletePartnerDayStatements(day.partner, day.date),
    ...insertRevenueStatements(day.clean.rows, day.fxSource),
    ...insertRejectedStatements(day.partner, day.date, day.rejected.rows),
  ];
}

export interface LoadResult {
  partner: string;
  date: string;
  rawKey: string;
  rowsLoaded: number;
  rejectedLoaded: number;
  /** SUM(revenue_usd) for the partner-day as stored, an exact decimal string from Postgres. */
  revenueUsd: string;
}

/**
 * Replaces one partner-day in a single transaction. `client` must be one connection
 * (a pg Client or PoolClient), never a Pool, so BEGIN and COMMIT run on the same session.
 */
export async function loadPartnerDay(client: Queryable, day: PartnerDay): Promise<LoadResult> {
  return withTransaction(client, async () => {
    for (const s of loadStatements(day)) await client.query(s.text, s.values);
    const res = await client.query(
      `SELECT count(*)::int AS rows, COALESCE(SUM(revenue_usd), 0)::text AS revenue_usd
         FROM revenue_daily WHERE partner = $1 AND date = $2`,
      [day.partner, day.date],
    );
    const stored = res.rows[0] as { rows: number; revenue_usd: string };
    if (stored.rows !== day.clean.rows.length) {
      throw new Error(`expected ${day.clean.rows.length} rows in revenue_daily after insert, found ${stored.rows}`);
    }
    return {
      partner: day.partner,
      date: day.date,
      rawKey: day.rawKey,
      rowsLoaded: stored.rows,
      rejectedLoaded: day.rejected.rows.length,
      revenueUsd: stored.revenue_usd,
    };
  });
}
