/**
 * Mock partner A: a REST API that returns a daily report as JSON.
 *
 *   GET /api/v1/reports?date=YYYY-MM-DD
 *   Header: x-api-key: <PARTNER_A_API_KEY>
 *
 * Its own field names (day, site, unit, imps, rev_usd), revenue already in USD,
 * and a few deliberate problems for the pipeline to catch.
 */
import { pathToFileURL } from "node:url";
import express from "express";
import { isIsoDate } from "../lib/dates.js";
import { generateTraffic } from "./generate.js";

const PORT = Number(process.env.PARTNER_A_PORT ?? 4001);
const API_KEY = process.env.PARTNER_A_API_KEY ?? "dev-partner-a-key";

interface PartnerARecord {
  day: string;
  site: string;
  unit: string;
  imps: number | null;
  rev_usd: number | null;
}

export function buildPartnerAReport(date: string): PartnerARecord[] {
  const records: PartnerARecord[] = generateTraffic(date, "partner-a", 0.6).map((r) => ({
    day: r.date,
    site: r.site,
    unit: r.adUnit,
    imps: r.impressions,
    rev_usd: r.revenueUsd,
  }));

  // Dirty data, the way partner APIs really send it:
  records[1].site = "  News.co.il "; // inconsistent casing and whitespace
  records[4].rev_usd = null; // missing revenue
  records.push({ ...records[2] }); // exact duplicate row

  return records;
}

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/v1/reports", (req, res) => {
  if (req.header("x-api-key") !== API_KEY) {
    res.status(401).json({ error: "invalid api key" });
    return;
  }
  const date = req.query.date;
  if (!isIsoDate(date)) {
    res.status(400).json({ error: "query param 'date' must be YYYY-MM-DD" });
    return;
  }
  const data = buildPartnerAReport(date);
  res.json({ partner: "A", date, count: data.length, data });
});

// Listen only when run as a script, so tests can import buildPartnerAReport as a fixture.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  app.listen(PORT, () => {
    console.log(`Partner A API listening on http://localhost:${PORT}`);
    console.log(`Try: curl -H "x-api-key: ${API_KEY}" "http://localhost:${PORT}/api/v1/reports?date=2026-11-24"`);
  });
}
