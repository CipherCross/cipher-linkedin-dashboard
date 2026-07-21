-- Refocus ICP keyword scopes: include keywords become PER-INDUSTRY only,
-- exclude keywords become ICP-WIDE only. Previously both scopes carried both
-- lists (migration 043). The new model is a clean split:
--   icps.exclude_keywords          -> the one ICP-wide exclude list
--   icp_industries.include_keywords -> per-sub-industry include lists
-- so the team sets include keywords per sub-industry while a single exclude
-- list applies across the whole ICP.
--
-- Dropping a column also drops its check constraint (icps_include_kw_len /
-- icp_industries_exclude_kw_len), so no separate constraint drop is needed.

alter table icps            drop column if exists include_keywords;
alter table icp_industries  drop column if exists exclude_keywords;
