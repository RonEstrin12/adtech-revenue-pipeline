/**
 * Ingest partner B: pick up its CSV from the inbox folder and store it as-is in S3.
 * After a successful upload the file moves to inbox/partner-b/processed/,
 * so the inbox only ever shows what still needs handling.
 *
 * Re-running a day whose file was already processed is safe: the copy in
 * processed/ goes through the same sha256 dedup, so it comes back "unchanged"
 * (or is stored again if the raw zone somehow lost it).
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { putRaw, type RawPutResult } from "../lib/s3.js";

const DEFAULT_INBOX = join("inbox", "partner-b");

export class MissingFileError extends Error {}

export interface PartnerBOptions {
  inbox?: string;
  put?: typeof putRaw;
}

export async function ingestPartnerB(date: string, opts: PartnerBOptions = {}): Promise<RawPutResult> {
  const { inbox = DEFAULT_INBOX, put = putRaw } = opts;
  const name = `report_${date}.csv`;
  const processedDir = join(inbox, "processed");
  const file = join(inbox, name);
  const processedFile = join(processedDir, name);

  // A new file in the inbox wins: it may be a corrected report.
  const source = existsSync(file) ? file : existsSync(processedFile) ? processedFile : null;
  if (!source) throw new MissingFileError(`no file at ${file} (or in ${processedDir})`);

  const body = readFileSync(source, "utf-8");
  const result = await put(`partner=b/date=${date}`, "csv", body, {
    source: "partner-b-file",
    "original-name": name,
  });

  if (source === file) {
    mkdirSync(processedDir, { recursive: true });
    renameSync(file, processedFile);
  }
  return result;
}
