/**
 * Strict calendar-date helpers. All dates are plain calendar days (no time, no timezone math).
 *
 * "Strict" means the day must exist: 2026-02-30 and 2026-13-45 are rejected,
 * while Date.parse would roll them over or accept them silently.
 */

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** True for a YYYY-MM-DD string naming a day that exists on the calendar. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m !== null && isRealDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * Converts DD/MM/YYYY (partner B's format) to YYYY-MM-DD.
 * Returns null for anything that is not a real day in that exact format.
 */
export function ddMmYyyyToIso(value: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  return isIsoDate(iso) ? iso : null;
}

/**
 * The day before `now` in YYYY-MM-DD, as a calendar day in `timeZone`
 * (partners report the previous day).
 *
 * The reporting timezone comes from REPORT_TZ (an IANA name) and defaults to
 * Asia/Jerusalem, the publisher's day. It only changes which day a run defaults to
 * when no date is given.
 */
export function yesterday(now: Date = new Date(), timeZone: string = process.env.REPORT_TZ || "Asia/Jerusalem"): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const d = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
