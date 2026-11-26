# AdTech Revenue Pipeline

A daily data pipeline for a digital publisher that sells ad inventory through several programmatic partners.
Every partner reports yesterday's revenue in its own format. The pipeline collects those reports,
keeps the raw files, cleans and validates them, loads them into Postgres, runs QA checks with alerts,
and pushes a daily summary to Google Sheets.

```
 Partner A (REST API) ─┐
                       ├─► S3 raw ─► validate & clean ─► Postgres ─┬─► SQL analysis
 Partner B (CSV file) ─┘                │                          ├─► QA checks ─► alerts
                                        ▼                          └─► Google Sheets
                                  rejected_rows
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full architecture and the work order.

## Status

| Stage | What | Status |
|---|---|---|
| 1 | Mock partners with realistic dirty data | ✅ |
| 2 | Ingest raw files to S3 | ✅ |
| – | Harden ingest: re-run safety, fetch timeout, strict dates, tests | ✅ |
| 3 | Validate and normalize | ✅ |
| 4 | Idempotent load to Postgres | ✅ |
| 5 | SQL analysis | ✅ |
| 6 | QA checks and alerts | ✅ |
| 7 | Google Sheets report | ✅ |
| 8 | Daily schedule with GitHub Actions | ✅ |

## Quick start

Requires Node 22+ and Docker.

```bash
npm install
cp .env.example .env
docker compose up -d      # Postgres + local S3 (S3Mock)
```

**Partner A**, a REST API:

```bash
npm run partner-a
curl -H "x-api-key: dev-partner-a-key" "http://localhost:4001/api/v1/reports?date=2026-11-24"
```

**Partner B**, a daily CSV file drop:

```bash
npm run partner-b -- 2026-11-24   # writes inbox/partner-b/report_2026-11-24.csv
```

## Configuration

All settings are environment variables in `.env`, which is git-ignored. `.env.example` lists every variable with a working local-dev value.

| Variable | Used by | Default (local dev) | What it does |
|---|---|---|---|
| `PARTNER_A_PORT` | mock partner A, ingest | `4001` | Port the Partner A mock API listens on; ingest's default URL uses it |
| `PARTNER_A_URL` | ingest | `http://localhost:4001` | Base URL of Partner A. Set it for a real partner |
| `PARTNER_A_API_KEY` | mock partner A, ingest | `dev-partner-a-key` | Value of the `x-api-key` header |
| `PARTNER_A_TIMEOUT_MS` | ingest | `30000` | Time limit per fetch attempt; up to 3 attempts |
| `S3_ENDPOINT` | ingest, validate, load, raw:ls | `http://localhost:9090` | S3Mock locally. Leave unset in production to use AWS S3 |
| `S3_REGION` | ingest, validate, load, raw:ls | `us-east-1` | S3 region |
| `S3_BUCKET` | ingest, validate, load, raw:ls | `raw` | Bucket for the raw zone and the `clean/` prefix |
| `AWS_ACCESS_KEY_ID` | ingest, validate, load, raw:ls | `dev` | S3 credentials (dummy for S3Mock) |
| `AWS_SECRET_ACCESS_KEY` | ingest, validate, load, raw:ls | `dev` | S3 credentials (dummy for S3Mock) |
| `FX_ILS_PER_USD` | validate | `3.7` | ⚠️ to confirm. Fixed ILS→USD rate in shekels per dollar (USD = ILS / rate) |
| `REPORT_TZ` | ingest, validate, load, report, qa, sheets, mock partner B | `Asia/Jerusalem` | IANA timezone that decides "yesterday" when no date is given |
| `DATABASE_URL` | migrate, load, report, qa, sheets | `postgres://pipeline:pipeline@localhost:5432/adtech` | Postgres connection. The standard `PG*` variables work instead |
| `QA_EXPECTED_PARTNERS` | qa | `a,b` | Comma-separated partners that must have rows every day |
| `QA_WARN_REJECT_SHARE` | qa | `0.25` | Warn when a partner's rejected share of rows received is above this fraction |
| `QA_MAX_REJECT_SHARE` | qa | `0.4` | Fail when a partner's rejected share is above this fraction |
| `QA_WARN_DOD_CHANGE_PCT` | qa | `25` | Warn when a partner's revenue moves more than this many percent vs the previous day, either way |
| `QA_MAX_DOD_CHANGE_PCT` | qa | `50` | Fail when a partner's revenue moves more than this many percent vs the previous day |
| `QA_ALERTS` | qa | unset (dry run) | `github` sends alerts as GitHub Issues; anything else only prints the issue it would send |
| `GITHUB_TOKEN` | qa | unset | Token with `issues: write`, used only when `QA_ALERTS=github`. Provided by GitHub Actions |
| `GITHUB_REPOSITORY` | qa | unset | `owner/repo` for alert issues, used only when `QA_ALERTS=github`. Provided by GitHub Actions |
| `SHEETS_MODE` | sheets | unset (dry run) | `google` writes the Google Sheet; unset (or `dry-run`) writes the tabs to local CSV files instead; anything else is an error |
| `SHEETS_OUT_DIR` | sheets | `out/sheets` | Folder for the dry-run CSV files (git-ignored) |
| `SHEETS_SPREADSHEET_ID` | sheets | unset | The ID in the sheet's URL (a pasted URL works too). Required when `SHEETS_MODE=google` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | sheets | unset | Service account key: a path to the key file, or the key JSON itself (for a GitHub Actions secret). Required when `SHEETS_MODE=google` |

