-- Stage 5: analysis views on top of revenue_daily and rejected_rows.
-- Read by src/report/ (npm run report) and, later, by stage 6 (QA) and stage 7 (Google Sheets).
-- Everything here is CREATE OR REPLACE, so this file is safe to run again.
--
-- Money stays NUMERIC end to end. eCPM and shares are rounded to 6 decimals.
-- eCPM = revenue_usd / impressions * 1000, and NULL (never a division by zero) when impressions = 0.

CREATE OR REPLACE FUNCTION analysis_ecpm(revenue_usd numeric, impressions numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$ SELECT round(revenue_usd * 1000 / NULLIF(impressions, 0), 6) $$;

-- One row per day.
CREATE OR REPLACE VIEW v_daily_totals AS
SELECT date,
       sum(revenue_usd)                                 AS revenue_usd,
       sum(impressions)                                 AS impressions,
       analysis_ecpm(sum(revenue_usd), sum(impressions)) AS ecpm_usd,
       count(DISTINCT partner)                          AS partner_count,
       count(*)                                         AS row_count
FROM revenue_daily
GROUP BY date;

-- One row per day and partner.
CREATE OR REPLACE VIEW v_daily_by_partner AS
SELECT date,
       partner,
       sum(revenue_usd)                                 AS revenue_usd,
       sum(impressions)                                 AS impressions,
       analysis_ecpm(sum(revenue_usd), sum(impressions)) AS ecpm_usd,
       count(*)                                         AS row_count
FROM revenue_daily
GROUP BY date, partner;

-- One row per day and site, all partners combined.
CREATE OR REPLACE VIEW v_daily_by_site AS
SELECT date,
       site,
       sum(revenue_usd)                                 AS revenue_usd,
       sum(impressions)                                 AS impressions,
       analysis_ecpm(sum(revenue_usd), sum(impressions)) AS ecpm_usd,
       count(DISTINCT partner)                          AS partner_count
FROM revenue_daily
GROUP BY date, site;

-- One row per day and ad unit, all partners combined.
CREATE OR REPLACE VIEW v_daily_by_ad_unit AS
SELECT date,
       ad_unit,
       sum(revenue_usd)                                 AS revenue_usd,
       sum(impressions)                                 AS impressions,
       analysis_ecpm(sum(revenue_usd), sum(impressions)) AS ecpm_usd,
       count(DISTINCT partner)                          AS partner_count
FROM revenue_daily
GROUP BY date, ad_unit;

-- Revenue per partner vs the previous calendar day.
-- LAG looks at the partner's previous loaded day; it only counts as "previous" when it is
-- exactly date - 1, so a gap in the data gives NULLs instead of comparing against an older day.
-- revenue_change_pct is NULL when there is no previous day or the previous revenue was 0.
-- A partner with no rows today has no row here at all; spotting that is a stage 6 QA check.
CREATE OR REPLACE VIEW v_partner_day_over_day AS
WITH lagged AS (
  SELECT date,
         partner,
         revenue_usd,
         lag(date)        OVER w AS lag_date,
         lag(revenue_usd) OVER w AS lag_revenue_usd
  FROM v_daily_by_partner
  WINDOW w AS (PARTITION BY partner ORDER BY date)
), prev AS (
  SELECT date,
         partner,
         revenue_usd,
         CASE WHEN lag_date = date - 1 THEN lag_date END        AS prev_date,
         CASE WHEN lag_date = date - 1 THEN lag_revenue_usd END AS prev_revenue_usd
  FROM lagged
)
SELECT date,
       partner,
       revenue_usd,
       prev_date,
       prev_revenue_usd,
       revenue_usd - prev_revenue_usd                                          AS revenue_change_usd,
       round((revenue_usd - prev_revenue_usd) * 100 / NULLIF(prev_revenue_usd, 0), 6) AS revenue_change_pct
FROM prev;

-- Rejected rows per day, partner and reason, with the share of the partner-day they represent.
--   rejected            rows rejected for this reason
--   partner_rejected    rows rejected for any reason, for this partner-day
--   loaded              rows loaded into revenue_daily for this partner-day
--   reason_share        rejected         / (partner_rejected + loaded)
--   reject_share        partner_rejected / (partner_rejected + loaded), the same on every reason row
-- Shares are fractions (0.25 = 25%). The denominator is at least 1, since every row here has a reject.
CREATE OR REPLACE VIEW v_reject_summary AS
WITH by_reason AS (
  SELECT date, partner, reason, count(*) AS rejected
  FROM rejected_rows
  GROUP BY date, partner, reason
), per_day AS (
  SELECT date, partner, reason, rejected,
         sum(rejected) OVER (PARTITION BY date, partner) AS partner_rejected
  FROM by_reason
), loaded AS (
  SELECT date, partner, count(*) AS loaded
  FROM revenue_daily
  GROUP BY date, partner
)
SELECT r.date,
       r.partner,
       r.reason,
       r.rejected,
       r.partner_rejected::bigint                                                AS partner_rejected,
       coalesce(l.loaded, 0)                                                     AS loaded,
       round(r.rejected::numeric / (r.partner_rejected + coalesce(l.loaded, 0)), 6)         AS reason_share,
       round(r.partner_rejected::numeric / (r.partner_rejected + coalesce(l.loaded, 0)), 6) AS reject_share
FROM per_day r
LEFT JOIN loaded l USING (date, partner);
