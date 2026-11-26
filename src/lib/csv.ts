/**
 * Minimal RFC 4180 CSV parser: quoted fields, "" escapes, commas and newlines
 * inside quotes, LF or CRLF line ends. Enough for partner files; no dependency.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Drop blank lines (a single empty field).
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/** Parses a CSV with a header line into one object per data line, keyed by header name. */
export function parseCsvRecords(text: string): { header: string[]; records: Record<string, string>[] } {
  const [header = [], ...lines] = parseCsv(text.replace(/^﻿/, "")); // tolerate a UTF-8 BOM
  const names = header.map((h) => h.trim());
  const records = lines.map((cells) => Object.fromEntries(names.map((n, i) => [n, cells[i] ?? ""])));
  return { header: names, records };
}