## The mock partners

Both partners sell the same three sites (`news.co.il`, `sports.co.il`, `recipes.co.il`) across three ad units
(`top_banner`, `sidebar`, `video_mid`). Data is seeded by date, so the same day always returns the same report.
That makes re-runs reproducible, which matters for testing idempotent loads.

| | Partner A | Partner B |
|---|---|---|
| Delivery | REST API, `x-api-key` auth | CSV file in an inbox folder |
| Fields | `day, site, unit, imps, rev_usd` | `Date, Website, Placement, Impressions, Revenue, Currency` |
| Date format | `YYYY-MM-DD` | `DD/MM/YYYY` |
| Currency | USD | ILS for most sites, USD for one |
| Deliberate problems | whitespace and casing in site names, missing revenue, duplicate row | negative impressions, currency symbol inside a number, impossible date, duplicate row |

## Stage 2: ingest to the S3 raw zone

```bash
npm run partner-a                 # in one terminal
npm run partner-b -- 2026-11-24   # partner B drops its file
npm run ingest -- 2026-11-24      # store both reports in S3
npm run raw:ls                    # see what is in the raw zone
```

Raw files are stored exactly as received, partitioned by partner and date:

```
s3://raw/partner=a/date=2026-11-24/fetched_at=2026-11-25T12-41-09-513Z.json
s3://raw/partner=b/date=2026-11-24/fetched_at=2026-11-25T12-41-06-026Z.csv
```

Design decisions:

- **Keep the original, untouched.** If a cleaning bug shows up later, we re-run from raw instead of asking the partner to resend, and we can prove what the partner actually sent.
- **Append-only, deduplicated by content.** Every upload stores a sha256 of the file. If the newest file for that partner and day has the same hash, the run skips the upload, so re-running a day is safe and cheap. A corrected report from a partner gets a new `fetched_at` file next to the old one.
- **Retries only where they help.** Partner A is retried on network errors, timeouts and 5xx with exponential backoff, but not on 4xx (a wrong key or bad date will not fix itself).
- **One partner failing does not block the others.** The run still exits non-zero, so the scheduler and alerts notice.
- **Processed files leave the inbox.** After upload, partner B's file moves to `inbox/partner-b/processed/`, so the inbox only shows what still needs handling. Re-running that day reads the copy in `processed/` and reports it as unchanged.
- **Same code locally and in production.** Locally `S3_ENDPOINT` points at S3Mock; in production it is unset and the AWS SDK talks to real S3.

### Hardening the ingest

```bash
npm test          # unit tests (node --test + tsx), no Docker needed
npm run typecheck
```

Design decisions:

- **Re-runs never fail on a processed file.** If partner B's file is no longer in the inbox but is in `processed/`, ingest re-sends it through the same sha256 dedup, so it comes back `unchanged` (or is restored if the raw zone lost it). A new file in the inbox always wins, so a corrected report is stored as a new version.
- **Every partner call has a deadline.** Each partner A attempt times out after `PARTNER_A_TIMEOUT_MS` (default 30s), covering both the response and the body. A timeout counts as retryable, so a hung partner costs at most about 3 × timeout instead of blocking the run forever.
- **Strict dates.** `src/lib/dates.ts` only accepts days that exist on the calendar, so `2026-02-30` and partner B's `2026-13-45` are rejected instead of rolling over. It also holds `ddMmYyyyToIso` for partner B's `DD/MM/YYYY`, ready for stage 3.
- **The mock partners are the test fixtures.** Tests run against the seeded partner B CSV and a local HTTP server that hangs, fails or rejects on cue. S3 is replaced with an in-memory store that follows the same dedup rule.

## Stage 3: validate and normalize

```bash
npm run ingest -- 2026-11-25      # raw files must be in S3 first
npm run validate -- 2026-11-25    # defaults to yesterday
```

Each partner's latest raw file for the day is mapped to one canonical row
(`date, partner, site, ad_unit, impressions, revenue_usd, raw_key`; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).
The output goes to a `clean/` zone in the same bucket, partitioned like raw:

```
s3://raw/clean/partner=b/date=2026-11-25/rows.json       clean rows, ready for stage 4
s3://raw/clean/partner=b/date=2026-11-25/rejected.json   rejected rows: original row + reason + raw_key
```

The run prints clean and rejected counts per partner and per reason, and exits non-zero if a partner's raw file is missing or unreadable.

| Problem | Partner | Handling | Reason code |
|---|---|---|---|
| `"  News.co.il "` | A | trimmed and lowercased | – |
| `rev_usd: null` | A | rejected | `missing_revenue` |
| Duplicate row | A, B | first kept, repeat rejected | `duplicate` (`duplicate_conflict` if the numbers differ) |
| Negative impressions | B | rejected | `negative_impressions` |
| `₪699.45` | B | symbol stripped; must match the `Currency` column | `currency_mismatch` if not |
| `2026-13-45` | B | rejected (strict `DD/MM/YYYY`) | `invalid_date` |
| Revenue in ILS | B | converted to USD | `unknown_currency` for anything but ILS/USD |

Other checks: a row dated another day (`date_mismatch`), a blank site (`missing_site`), an ad unit outside
`top_banner`/`sidebar`/`video_mid` (`unknown_ad_unit`), and non-numeric or negative numbers.

Design decisions:

- **Clean is derived, so it is overwritten.** The clean files have fixed keys per partner and day. Re-running a day replaces them, so it never duplicates rows. Raw stays append-only and untouched.
- **Latest raw file wins.** When a partner sends a corrected report, the next run validates the newest `fetched_at` file. Both output files record the `raw_key` they came from.
- **Reject the row, not the file.** One bad row goes to `rejected.json` with its reason, and the rest of the day still loads. A file that cannot be parsed at all (bad JSON, missing CSV columns) fails that partner loudly instead.
- **Dedupe on the load key.** Rows are deduplicated on `(date, site, ad_unit)` after normalization, the same key stage 4 upserts on, so `News.co.il` and `news.co.il` collapse into one row.
- **Lineage.** Every clean row carries `raw_key`, and every rejected row keeps the record exactly as the partner sent it.

Decisions still open (defaults are easy to change):

- **ILS→USD rate.** A fixed rate from `FX_ILS_PER_USD` (shekels per dollar, default `3.7`). All conversion goes through `loadFxRates(date)` in `src/lib/fx.ts`, so a daily rate source can replace it in one place. The rate used is printed and saved as `fx_source` in `rows.json`.
- **Reporting timezone.** `REPORT_TZ` (IANA name, default `Asia/Jerusalem`) decides which day "yesterday" is when no date is given. The publisher is Israeli, so the day follows Israel time.

## Stage 4: idempotent load to Postgres

```bash
npm run validate -- 2026-11-25    # clean zone must be written first
npm run migrate                   # create or update the tables (safe to re-run)
npm run load -- 2026-11-25        # defaults to yesterday
```

Needs `DATABASE_URL` in `.env` (see `.env.example`; the standard `PG*` variables also work).
The run prints rows loaded and rejected per partner, and the total `revenue_usd` stored for the day:

