/**
 * GitHub Issue alerts, tested only against an in-memory fake of the REST API (an injected fetch).
 * No test here talks to GitHub.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALERT_LABEL, type FetchLike, GitHubIssues, dryRunAlert, failureBody, githubConfigFromEnv, issueTitle, sendAlert } from "./alert.js";
import type { QaResult } from "./checks.js";

const D = "2026-11-25";
const CONFIG = { token: "test-token", repository: "acme/pipeline", apiUrl: "https://github.test" };

interface FakeIssue {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  labels: string[];
  body: string;
  comments: string[];
  pull_request?: object;
}

/** A tiny fake of the GitHub Issues API that records every request. */
function fakeGitHub(seed: Partial<FakeIssue>[] = []) {
  const issues: FakeIssue[] = seed.map((s, i) => ({
    number: i + 1,
    title: "",
    html_url: `https://github.test/acme/pipeline/issues/${i + 1}`,
    state: "open",
    labels: [ALERT_LABEL],
    body: "",
    comments: [],
    ...s,
  }));
  const calls: { method: string; url: string; headers: Record<string, string>; body?: any }[] = [];
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  const fetchFn: FetchLike = async (url, init) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, headers: init.headers as Record<string, string>, body });
    const u = new URL(url);
    const path = u.pathname.replace("/repos/acme/pipeline", "");
    if (method === "GET" && path === "/issues") {
      const label = u.searchParams.get("labels");
      return json(issues.filter((i) => i.state === u.searchParams.get("state") && (!label || i.labels.includes(label))));
    }
    if (method === "POST" && path === "/issues") {
      const issue: FakeIssue = {
        number: issues.length + 1,
        title: body.title,
        html_url: `https://github.test/acme/pipeline/issues/${issues.length + 1}`,
        state: "open",
        labels: body.labels,
        body: body.body,
        comments: [],
      };
      issues.push(issue);
      return json(issue, 201);
    }
    const m = /^\/issues\/(\d+)(\/comments)?$/.exec(path);
    const issue = m && issues.find((i) => i.number === Number(m[1]));
    if (!issue) return json({ message: "Not Found" }, 404);
    if (method === "POST" && m![2]) {
      issue.comments.push(body.body);
      return json({ id: 1 }, 201);
    }
    if (method === "PATCH") {
      issue.state = body.state;
      return json(issue);
    }
    return json({ message: "unexpected" }, 500);
  };
  return { fetchFn, issues, calls };
}

const result = (status: QaResult["status"], check: QaResult["check"], partner: string | null, message: string): QaResult => ({
  check,
  partner,
  status,
  message,
  details: {},
});

const FAILING = [
  result("fail", "missing_partner_day", "b", "partner b has no rows for 2026-11-25"),
  result("warn", "reject_share", "a", "partner a rejected 3 of 10 rows (30.0%)"),
  result("pass", "zero_totals", null, "day totals fine"),
];
const PASSING = [result("pass", "missing_partner_day", "b", "partner b reported"), result("warn", "reject_share", "a", "partner a rejected 3 of 10 rows (30.0%)")];

