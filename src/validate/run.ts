/**
 * Stage 3 for one day: read the latest raw file per partner, validate and normalize it,
 * and write the result to the clean zone:
 *
 *   clean/partner=<p>/date=<d>/rows.json       canonical rows, ready for stage 4
 *   clean/partner=<p>/date=<d>/rejected.json   rejected rows with reason and raw_key
 *
 * The keys are fixed per partner and day and are overwritten on every run, so
 * re-running a day (or re-running after a corrected raw file arrives) replaces
 * the output instead of adding to it.
 */
import type { FxRates } from "../lib/fx.js";
import { CLEAN_PREFIX } from "../lib/s3.js";
import { validatePartnerA } from "./partner-a.js";
import { validatePartnerB } from "./partner-b.js";
import type { CanonicalRow, RejectedRow, ValidationResult } from "./types.js";

export interface Store {
  listKeys(prefix: string): Promise<string[]>;
  getText(key: string): Promise<string>;
  putText(key: string, body: string): Promise<void>;
}

type Validator = (body: string, rawKey: string, date: string, fx: FxRates) => ValidationResult;

export const PARTNERS: Record<string, Validator> = {
  a: validatePartnerA,
  b: validatePartnerB,
};

export interface CleanFile {
  date: string;
  partner: string;
  raw_key: string;
  fx_source: string;
  count: number;
  rows: CanonicalRow[];
}

export interface RejectedFile {
  date: string;
  partner: string;
  raw_key: string;
  count: number;
  rows: RejectedRow[];
}

export type PartnerOutcome =
  | { partner: string; status: "missing" }
  | { partner: string; status: "ok"; rawKey: string; cleanKey: string; rejectedKey: string; result: ValidationResult };

export const cleanPrefix = (partner: string, date: string) => `${CLEAN_PREFIX}partner=${partner}/date=${date}/`;

/** Raw keys sort by fetched_at, so the last one is the newest version the partner sent. */
export async function latestRawKey(store: Store, partner: string, date: string): Promise<string | undefined> {
  return (await store.listKeys(`partner=${partner}/date=${date}/`)).at(-1);
}

export async function validatePartnerDay(
  store: Store,
  partner: string,
  date: string,
  fx: FxRates,
): Promise<PartnerOutcome> {
  const validate = PARTNERS[partner];
  if (!validate) throw new Error(`unknown partner "${partner}"`);

  const rawKey = await latestRawKey(store, partner, date);
  if (!rawKey) return { partner, status: "missing" };

  const result = validate(await store.getText(rawKey), rawKey, date, fx);
  const prefix = cleanPrefix(partner, date);
  const cleanKey = `${prefix}rows.json`;
  const rejectedKey = `${prefix}rejected.json`;

  const clean: CleanFile = { date, partner, raw_key: rawKey, fx_source: fx.source, count: result.clean.length, rows: result.clean };
  const rejected: RejectedFile = { date, partner, raw_key: rawKey, count: result.rejected.length, rows: result.rejected };
  // Two objects cannot be written atomically. Both carry raw_key, so stage 4 can check
  // that rows.json and rejected.json come from the same raw file.
  await store.putText(rejectedKey, JSON.stringify(rejected, null, 2) + "\n");
  await store.putText(cleanKey, JSON.stringify(clean, null, 2) + "\n");

  return { partner, status: "ok", rawKey, cleanKey, rejectedKey, result };
}

/** Counts per reject reason, sorted by reason name. */
export function countByReason(rows: RejectedRow[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  return [...counts].sort(([x], [y]) => x.localeCompare(y));
}
