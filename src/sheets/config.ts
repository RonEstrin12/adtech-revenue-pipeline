/**
 * Stage 7: Google Sheets settings from the environment (documented in .env.example).
 *
 * SAFETY: Google is called only when SHEETS_MODE=google. Unset (or "dry-run") writes the tabs to
 * local CSV files instead. Any other value is an error, so a typo never silently skips the sheet.
 */
import { readFileSync } from "node:fs";

export type SheetsMode = "dry-run" | "google";

export function sheetsMode(env: NodeJS.ProcessEnv = process.env): SheetsMode {
  const raw = env.SHEETS_MODE?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "dry-run") return "dry-run";
  if (raw === "google") return "google";
  throw new Error(`SHEETS_MODE must be empty (dry run) or "google", got "${env.SHEETS_MODE}"`);
}

/** Folder for the dry-run CSV files. */
export function sheetsOutDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHEETS_OUT_DIR?.trim() || "out/sheets";
}

export interface ServiceAccount {
  client_email: string;
  private_key: string; // PEM
}

export interface GoogleSheetsConfig {
  spreadsheetId: string;
  serviceAccount: ServiceAccount;
}

/**
 * The spreadsheet ID, or the ID taken from a pasted sheet URL
 * (https://docs.google.com/spreadsheets/d/<id>/edit).
 */
export function parseSpreadsheetId(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) throw new Error("SHEETS_MODE=google needs SHEETS_SPREADSHEET_ID (the long ID in the sheet's URL)");
  const id = /\/spreadsheets\/d\/([^/?#]+)/.exec(raw)?.[1] ?? raw;
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new Error(`SHEETS_SPREADSHEET_ID does not look like a spreadsheet ID: "${raw}"`);
  return id;
}

/**
 * GOOGLE_SERVICE_ACCOUNT_JSON is either the key file's JSON itself (a GitHub Actions secret)
 * or a path to the key file (local use). Error messages never include the key.
 */
export function parseServiceAccount(value: string | undefined, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): ServiceAccount {
  const raw = value?.trim() ?? "";
  if (!raw) throw new Error("SHEETS_MODE=google needs GOOGLE_SERVICE_ACCOUNT_JSON (a key file path, or the key JSON itself)");

  let text = raw;
  let source = "GOOGLE_SERVICE_ACCOUNT_JSON";
  if (!raw.startsWith("{")) {
    source = `service account key file ${raw}`;
    try {
      text = readFile(raw);
    } catch (err) {
      throw new Error(`cannot read ${source}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  const key = parsed as Partial<Record<string, unknown>>;
  if (key.type !== undefined && key.type !== "service_account") throw new Error(`${source} is a "${String(key.type)}" key, not a service account key`);
  if (typeof key.client_email !== "string" || !key.client_email.includes("@")) throw new Error(`${source} has no client_email`);
  if (typeof key.private_key !== "string" || !key.private_key.includes("PRIVATE KEY")) throw new Error(`${source} has no private_key`);
  return { client_email: key.client_email, private_key: key.private_key };
}

export function googleSheetsConfigFromEnv(env: NodeJS.ProcessEnv = process.env, readFile?: (path: string) => string): GoogleSheetsConfig {
  return {
    spreadsheetId: parseSpreadsheetId(env.SHEETS_SPREADSHEET_ID),
    serviceAccount: parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON, readFile),
  };
}
