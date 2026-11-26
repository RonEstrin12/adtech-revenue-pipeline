/**
 * Stage 2: ingest every partner's report for one day into the S3 raw zone.
 *
 *   npm run ingest -- 2026-11-24     (defaults to yesterday)
 *
 * One partner failing does not stop the others. The run still exits non-zero,
 * so the scheduler (and later, the alerts) notice.
 */
import { isIsoDate, yesterday } from "../lib/dates.js";
import { BUCKET, type RawPutResult } from "../lib/s3.js";
import { ingestPartnerA } from "./partner-a.js";
import { ingestPartnerB } from "./partner-b.js";

const partners: Record<string, (d: string) => Promise<RawPutResult>> = {
  A: ingestPartnerA,
  B: ingestPartnerB,
};

const date = process.argv[2] ?? yesterday();
if (!isIsoDate(date)) {
  console.error("Usage: npm run ingest -- YYYY-MM-DD (a real calendar date)");
  process.exitCode = 1;
} else {
  console.log(`Ingesting reports for ${date}`);
  let failures = 0;

  for (const [name, ingest] of Object.entries(partners)) {
    try {
      const r = await ingest(date);
      const note = r.status === "unchanged" ? "unchanged, kept existing copy" : `${r.bytes} bytes`;
      console.log(`  ✅ partner ${name}: s3://${BUCKET}/${r.key} (${note})`);
    } catch (err) {
      failures++;
      console.error(`  ❌ partner ${name}: ${(err as Error).message}`);
    }
  }

  process.exitCode = failures ? 1 : 0;
}
