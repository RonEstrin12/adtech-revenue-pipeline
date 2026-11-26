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
| 5 | SQL analysis | ⏳ |
| 6 | QA checks and alerts | ⏳ |
| 7 | Google Sheets report | ⏳ |
| 8 | Daily schedule with GitHub Actions | ⏳ |

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
- **Reporting timezone.** `REPORT_TZ` (IANA name, default `UTC`) decides which day "yesterday" is when no date is given, for both `ingest` and `validate`. For an Israeli publisher, `Asia/Jerusalem` is the likely answer.

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

## Glossary

- **Impressions**: how many times an ad was shown.
- **Revenue**: money earned from those impressions.
- **eCPM**: revenue per 1,000 impressions (`revenue / impressions * 1000`), the main price metric.
- **Display / video**: the ad format. Video sells for a much higher eCPM.
