/**
 * Stage 3: validate and normalize every partner's raw report for one day.
 *
 *   npm run validate -- 2026-11-25     (defaults to yesterday, in REPORT_TZ)
 *
 * Reads the latest raw file per partner, writes clean and rejected rows to
 * s3://<bucket>/clean/partner=<p>/date=<d>/, and prints counts by reason.
 * A missing partner file or an unreadable file does not stop the other partners,
 * but the run exits non-zero.
 */
import { isIsoDate, yesterday } from "../lib/dates.js";
import { loadFxRates } from "../lib/fx.js";
import { BUCKET, getText, listKeys, putText } from "../lib/s3.js";
import { PARTNERS, countByReason, validatePartnerDay } from "./run.js";

const date = process.argv[2] ?? yesterday();
if (!isIsoDate(date)) {
  console.error("Usage: npm run validate -- YYYY-MM-DD (a real calendar date)");
  process.exitCode = 1;
} else {
  const fx = await loadFxRates(date);
  console.log(`Validating reports for ${date} (FX: ${fx.source})`);
  const store = { listKeys, getText, putText };
  let failures = 0;
  let totalClean = 0;
  const totalRejected = new Map<string, number>();

  for (const partner of Object.keys(PARTNERS)) {
    try {
      const out = await validatePartnerDay(store, partner, date, fx);
      if (out.status === "missing") {
        failures++;
        console.error(`  ❌ partner ${partner.toUpperCase()}: no raw file for ${date} (run npm run ingest first)`);
        continue;
      }
      const { clean, rejected } = out.result;
      totalClean += clean.length;
      console.log(`  ✅ partner ${partner.toUpperCase()}: ${clean.length} clean, ${rejected.length} rejected`);
      console.log(`     from s3://${BUCKET}/${out.rawKey}`);
      for (const [reason, n] of countByReason(rejected)) {
        console.log(`     - ${reason}: ${n}`);
        totalRejected.set(reason, (totalRejected.get(reason) ?? 0) + n);
      }
      console.log(`     -> s3://${BUCKET}/${out.cleanKey}`);
      console.log(`     -> s3://${BUCKET}/${out.rejectedKey}`);
    } catch (err) {
      failures++;
      console.error(`  ❌ partner ${partner.toUpperCase()}: ${(err as Error).message}`);
    }
  }

  const rejectedSum = [...totalRejected.values()].reduce((a, b) => a + b, 0);
  console.log(`Total: ${totalClean} clean, ${rejectedSum} rejected`);
  for (const [reason, n] of [...totalRejected].sort(([x], [y]) => x.localeCompare(y))) {
    console.log(`  ${reason.padEnd(22)} ${n}`);
  }
  process.exitCode = failures ? 1 : 0;
}
