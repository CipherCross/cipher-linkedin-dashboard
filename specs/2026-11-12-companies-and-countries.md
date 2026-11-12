# Companies tab, lead↔company link, country data and analytics

Status: in implementation (2026-11-12). Delete once shipped and verified in production.

## Context
The team can't answer "which countries / which companies are we writing to, and how do they respond". Before this change:
- `leads` had no location or country. LH2 has a location for every person (`person_location → locations.name`), but the agent synced it only for repliers (`lead_profiles.location`).
- There was no company entity in Neon. Companies live in Airtable (Companies table, `HQ country` on ~99% of 5.5k rows). The app only cached Apollo data per lead when a conversation opened (`lead_company_context`).
- `leads.company` is LH2's *current company*, which is **not** why we write to the person. The owner wants the company to come from Airtable: lead → Airtable Contact (by LinkedIn slug) → linked Company. That match already works offline for ~87% of invited leads (`analysis/outreach-insights/enrich.py`).

Owner decisions (2026-11-12): sync location for **all** leads from LH2 (reverses the 2026-10-13 decline); company + company country from **Airtable only**, show **all** Airtable fields; analytics by both lead country and company HQ with a toggle; country analytics live **inside the Companies tab**.

Since the plan was written a third base (Healthcare (Services)) landed; the sync covers every base in `AIRTABLE_BASES`, and an unconfigured base is skipped.

## 1. Schema — ledger step 030 (`postgres/tenant-baseline/v1/030_companies_countries.sql`)
- `countries(iso2 PK, name, region)` + `country_aliases(alias PK lower-case, iso2)` seeded with all ISO countries plus common LinkedIn forms (US states, "Bay Area", "Greater X Area", "X Metropolitan Area", UK nations, UAE/KSA, …).
- `geo_country_code(text) → char(2)`: whole string, then last comma segment, then each segment right-to-left against aliases (also with "Greater"/"Area"/"Metropolitan"/"Region" stripped); NULL if unresolved.
- `leads`: `location text` (≤300) and `country_code char(2)`; trigger on insert/update of `location` sets `country_code`.
- `airtable_companies(base_key, record_id)`: typed columns + `fields jsonb` (every Airtable field by name), `country_code` by trigger.
- `airtable_contacts(base_key, record_id)`: `persona_slug` (indexed) + typed columns + `fields jsonb`.
- `lead_company_links(instance_id, profile_url)`: `base_key, company_record_id, contact_record_id, method ('contact_slug'|'manual'), linked_by, linked_at`. Manual links are never overwritten by refresh.
- `airtable_sync_state(base_key, table_key)`: `cursor`, resumable `pending_offset`/`run_started_at`, `last_run_at`, `last_error`, `rows_upserted`.
- Writers: active members (button, CSV import hook, manual link) through `app_runtime`; the daily cron through `app_system` (system actor). No DELETE for anyone except a member clearing a manual link. AI sandbox reads all of it.

## 2. Agent: location for every lead
- Built-in `LOCATION_SQL`-style discovery keyed by every slug (like `ADDED_AT_SQL`): `person_location → locations.name`, fallback current position location. Fails safe to empty.
- Ingest contract: `LeadRow.location`, upsert with `COALESCE(EXCLUDED.location, leads.location)`; parity check and transport tests extended. Old agents send no `location` → stays NULL.

## 3. Airtable → Neon sync + linking
`frontend/api/_lib/airtableSync.ts`: pulls Companies and Contacts per base, incremental via `LAST_MODIFIED_TIME()`, resumable within a time budget; then `refreshLeadCompanyLinks` (contact slug → company; two bases → most recently modified contact; manual links kept). Triggers: daily `/api/classify` cron phase; `POST /api/import?op=airtable.sync`; after a CSV import. Manual link: `POST /api/import?op=company.link`.

## 4. Read ops (`GET /api/activity-daily?op=`)
`companies.searchPage`, `companies.detail`, `companies.unlinked`, `countries.funnel` (axis lead|company, invite-cohort rates, cohorts < 21 days flagged maturing, Unknown row + top unresolved strings); `leads.searchPage` gains `country`/`companyRecordId` filters and returns `country_code`, `location`, `company_link`.

## 5. UI
`#/companies` (tabs Companies | Countries | Unlinked leads), `#/companies/:base/:recordId` detail with every Airtable field; "Open company" from the conversation drawer; Leads page Country column + filter, Airtable company link.

## 6. AI layer
`SCHEMA_DOC` documents the new columns and tables; AI read grants in step 030.

## Ship order
1. Apply ledger 030 to prod → 2. deploy Vercel → 3. run `airtable.sync` once (full) and check link coverage ≈ 87% → 4. publish agent with location, wait for all instances → 5. check country resolution rate, add aliases in a follow-up step if needed. Promote 028–030 to PROTECTED_PATHS in a later session.

## Later (not this change)
Point `coachContext.ts` `airtableCompanyFor` at the synced tables instead of live Airtable calls.
