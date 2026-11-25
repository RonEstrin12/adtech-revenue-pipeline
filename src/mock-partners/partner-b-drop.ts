/**
 * Mock partner B: drops a daily CSV file into an inbox folder
 * (the way partners upload files to SFTP or a shared bucket).
 *
 *   npm run partner-b -- 2026-11-24
 *   -> inbox/partner-b/report_2026-11-24.csv
 *
 * Different column names, DD/MM/YYYY dates, revenue partly in ILS,
 * and its own set of deliberate problems.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateTraffic, isIsoDate, yesterday } from "./generate.js";

const ILS_PER_USD = 3.7; // the rate partner B used when converting to ILS

function toDdMmYyyy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function buildPartnerBCsv(date: string): string {
  const rows = generateTraffic(date, "partner-b", 0.4).map((r) => {
    // Partner B bills Israeli sites in ILS, except recipes.co.il, which is in USD.
    const currency = r.site === "recipes.co.il" ? "USD" : "ILS";
    const revenue = currency === "ILS" ? r.revenueUsd * ILS_PER_USD : r.revenueUsd;
    return [toDdMmYyyy(r.date), r.site, r.adUnit, String(r.impressions), revenue.toFixed(2), currency];
  });

  // Dirty data:
  rows.push([...rows[0]]); // duplicate row
  rows[3][3] = "-500"; // negative impressions
  rows[5][4] = `₪${rows[5][4]}`; // currency symbol inside a number
  rows[6][0] = "2026-13-45"; // impossible date

  const header = ["Date", "Website", "Placement", "Impressions", "Revenue", "Currency"];
  const quote = (v: string) => (v.includes(",") ? `"${v}"` : v);
  return [header, ...rows].map((r) => r.map(quote).join(",")).join("\n") + "\n";
}

const date = process.argv[2] ?? yesterday();
if (!isIsoDate(date)) {
  console.error("Usage: npm run partner-b -- YYYY-MM-DD");
  process.exit(1);
}

const dir = join("inbox", "partner-b");
mkdirSync(dir, { recursive: true });
const file = join(dir, `report_${date}.csv`);
writeFileSync(file, buildPartnerBCsv(date));
console.log(`Partner B dropped ${file}`);