```
  ✅ partner A: 8 rows loaded, 2 rejected, revenue_usd 1444.600000
  ✅ partner B: 7 rows loaded, 3 rejected, revenue_usd 763.720271
Total: 15 rows loaded, 5 rejected
Total revenue_usd in revenue_daily for 2026-11-25: 2208.320271
```

| Table | Key | Contents |
|---|---|---|
| `revenue_daily` | `(partner, date, site, ad_unit)` | `impressions`, `revenue_usd NUMERIC(18,6)`, `raw_key`, `fx_source`, `loaded_at` |
| `rejected_rows` | `id`, indexed on `(partner, date)` | `reason`, `detail`, `raw_key`, `line`, `original_row JSONB`, `loaded_at` |
| `schema_migrations` | `version` | which files in `db/migrations/` have run |

Design decisions:

- **Replace the partner-day, in one transaction.** Each partner-day is loaded as: lock, delete that partner-day from both tables, insert. A re-run gives identical counts and sums, and a corrected file that has fewer rows does not leave stale rows behind, which a plain upsert would. If any statement fails, the transaction rolls back and the previous load stays as it was.
- **Refuse inconsistent input.** `rows.json` and `rejected.json` are written separately by stage 3, so both must carry the same `raw_key`, and every row must belong to that partner, day and raw file. Otherwise the partner-day is not loaded and the run exits non-zero; re-running `validate` fixes it.
- **Exact money.** `revenue_usd` is `NUMERIC` and is sent as a decimal string, so sums never pick up float noise. Postgres also checks that impressions and revenue are not negative.
- **Plain SQL migrations, no ORM.** `db/migrations/*.sql` run in name order, each in its own transaction, and are recorded in `schema_migrations`.
- **Tests without and with Docker.** The SQL and the transaction order are unit-tested against a fake client. `src/load/integration.test.ts` loads the seeded days into a throwaway schema of the local Postgres, and skips itself when the database is unreachable.

## Stage 5: SQL analysis

```bash
npm run migrate                   # applies 002_analysis_views.sql (safe to re-run)
npm run report -- 2026-11-25      # defaults to yesterday, in REPORT_TZ
```

`db/migrations/002_analysis_views.sql` adds views on top of `revenue_daily` and `rejected_rows`:

| View | One row per | Columns |
|---|---|---|
| `v_daily_totals` | date | `revenue_usd, impressions, ecpm_usd, partner_count, row_count` |
| `v_daily_by_partner` | date, partner | `revenue_usd, impressions, ecpm_usd, row_count` |
| `v_daily_by_site` | date, site | `revenue_usd, impressions, ecpm_usd, partner_count` |
| `v_daily_by_ad_unit` | date, ad unit | `revenue_usd, impressions, ecpm_usd, partner_count` |
| `v_partner_day_over_day` | date, partner | `revenue_usd, prev_date, prev_revenue_usd, revenue_change_usd, revenue_change_pct` |
| `v_reject_summary` | date, partner, reason | `rejected, partner_rejected, loaded, reason_share, reject_share` |

The report prints totals, then revenue, impressions and eCPM by partner, site and ad unit, then day-over-day
and rejects. It exits non-zero when nothing is loaded for the date. From the real data:

```
Day over day (revenue vs the previous day)
  partner    revenue   previous    change  change %
  a        $1,444.60  $1,311.45  +$133.15   +10.15%
  b          $763.72    $829.92   -$66.20    -7.98%
```

Design decisions:

- **Views, not tables.** The numbers are always computed from the current `revenue_daily`, so a re-load of a day is reflected at once and there is nothing to refresh. `CREATE OR REPLACE` keeps the file re-runnable.
- **eCPM never divides by zero.** `analysis_ecpm()` is `revenue * 1000 / NULLIF(impressions, 0)`, so eCPM is `NULL` (printed `n/a`) when impressions are 0. It is computed from the summed revenue and impressions, not by averaging row eCPMs.
- **Exact until display.** Money, eCPM and shares stay `NUMERIC` (eCPM and shares rounded to 6 decimals) and reach TypeScript as decimal strings; only the printer rounds to cents.
- **Day over day means the previous calendar day.** `LAG` finds the partner's previous loaded day, but it only counts when it is exactly `date - 1`; after a gap, or on the first day, the change is `n/a`. The percentage is also `n/a` when the previous revenue was 0. A partner with no rows today has no row at all; that is a stage 6 QA check.
- **Reject share of rows received.** `reject_share = rejected / (rejected + loaded)` for the partner-day, and `reason_share` is the same per reason. Shares are fractions (`0.2` = 20%).
- **Data and printing are separate.** `src/report/query.ts` returns a typed `DailyReport`; `src/report/format.ts` turns it into text. Stage 7 reuses the query for Google Sheets.
- **Tests.** The formatter is unit-tested with injected rows. `src/report/integration.test.ts` inserts hand-written rows into a throwaway schema and checks every view against hand-computed values, including 0 impressions, a gap in the days, and a previous revenue of 0. It skips itself without Docker.