describe("GitHub issue alerts (fake fetch)", () => {
  it("opens one labelled issue with the fails and warnings when there is a fail", async () => {
    const gh = fakeGitHub();
    const out = await sendAlert(new GitHubIssues(CONFIG, gh.fetchFn), D, FAILING);
    assert.equal(out.action, "created");
    assert.equal(gh.issues.length, 1);
    const [issue] = gh.issues;
    assert.equal(issue!.title, "QA alert: 2026-11-25");
    assert.deepEqual(issue!.labels, ["qa-alert"]);
    assert.match(issue!.body, /1 failed, 1 warning\(s\), 1 passed/);
    assert.match(issue!.body, /### Failed\n- ❌ \*\*missing_partner_day\*\* \(partner b\): partner b has no rows/);
    assert.match(issue!.body, /### Warnings\n- ⚠️ \*\*reject_share\*\* \(partner a\)/);
    assert.doesNotMatch(issue!.body, /day totals fine/);
    // Authenticated REST calls to the configured repository.
    assert.deepEqual(gh.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), ["GET /repos/acme/pipeline/issues", "POST /repos/acme/pipeline/issues"]);
    assert.equal(gh.calls[0]!.headers.Authorization, "Bearer test-token");
    assert.equal(gh.calls[0]!.headers.Accept, "application/vnd.github+json");
    assert.match(gh.calls[0]!.url, /state=open&labels=qa-alert/);
  });

  it("comments on the open issue for the date instead of opening a duplicate", async () => {
    const gh = fakeGitHub([
      { title: issueTitle("2026-11-24") }, // another date
      { title: issueTitle(D), pull_request: {} }, // a pull request with the same title does not count
      { title: issueTitle(D) },
    ]);
    const out = await sendAlert(new GitHubIssues(CONFIG, gh.fetchFn), D, FAILING, "https://github.test/acme/pipeline/actions/runs/7");
    assert.equal(out.action, "commented");
    assert.equal(out.issue!.number, 3);
    assert.equal(gh.issues.length, 3);
    assert.equal(gh.issues[2]!.comments.length, 1);
    assert.match(gh.issues[2]!.comments[0]!, /missing_partner_day/);
    assert.match(gh.issues[2]!.comments[0]!, /Run: https:\/\/github\.test\/acme\/pipeline\/actions\/runs\/7/);
    assert.equal(gh.issues[0]!.comments.length, 0);
  });

  it("a closed issue for the date does not block a new one", async () => {
    const gh = fakeGitHub([{ title: issueTitle(D), state: "closed" }]);
    const out = await sendAlert(new GitHubIssues(CONFIG, gh.fetchFn), D, FAILING);
    assert.equal(out.action, "created");
    assert.equal(out.issue!.number, 2);
  });

  it("comments and closes the open issue when a later run passes", async () => {
    const gh = fakeGitHub([{ title: issueTitle(D) }]);
    const out = await sendAlert(new GitHubIssues(CONFIG, gh.fetchFn), D, PASSING);
    assert.equal(out.action, "closed");
    assert.equal(gh.issues[0]!.state, "closed");
    assert.match(gh.issues[0]!.comments[0]!, /now pass \(2 checks, 1 warning\(s\)\)\. Closing\./);
    assert.deepEqual(gh.calls.map((c) => c.method), ["GET", "POST", "PATCH"]);
    assert.deepEqual(gh.calls[2]!.body, { state: "closed", state_reason: "completed" });
  });

  it("does nothing on a pass with no open issue, and never alerts on warnings alone", async () => {
    const gh = fakeGitHub();
    const out = await sendAlert(new GitHubIssues(CONFIG, gh.fetchFn), D, PASSING);
    assert.equal(out.action, "none");
    assert.deepEqual(gh.calls.map((c) => c.method), ["GET"]);
    assert.equal(gh.issues.length, 0);
  });

  it("surfaces API errors", async () => {
    const failing: FetchLike = async () => new Response('{"message":"Bad credentials"}', { status: 401 });
    await assert.rejects(sendAlert(new GitHubIssues(CONFIG, failing), D, FAILING), /GitHub GET \/issues.* failed: 401 .*Bad credentials/);
  });

  it("dry run: describes the issue it would send and makes no call", () => {
    const failText = dryRunAlert(D, FAILING);
    assert.match(failText, /^Alert \(dry run; set QA_ALERTS=github/);
    assert.match(failText, /Would open "QA alert: 2026-11-25" \[label qa-alert\], or comment on it if it is already open:/);
    for (const line of failureBody(D, FAILING).split("\n")) assert.ok(failText.includes(`  | ${line}`.trimEnd()), line);
    const passText = dryRunAlert(D, PASSING);
    assert.match(passText, /No fail: no issue would be opened\. An open issue titled "QA alert: 2026-11-25" would get this comment and be closed:/);
  });

  it("reads GITHUB_TOKEN and GITHUB_REPOSITORY, as GitHub Actions provides them", () => {
    assert.deepEqual(githubConfigFromEnv({ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" }), { token: "t", repository: "o/r", apiUrl: "https://api.github.com" });
    assert.equal(githubConfigFromEnv({ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: "https://ghe.test/api/v3/" }).apiUrl, "https://ghe.test/api/v3");
    assert.throws(() => githubConfigFromEnv({ GITHUB_REPOSITORY: "o/r" }), /needs GITHUB_TOKEN and GITHUB_REPOSITORY/);
    assert.throws(() => githubConfigFromEnv({ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "just-a-repo" }), /owner\/repo/);
  });
});
