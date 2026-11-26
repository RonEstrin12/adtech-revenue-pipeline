# Architecture

The pipeline runs once a day. It collects yesterday's revenue reports from each partner, keeps the raw files,
cleans and validates them, loads them into Postgres, checks the result, and publishes a daily summary.

```mermaid
flowchart LR
    subgraph sched["Stage 8 · GitHub Actions daily cron"]
        direction LR
        A["Partner A<br/>REST API · JSON · USD"]:::done
        B["Partner B<br/>CSV drop · ILS + USD"]:::done
        ING["Ingest<br/>src/ingest/"]:::done
        FIX["Harden ingest<br/>re-run safety · fetch timeout<br/>strict dates · tests"]:::done
        RAW[("S3 raw zone<br/>partner=/date=/")]:::done
        VAL["Stage 3 · Validate & normalize<br/>src/validate/"]:::done
        CLEAN[("S3 clean zone<br/>clean/partner=/date=/<br/>rows.json")]:::done
        REJ[("rejected.json<br/>row + reason + raw_key")]:::done
        PG[("Stage 4 · Postgres<br/>upsert on partner·date·site·unit")]:::next
        SQL["Stage 5 · SQL analysis<br/>daily revenue views"]:::later
        QA["Stage 6 · QA checks"]:::later
        AL["Alerts"]:::later
        GS["Stage 7 · Google Sheets<br/>daily summary"]:::later

        A --> ING
        B --> ING
        FIX -.-> ING
        ING --> RAW --> VAL
        VAL -- clean rows --> CLEAN --> PG
        VAL -- bad rows --> REJ
        PG --> SQL --> GS
        PG --> QA
        REJ --> QA
        QA --> AL
    end

    classDef done fill:#e8f4ed,stroke:#2f8a5b,color:#1b2230
    classDef fix fill:#fdf1df,stroke:#b26a00,color:#1b2230
    classDef next fill:#e8effc,stroke:#2c5fd4,color:#1b2230
    classDef later fill:#eef0f3,stroke:#6b7385,stroke-dasharray:5 4,color:#1b2230
```

Green is built, orange should be fixed before moving on, blue is next, and grey dashed is later.

## Components

| Component | Code | Status | Responsibility |
|---|---|---|---|
| Mock partners | `src/mock-partners/` | ✅ Built | Seeded, reproducible reports with deliberate data problems |
| Ingest | `src/ingest/` | ✅ Built, hardened | Fetch or pick up each partner's report and store it unchanged in S3; safe to re-run, partner A calls time out |
| Date helpers | `src/lib/dates.ts` | ✅ Built | Strict ISO and `DD/MM/YYYY` parsing; impossible days rejected |
| Tests | `src/**/*.test.ts` | ✅ Built | `npm test` (`node --test` + `tsx`), mock partners as fixtures |
| S3 raw zone | `src/lib/s3.ts` | ✅ Built | Append-only store, partitioned by partner and date, deduplicated by sha256 |
| S3 clean zone | `src/lib/s3.ts` | ✅ Built | `clean/partner=/date=/rows.json` and `rejected.json`, fixed keys so re-runs overwrite |
| Validate & normalize | `src/validate/` | ✅ Built | Map both formats to one canonical row from the latest raw file; write clean and rejected rows (with reason) to the S3 `clean/` zone, overwritten per partner-day |
| FX | `src/lib/fx.ts` | ✅ Built (fixed rate) | ILS→USD via `loadFxRates(date)`; fixed `FX_ILS_PER_USD` until a daily source is chosen |
| Postgres load | — | ⏳ Stage 4 | Read the clean zone; idempotent load keyed on partner, date, site and ad unit; load rejected rows for QA |
| SQL analysis | — | ⏳ Stage 5 | Daily revenue and eCPM by site, ad unit and partner |
| QA checks & alerts | — | ⏳ Stage 6 | Missing partner-days, rejected-row share, day-over-day revenue swings |
| Google Sheets | — | ⏳ Stage 7 | Push the daily summary |
| Scheduler | `.github/workflows/` | ⏳ Stage 8 | Run the whole chain every day |

## Canonical row (stage 3 output)

| Column | Type | Notes |
|---|---|---|
| `date` | date | Partner B's `DD/MM/YYYY` converted to ISO; impossible dates rejected |
| `partner` | text | `a`, `b` |
| `site` | text | Trimmed and lowercased |
| `ad_unit` | text | `top_banner`, `sidebar`, `video_mid` |
| `impressions` | integer | Negative or missing values rejected |
| `revenue_usd` | numeric | Currency symbols stripped; ILS converted to USD at `FX_ILS_PER_USD` (fixed for now) |
| `raw_key` | text | S3 key of the source file, for lineage |

## Work order

1. ✅ **Harden ingest.**
   - Treat an already-processed Partner B file as unchanged instead of failing (`src/ingest/partner-b.ts`).
   - Add a timeout to the Partner A fetch (`src/ingest/partner-a.ts`).
   - Move date helpers to `src/lib/dates.ts` with strict parsing.
   - Add a `test` script.
2. ✅ **Stage 3: validate and normalize.** Built with a fixed ILS→USD rate (`FX_ILS_PER_USD`) and a configurable reporting timezone (`REPORT_TZ`, default UTC); both still need the user's decision.
3. **Stage 4: Postgres load.** Add `pg`, a schema and a migration. Read `clean/` rows and rejected rows; replace a partner-day on reload so re-runs never duplicate revenue.
4. **Stages 5–8**, in order: SQL analysis, QA checks and alerts, Google Sheets, daily schedule. The schedule needs hosted S3 and Postgres plus repository secrets.

The details listed for stages 5–8 are a proposal and may change as those stages are built.