## Stage 6: QA checks and alerts

```bash
npm run migrate                   # applies 003_qa.sql (qa_results)
npm run qa -- 2026-11-25          # defaults to yesterday, in REPORT_TZ
```

The checks read the stage 5 views through `fetchDailyReport` and each returns pass, warn or fail with a message:

| Check | Per | Fails when | Warns when |
|---|---|---|---|
| `missing_partner_day` | expected partner | a partner in `QA_EXPECTED_PARTNERS` has no rows in `revenue_daily` (the message says if all its rows were rejected) | – |
| `reject_share` | partner | rejected share of rows received > `QA_MAX_REJECT_SHARE` (0.4) | > `QA_WARN_REJECT_SHARE` (0.25) |
| `day_over_day` | partner | revenue change vs the previous day beyond ±`QA_MAX_DOD_CHANGE_PCT` (50%) | beyond ±`QA_WARN_DOD_CHANGE_PCT` (25%), or revenue after a $0 day |
| `zero_totals` | day and partner | nothing loaded, or revenue or impressions are 0 | – |

A value equal to a limit is still inside it. Results go to `qa_results` (`date, check, partner, status, message, details jsonb, checked_at`),
the run prints a summary, and it exits non-zero if any check fails. On the seeded days every check passes except
partner B's 30% reject share, which warns, so the run exits 0:

```
  WARN    reject_share         b        partner b rejected 3 of 10 rows (30.0%) (warn above 25.0%)
  pass    day_over_day         a        partner a: revenue +10.15% vs 2026-11-24 ($1,311.45 -> $1,444.60)
Result: WARN (0 fail, 1 warn, 8 pass)
```

**Alerts are GitHub Issues** (the channel the user chose), sent with `fetch` to the REST API, so no new dependency:

- One issue per date, titled `QA alert: 2026-11-25` with the label `qa-alert`. The body lists the fails, then the warnings.
- If an open issue with that title exists, the run comments on it instead of opening another.
- When a later run for that date has no fail, it comments on the open issue and closes it.
- Warnings alone never alert.
- **Nothing is sent unless `QA_ALERTS=github`**, with `GITHUB_TOKEN` and `GITHUB_REPOSITORY` set (GitHub Actions provides both). Otherwise the run prints the issue it would send. Try a failing day safely with a tight threshold: `QA_MAX_DOD_CHANGE_PCT=8 npm run qa -- 2026-11-25`.

Design decisions:

- **Checks are pure functions.** `src/qa/checks.ts` takes a `DailyReport` and a config and returns results, so every rule and boundary is unit-tested without a database. The query is the stage 5 one, unchanged.
- **Thresholds chosen for the seeded data.** The mock partners reject 20% and 30% of rows by design, so a fail level below 30% would fail every day and train people to ignore it. 25% warns about partner B, and 40% fails only when a file is clearly broken. Seeded revenue moves between -20% and +10% a day, so 25% / 50% separate normal movement from a lost site or a currency mistake.
- **Re-runs replace the date.** One transaction deletes the date's `qa_results` rows and inserts the new ones; a unique index on `(date, check, partner)` backs this up.
- **The first day is not a swing.** With no previous day (or after a gap) `day_over_day` passes and says so; a missing partner is caught by `missing_partner_day` instead.
- **Exit code first, then alert.** Results are stored before alerting, and a failed alert also exits non-zero, so the scheduler notices either way.
- **Tests.** Each check, with boundaries; the issue logic (create, comment on an open issue, close on pass, no alert on warnings, dry run) against a fake `fetch`; and `src/qa/integration.test.ts` for `qa_results` idempotency in a throwaway schema, skipped without Docker.

