/**
 * Ingest partner B: pick up its CSV from the inbox folder and store it as-is in S3.
 * After a successful upload the file moves to inbox/partner-b/processed/,
 * so the inbox only ever shows what still needs handling.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { putRaw, type RawPutResult } from "../lib/s3.js";

const INBOX = join("inbox", "partner-b");

export class MissingFileError extends Error {}

export async function ingestPartnerB(date: string): Promise<RawPutResult> {
  const file = join(INBOX, `report_${date}.csv`);
  if (!existsSync(file)) throw new MissingFileError(`no file at ${file}`);

  const body = readFileSync(file, "utf-8");
  const result = await putRaw(`partner=b/date=${date}`, "csv", body, {
    source: "partner-b-file",
    "original-name": `report_${date}.csv`,
  });

  const processed = join(INBOX, "processed");
  mkdirSync(processed, { recursive: true });
  renameSync(file, join(processed, `report_${date}.csv`));
  return result;
}
