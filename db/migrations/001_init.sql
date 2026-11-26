-- Stage 4: warehouse tables for clean revenue and rejected rows.
-- Loaded by src/load/ from s3://<bucket>/clean/partner=<p>/date=<d>/{rows,rejected}.json.
-- A partner-day is always replaced as a whole (delete + insert in one transaction).

CREATE TABLE revenue_daily (
  partner      text          NOT NULL,
  date         date          NOT NULL,
  site         text          NOT NULL,
  ad_unit      text          NOT NULL,
  impressions  bigint        NOT NULL CHECK (impressions >= 0),
  -- Stage 3 rounds to 6 decimals; NUMERIC keeps sums exact (no float drift).
  revenue_usd  numeric(18,6) NOT NULL CHECK (revenue_usd >= 0),
  raw_key      text          NOT NULL, -- S3 raw file the row came from
  fx_source    text          NOT NULL, -- FX rate used for ILS->USD
  loaded_at    timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (partner, date, site, ad_unit)
);

CREATE INDEX revenue_daily_date_idx ON revenue_daily (date);

CREATE TABLE rejected_rows (
  id            bigserial    PRIMARY KEY,
  partner       text         NOT NULL,
  date          date         NOT NULL, -- the partner-day being loaded, not the (possibly invalid) date in the row
  reason        text         NOT NULL,
  detail        text,
  raw_key       text         NOT NULL,
  line          integer      NOT NULL, -- 1-based record position in the raw file
  original_row  jsonb        NOT NULL, -- the record exactly as the partner sent it
  loaded_at     timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX rejected_rows_partner_date_idx ON rejected_rows (partner, date);