## Stage 7: Google Sheets report

```bash
npm run sheets -- 2026-11-25      # defaults to yesterday, in REPORT_TZ
```

The run reads the day through `fetchDailyReport` (stage 5) and the worst status in `qa_results` (stage 6), and
replaces that date's rows in four tabs. Each tab has a header row, then one row per date (and partner, site or
ad unit), sorted by date, so the sheet is a growing table you can filter, chart or pivot:

| Tab | One row per | Columns |
|---|---|---|
| `Daily` | date | `date, revenue_usd, impressions, ecpm_usd, partners, rows, rejected, qa_status` |
| `By partner` | date, partner | `date, partner, revenue_usd, impressions, ecpm_usd, dod_change_pct, rejected, reject_pct` |
| `By site` | date, site | `date, site, revenue_usd, impressions, ecpm_usd` |
| `By ad unit` | date, ad unit | `date, ad_unit, revenue_usd, impressions, ecpm_usd` |

`qa_status` is the worst QA result for the date (`fail`, `warn`, `pass`), or `not run`. `rows` and `rejected` count
rows loaded and rejected. `dod_change_pct` and `reject_pct` are in percent (`10.15` = +10.15%, `30` = 30% of rows received).
An empty cell means there is no value: eCPM with 0 impressions, or no previous day to compare with.
The run exits non-zero on bad config, an API error, or when nothing is loaded for the date (and then changes nothing).

**It is a dry run unless `SHEETS_MODE=google`.** The dry run writes the same tabs, merged the same way, to
`out/sheets/daily.csv`, `by-partner.csv`, `by-site.csv` and `by-ad-unit.csv`, and prints a summary. Running
2026-11-23, 24 and 25, then 25 again, leaves the files byte-for-byte unchanged by the re-run:

```
Sheets 2026-11-25 -> .../out/sheets (dry run; set SHEETS_MODE=google with SHEETS_SPREADSHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON to write the sheet)
  Daily         1 row(s) for 2026-11-25 (replaced 1), 3 data row(s) in the tab
  By partner    2 row(s) for 2026-11-25 (replaced 2), 6 data row(s) in the tab
  By site       3 row(s) for 2026-11-25 (replaced 3), 9 data row(s) in the tab
  By ad unit    3 row(s) for 2026-11-25 (replaced 3), 9 data row(s) in the tab
QA status for 2026-11-25: warn
```

### Connecting a real Google Sheet later

