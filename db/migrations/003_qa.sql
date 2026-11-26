-- Stage 6: results of the daily QA checks (src/qa/, npm run qa -- <date>).
-- A run for a date replaces all of that date's rows in one transaction, so re-runs never duplicate.

CREATE TABLE qa_results (
  id          bigserial    PRIMARY KEY,
  date        date         NOT NULL,
  "check"     text         NOT NULL, -- missing_partner_day, reject_share, day_over_day, zero_totals
  partner     text,                  -- NULL for checks about the whole day
  status      text         NOT NULL CHECK (status IN ('pass', 'warn', 'fail')),
  message     text         NOT NULL,
  details     jsonb        NOT NULL DEFAULT '{}',
  checked_at  timestamptz  NOT NULL DEFAULT now()
);

-- One result per date, check and partner (the whole-day result counts as partner '').
CREATE UNIQUE INDEX qa_results_date_check_partner_idx ON qa_results (date, "check", coalesce(partner, ''));
