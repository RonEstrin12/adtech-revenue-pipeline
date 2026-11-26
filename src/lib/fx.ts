/**
 * Currency conversion to USD.
 *
 * DECISION TO CONFIRM: the ILS→USD rate source. For now it is one fixed rate from
 * FX_ILS_PER_USD (shekels per dollar, the way the rate is usually quoted in Israel).
 * Everything that converts money goes through loadFxRates(date), so a daily rate
 * source (Bank of Israel representative rate, a partner-supplied rate, ...) can
 * replace fixedRatesFromEnv() without touching the validators.
 */

export interface FxRates {
  /** Human-readable origin of the rates, stored next to the clean rows for lineage. */
  readonly source: string;
  /** USD value of one unit of `currency`, or null if the currency is not supported. */
  usdPer(currency: string): number | null;
}

/** Default when FX_ILS_PER_USD is unset: the rate the partner B mock uses. */
export const DEFAULT_ILS_PER_USD = 3.7;

export function fixedRates(ilsPerUsd: number, source = `fixed ILS/USD ${ilsPerUsd}`): FxRates {
  if (!(Number.isFinite(ilsPerUsd) && ilsPerUsd > 0)) throw new Error(`invalid ILS per USD rate: ${ilsPerUsd}`);
  const table: Record<string, number> = { USD: 1, ILS: 1 / ilsPerUsd };
  return { source, usdPer: (c) => table[c] ?? null };
}

export function fixedRatesFromEnv(env: NodeJS.ProcessEnv = process.env): FxRates {
  const raw = env.FX_ILS_PER_USD?.trim();
  if (!raw) return fixedRates(DEFAULT_ILS_PER_USD, `fixed ILS/USD ${DEFAULT_ILS_PER_USD} (default, FX_ILS_PER_USD unset)`);
  const rate = Number(raw);
  if (!(Number.isFinite(rate) && rate > 0)) throw new Error(`FX_ILS_PER_USD must be a positive number, got "${raw}"`);
  return fixedRates(rate, `fixed ILS/USD ${rate} (FX_ILS_PER_USD)`);
}

/** Rates to use for one report day. Async so a daily rate lookup can drop in here. */
export async function loadFxRates(_date: string): Promise<FxRates> {
  return fixedRatesFromEnv();
}
