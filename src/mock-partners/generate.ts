/**
 * Fake "ground truth" ad traffic for one day, plus the dirty-data mistakes
 * real partners make. Both mock partners use this, each in its own format.
 *
 * Seeded by date: the same date always produces the same report, which lets
 * us re-run a day and check that the pipeline does not create duplicates.
 */

export const SITES = ["news.co.il", "sports.co.il", "recipes.co.il"] as const;

export const AD_UNITS = [
  { name: "top_banner", format: "display", baseEcpm: 1.5 },
  { name: "sidebar", format: "display", baseEcpm: 0.8 },
  { name: "video_mid", format: "video", baseEcpm: 12.0 },
] as const;

export interface TrafficRow {
  date: string; // YYYY-MM-DD
  site: string;
  adUnit: string;
  format: "display" | "video";
  impressions: number;
  revenueUsd: number;
}

/** Small deterministic PRNG (mulberry32), so a date always gives the same data. */
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * Clean traffic one partner sold on a given day.
 * `share` is the partner's slice of total traffic (partners split the inventory).
 */
export function generateTraffic(date: string, partner: string, share: number): TrafficRow[] {
  const rand = seededRandom(seedFrom(`${partner}:${date}`));
  const rows: TrafficRow[] = [];

  for (const site of SITES) {
    for (const unit of AD_UNITS) {
      const baseImpressions = unit.format === "video" ? 40_000 : 150_000;
      const impressions = Math.round(baseImpressions * share * (0.8 + rand() * 0.4));
      const ecpm = unit.baseEcpm * (0.85 + rand() * 0.3);
      const revenueUsd = Math.round((impressions / 1000) * ecpm * 100) / 100;
      rows.push({ date, site, adUnit: unit.name, format: unit.format, impressions, revenueUsd });
    }
  }
  return rows;
}
