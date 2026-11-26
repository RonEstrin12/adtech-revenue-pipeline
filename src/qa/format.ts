/** Stage 6: terminal summary of a QA run. Pure, so tests can check it without a database. */
import { table } from "../report/format.js";
import { type QaResult, worstStatus } from "./checks.js";

export function formatQaSummary(date: string, results: QaResult[]): string {
  const title = `QA checks for ${date}`;
  const n = (s: string) => results.filter((r) => r.status === s).length;
  return [
    title,
    "=".repeat(title.length),
    ...table(
      ["status", "check", "partner", "message"],
      results.map((r) => [r.status === "pass" ? "pass" : r.status.toUpperCase(), r.check, r.partner ?? "-", r.message]),
      4,
    ),
    "",
    `Result: ${worstStatus(results).toUpperCase()} (${n("fail")} fail, ${n("warn")} warn, ${n("pass")} pass)`,
  ].join("\n");
}