1. In the [Google Cloud console](https://console.cloud.google.com/), create (or pick) a project and enable the **Google Sheets API** (APIs & Services → Library).
2. Create a **service account** (IAM & Admin → Service accounts). It needs no project roles. Under Keys, add a JSON key and download it. Keep it out of git: `secrets/` is git-ignored.
3. Create the spreadsheet and **share it with the service account's `client_email`** (in the key file) as **Editor**. The tabs are created on the first run. An existing tab with one of these names must be empty or have the same header, or the run stops without writing anything.
4. Set `SHEETS_SPREADSHEET_ID` (from the sheet URL `docs.google.com/spreadsheets/d/<ID>/edit`) and `GOOGLE_SERVICE_ACCOUNT_JSON` (the key file path locally; in GitHub Actions, a secret holding the key JSON itself), then `SHEETS_MODE=google`.
5. Run `npm run sheets -- <date>`. A 403 means the sheet is not shared with the service account or the API is not enabled; the error says which account to share with.

Design decisions:

- **Read, replace the date, write back.** Each run reads every tab, drops that date's rows, adds the new ones, sorts by date and writes the whole tab back. A tab grows by a handful of rows a day, so rewriting it is cheap, and the result is the same however often or in whatever order dates are published. Appending would duplicate on a re-run, and editing ranges in place would break when a day has a different number of partners or sites than before. The merge (`src/sheets/merge.ts`) is shared by the sheet and the dry-run CSVs.
- **One write, nothing stale.** All tabs are written in one `values:batchUpdate` request. The write is padded with empty strings to cover the cells the tab had before, so a date that now has fewer rows leaves nothing behind, without a clear-then-write step that could lose the other dates if it failed half-way.
- **Never scramble someone else's tab.** All tabs are read before anything is written. If a tab's header is not the expected one, the run stops and writes nothing.
- **Numbers are numbers.** Values are sent with `valueInputOption=RAW`: money, counts, eCPM and percentages are JSON numbers, and the date stays the text `2026-11-25` (Sheets would otherwise turn it into a date serial, and the merge keys on it). Apply number formats in the sheet as you like; the run does not touch formatting.
- **No new dependency.** The Google client is about 200 lines (`src/sheets/google-auth.ts`, `google-sheets.ts`): a service-account JWT signed RS256 with `node:crypto`, exchanged at `oauth2.googleapis.com/token` for a token with the `spreadsheets` scope, then the Sheets REST API v4 with `fetch`. `googleapis` would add a large dependency tree for four HTTP calls.
- **Config is checked before any work,** and `SHEETS_MODE` other than empty, `dry-run` or `google` is an error, so a typo never silently skips the sheet.
- **Last writer wins.** Two runs at the same moment could overwrite each other's date. The stage 8 schedule runs once a day, so there is no lock.
- **Tests.** Row building, the merge (replace a date, insert in order, other dates untouched, foreign header), config validation, the JWT (verified against a throwaway RSA key generated in the test) and token exchange, and the Sheets calls against an in-memory fake of the API, including re-runs, a date with fewer rows, and 403 errors. No test calls Google.

## Stage 8: daily schedule with GitHub Actions

Two workflows:

| Workflow | Runs | What it does |
|---|---|---|
| `.github/workflows/ci.yml` | every PR and every push to `master` | `npm run typecheck` and `npm test`, with Postgres as a service so the integration suites run |
| `.github/workflows/daily.yml` | daily at 05:00 UTC, or manually (Actions → Daily pipeline → Run workflow, optional date) | the whole chain for one date: mock partners → ingest → validate → migrate + load → report → qa → sheets |

The report is added to the run summary. If QA fails, the run fails and a `QA alert: <date>` issue is opened.

### Settings

None of these are needed for the demo mode.

| Name | Kind | Effect |
|---|---|---|
| `DATABASE_URL` | secret | Use a hosted Postgres instead of the job's service container |
| `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | secrets | Use hosted S3 instead of S3Mock. For AWS, set the regional endpoint, e.g. `https://s3.us-east-1.amazonaws.com` |
| `S3_BUCKET`, `S3_REGION` | variables | Override `raw` and `us-east-1` |
| `QA_ALERTS` | variable | `off` turns the GitHub Issue alerts into a dry run |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | secret | The service-account key JSON. Its presence switches `sheets` to `SHEETS_MODE=google` |
| `SHEETS_SPREADSHEET_ID` | variable | The target spreadsheet |

Set them under Settings → Secrets and variables → Actions.

Design decisions:

- **Demo mode first.** Postgres and S3Mock run as service containers in the job, so the schedule works with no account outside GitHub. The cost is that nothing persists between runs: every run starts from an empty database, so the day-over-day check has no previous day to compare with. Setting the hosted secrets switches to persistent storage with no code change, because the code only reads `DATABASE_URL` and the `S3_*` variables.
- **Mock partners in the schedule.** The partners are still the mocks, so the run starts the Partner A mock API and has Partner B drop its file. Replacing them with real integrations only changes those two steps.
- **One step per stage.** The Actions UI shows which stage failed, and each step uses the same `npm run` command as locally. `.env` is copied from `.env.example` and the workflow's env overrides it (`--env-file` never overrides variables already set).
- **The sheet still runs after a QA fail.** A failing QA step fails the run (and opens the issue), but `sheets` still runs as long as the load succeeded, so the sheet shows the day with its `fail` status rather than skipping it.
- **Least privilege.** `daily.yml` gets `contents: read` and `issues: write`, and `ci.yml` gets `contents: read`. Runs don't overlap (`concurrency`), so two runs never write the same date at once.
- **Scheduled runs only fire from the default branch.** The workflow starts running daily once it is on `master`.

## Glossary

- **Impressions**: how many times an ad was shown.
- **Revenue**: money earned from those impressions.
- **eCPM**: revenue per 1,000 impressions (`revenue / impressions * 1000`), the main price metric.
- **Display / video**: the ad format. Video sells for a much higher eCPM.
