/**
 * Stage 6: persist QA results in qa_results (db/migrations/003_qa.sql).
 * A run replaces all of the date's results in one transaction, so re-runs are idempotent.
 */
import { type Queryable, withTransaction } from "../lib/db.js";
import type { QaResult, QaStatus } from "./checks.js";

export const QA_SQL = {
  lock: "SELECT pg_advisory_xact_lock(hashtext('qa_results'), hashtext($1))",
  delete: "DELETE FROM qa_results WHERE date = $1",
  insert: `INSERT INTO qa_results (date, "check", partner, status, message, details)
           SELECT $1, x."check", x.partner, x.status, x.message, x.details
           FROM jsonb_to_recordset($2::jsonb) AS x("check" text, partner text, status text, message text, details jsonb)`,
} as const;

/** `client` must be one connection (not a Pool), since the statements share a transaction. */
export async function saveQaResults(client: Queryable, date: string, results: QaResult[]): Promise<number> {
  return withTransaction(client, async () => {
    await client.query(QA_SQL.lock, [date]);
    await client.query(QA_SQL.delete, [date]);
    if (results.length === 0) return 0;
    const res = await client.query(QA_SQL.insert, [date, JSON.stringify(results)]);
    return res.rowCount ?? 0;
  });
}

export const QA_STATUS_SQL = `SELECT CASE WHEN bool_or(status = 'fail') THEN 'fail'
                                         WHEN bool_or(status = 'warn') THEN 'warn'
                                         ELSE 'pass' END AS status
                              FROM qa_results WHERE date = $1 HAVING count(*) > 0`;

/** The worst stored QA status for the date (fail > warn > pass), or null when QA has not run for it. */
export async function fetchWorstQaStatus(db: Queryable, date: string): Promise<QaStatus | null> {
  const { rows } = await db.query(QA_STATUS_SQL, [date]);
  return (rows[0]?.status as QaStatus | undefined) ?? null;
}
