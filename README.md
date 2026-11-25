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

## Status

| Stage | What | Status |
|---|---|---|
| 1 | Mock partners with realistic dirty data | ✅ |
| 2 | Ingest raw files to S3 | ✅ |
| 3 | Validate and normalize | ⏳ |
| 4 | Idempotent load to Postgres | ⏳ |
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
- **Retries only where they help.** Partner A is retried on network errors and 5xx with exponential backoff, but not on 4xx (a wrong key or bad date will not fix itself).
- **One partner failing does not block the others.** The run still exits non-zero, so the scheduler and alerts notice.
- **Processed files leave the inbox.** After upload, partner B's file moves to `inbox/partner-b/processed/`, so the inbox only shows what still needs handling.
- **Same code locally and in production.** Locally `S3_ENDPOINT` points at S3Mock; in production it is unset and the AWS SDK talks to real S3.

## Glossary

- **Impressions**: how many times an ad was shown.
- **Revenue**: money earned from those impressions.
- **eCPM**: revenue per 1,000 impressions (`revenue / impressions * 1000`), the main price metric.
- **Display / video**: the ad format. Video sells for a much higher eCPM.
