/**
 * Stage 6: QA alerts as GitHub Issues (the alert channel the user chose).
 *
 * One issue per date, titled "QA alert: <date>" and labelled qa-alert:
 *   - a run with a fail and no open issue for the date   -> open one
 *   - a run with a fail and an open issue                -> comment on it (no duplicates)
 *   - a run without a fail and an open issue             -> comment and close it
 *   - a run without a fail and no open issue             -> nothing
 * Warnings alone never alert; they are listed in the issue body when there is also a fail.
 *
 * Uses the GitHub REST API with plain fetch (no dependency). The fetch function is injected so
 * tests run against a fake. Real calls happen only when QA_ALERTS=github (see index.ts).
 */
import type { QaResult } from "./checks.js";

export const ALERT_LABEL = "qa-alert";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHubConfig {
  token: string;
  repository: string; // owner/repo
  apiUrl: string;
}

/** GITHUB_TOKEN and GITHUB_REPOSITORY, as GitHub Actions provides them. */
export function githubConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubConfig {
  const token = env.GITHUB_TOKEN?.trim();
  const repository = env.GITHUB_REPOSITORY?.trim();
  if (!token || !repository) throw new Error("QA_ALERTS=github needs GITHUB_TOKEN and GITHUB_REPOSITORY (owner/repo)");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error(`GITHUB_REPOSITORY must be owner/repo, got "${repository}"`);
  return { token, repository, apiUrl: (env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/$/, "") };
}

export interface Issue {
  number: number;
  title: string;
  html_url: string;
}

export class GitHubIssues {
  constructor(
    private readonly config: GitHubConfig,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.config.apiUrl}/repos/${this.config.repository}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.config.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  /** The open qa-alert issue with exactly this title, if any (pull requests excluded). */
  async findOpenIssue(title: string): Promise<Issue | null> {
    for (let page = 1; page <= 10; page++) {
      const issues = await this.call<(Issue & { pull_request?: unknown })[]>(
        "GET",
        `/issues?state=open&labels=${ALERT_LABEL}&per_page=100&page=${page}`,
      );
      const hit = issues.find((i) => !i.pull_request && i.title === title);
      if (hit) return hit;
      if (issues.length < 100) break;
    }
    return null;
  }

  createIssue(title: string, body: string): Promise<Issue> {
    return this.call("POST", "/issues", { title, body, labels: [ALERT_LABEL] });
  }

  async comment(issue: number, body: string): Promise<void> {
    await this.call("POST", `/issues/${issue}/comments`, { body });
  }

  async close(issue: number): Promise<void> {
    await this.call("PATCH", `/issues/${issue}`, { state: "closed", state_reason: "completed" });
  }
}

export const issueTitle = (date: string) => `QA alert: ${date}`;

const ICON = { fail: "❌", warn: "⚠️", pass: "✅" } as const;

function resultLines(results: QaResult[]): string[] {
  return results.map((r) => `- ${ICON[r.status]} **${r.check}**${r.partner ? ` (partner ${r.partner})` : ""}: ${r.message}`);
}

/** Issue body (and comment body for a repeat fail): the fails, then the warnings. */
export function failureBody(date: string, results: QaResult[], runUrl?: string): string {
  const fails = results.filter((r) => r.status === "fail");
  const warns = results.filter((r) => r.status === "warn");
  const passed = results.filter((r) => r.status === "pass").length;
  return [
    `QA checks for **${date}**: ${fails.length} failed, ${warns.length} warning(s), ${passed} passed.`,
    "",
    "### Failed",
    ...resultLines(fails),
    ...(warns.length > 0 ? ["", "### Warnings", ...resultLines(warns)] : []),
    "",
    `Re-run after fixing: \`npm run qa -- ${date}\`. Results are in the \`qa_results\` table.`,
    ...(runUrl ? ["", `Run: ${runUrl}`] : []),
  ].join("\n");
}

export function passBody(date: string, results: QaResult[], runUrl?: string): string {
  const warns = results.filter((r) => r.status === "warn");
  return [
    `QA checks for **${date}** now pass (${results.length} checks, ${warns.length} warning(s)). Closing.`,
    ...(warns.length > 0 ? ["", "### Warnings", ...resultLines(warns)] : []),
    ...(runUrl ? ["", `Run: ${runUrl}`] : []),
  ].join("\n");
}

export type AlertAction = "created" | "commented" | "closed" | "none";

export interface AlertOutcome {
  action: AlertAction;
  issue?: Issue;
}

export async function sendAlert(gh: GitHubIssues, date: string, results: QaResult[], runUrl?: string): Promise<AlertOutcome> {
  const failed = results.some((r) => r.status === "fail");
  const title = issueTitle(date);
  const open = await gh.findOpenIssue(title);
  if (failed) {
    const body = failureBody(date, results, runUrl);
    if (open) {
      await gh.comment(open.number, body);
      return { action: "commented", issue: open };
    }
    return { action: "created", issue: await gh.createIssue(title, body) };
  }
  if (open) {
    await gh.comment(open.number, passBody(date, results, runUrl));
    await gh.close(open.number);
    return { action: "closed", issue: open };
  }
  return { action: "none" };
}

/** What sendAlert would do, without any network call (it cannot know whether an issue is open). */
export function dryRunAlert(date: string, results: QaResult[], runUrl?: string): string {
  const title = issueTitle(date);
  const head = "Alert (dry run; set QA_ALERTS=github with GITHUB_TOKEN and GITHUB_REPOSITORY to send)";
  if (!results.some((r) => r.status === "fail")) {
    return [
      head,
      `  No fail: no issue would be opened. An open issue titled "${title}" would get this comment and be closed:`,
      ...passBody(date, results, runUrl).split("\n").map((l) => `  | ${l}`.trimEnd()),
    ].join("\n");
  }
  return [
    head,
    `  Would open "${title}" [label ${ALERT_LABEL}], or comment on it if it is already open:`,
    ...failureBody(date, results, runUrl).split("\n").map((l) => `  | ${l}`.trimEnd()),
  ].join("\n");
}
