/**
 * Stage 6: QA checks and alerts for one day.
 *
 *   npm run qa -- 2026-11-25     (defaults to yesterday, in REPORT_TZ)
 *
 * Reads the stage 5 views, runs the checks in checks.ts, replaces the date's rows in qa_results,
 * prints a summary and handles the GitHub Issue alert. Exits non-zero when any check fails
 * (or the alert could not be sent), so the stage 8 scheduler notices.
 *
 * SAFETY: GitHub is called only when QA_ALERTS=github. Otherwise the alert is a dry run that
 * prints what would be sent.
 */
import { isIsoDate, yesterday } from "../lib/dates.js";
import { createPool } from "../lib/db.js";
import { fetchDailyReport } from "../report/query.js";
import { GitHubIssues, dryRunAlert, githubConfigFromEnv, sendAlert } from "./alert.js";
import { runChecks, worstStatus } from "./checks.js";
import { alertMode, loadQaConfig } from "./config.js";
import { formatQaSummary } from "./format.js";
import { saveQaResults } from "./store.js";

function runUrl(env: NodeJS.ProcessEnv): string | undefined {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: id } = env;
  return server && repo && id ? `${server}/${repo}/actions/runs/${id}` : undefined;
}

async function main(date: string): Promise<number> {
  const config = loadQaConfig();
  const mode = alertMode();
  const github = mode === "github" ? new GitHubIssues(githubConfigFromEnv()) : null;

  const pool = createPool();
  let results;
  try {
    results = runChecks(await fetchDailyReport(pool, date), config);
    const client = await pool.connect(); // one connection: the replace runs in a transaction
    try {
      const saved = await saveQaResults(client, date, results);
      console.log(formatQaSummary(date, results));
      console.log(`Stored ${saved} result(s) in qa_results for ${date} (previous results for the date replaced)`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  console.log("");
  let alertFailed = false;
  if (!github) {
    console.log(dryRunAlert(date, results, runUrl(process.env)));
  } else {
    try {
      const out = await sendAlert(github, date, results, runUrl(process.env));
      console.log(
        out.action === "none"
          ? "Alert: no fail and no open issue, nothing sent"
          : `Alert: ${out.action} issue #${out.issue!.number} ${out.issue!.html_url}`,
      );
    } catch (err) {
      console.error(`❌ alert failed: ${(err as Error).message}`);
      alertFailed = true;
    }
  }
  return worstStatus(results) === "fail" || alertFailed ? 1 : 0;
}

const date = process.argv[2] ?? yesterday();
if (!isIsoDate(date)) {
  console.error("Usage: npm run qa -- YYYY-MM-DD (a real calendar date)");
  process.exitCode = 1;
} else {
  try {
    process.exitCode = await main(date);
  } catch (err) {
    console.error(`❌ qa failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
