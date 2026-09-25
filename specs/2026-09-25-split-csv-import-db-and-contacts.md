# Split CSV import: Companies → Airtable "DB", Leads → Airtable "Contacts"

Supersedes `specs/2026-08-13-unified-apollo-csv-import.md` (shipped). When this plan ships, move that spec to `docs/archive/`.

## Status (2026-09-25)

Phases 1–4 and 6 are implemented on branch `csv-import-db-contacts`; the superseded spec is in `docs/archive/specs/`. Phase 5's dry-run script is `frontend/scripts/airtable-website-backfill.mjs` (dry run on the live base: DB 21,770 values would change and 25 are left alone; Companies 5,102 and 4). Its `--apply` mode has not been run.

Still open, all outside the code:
- The four Airtable-owner items below. Item 1 decides whether bare domains in `Company Website` are safe for the automation and the Interface; nothing has been written to the live base yet.
- The `import.csv.companies` / `import.csv.contacts` capabilities from `specs/2026-08-12-tenant-owner-feature-config.md` do not exist in code. The two tabs are gated by the existing admin-only POST guard and by separate action sets, not by capability flags.
- Deploy. Measured read-only against the live base: the cold Companies read is 12.6 s, a warm 500-row company preview 3.3 s, and a 500-row lead preview 13.9 s, which includes a full Contacts read.

## Goal
Turn the single combined upload into two uploads that do not depend on each other:

1. **Companies upload** writes new companies into the Airtable **DB** table (`tblEYOgRDRg0aYfzI`) for approval. It never writes to the **Companies** table.
2. **Leads upload** writes people into the Airtable **Contacts** table (`tbl87CQnAjpKigu7i`). Each lead is linked to a **Companies** record that the Data Sourcer (DS) confirms by hand.

Approval stays in Airtable. SDRs review DB rows in an Airtable Interface, and Airtable automations copy approved rows into Companies. Outreach deck only feeds DB and reads status back.

Every domain the importer writes or compares is normalized to a bare hostname, such as `clioassist.de`. Scheme, `www.`, path, query, case and trailing dots are removed.

## Non-goals
- Any Postgres/Neon change. "DB" is an Airtable table. There is no ledger step, and `SCHEMA_DOC` does not change.
- Approving companies in Outreach deck, or writing the Companies table. The Airtable automations own both.
- Importing columns the DB table has no field for: growth %, revenue, company type, department headcounts, logo, sales/BD team size, email and email status. Adding Airtable fields for them is a separate request.
- Updating existing DB, Companies or Contacts records from a CSV. Duplicates are skipped and reported.
- Setting the DB `Hypothesis` link on upload. This is a possible follow-up.
- Persisting held leads server-side between sessions. "Refresh" re-checks the file still loaded in the page; re-uploading the same file later is also safe.

## Research findings (2026-09-25, live Airtable base `app4P6PbWSwEEmOIz`, read-only)
- **The current importer writes the wrong table and rejects the new files.** `companyImport.ts` creates and enriches **Companies** records. `csvImport.ts` requires the Apollo headers `Person Linkedin Url` and `Apollo Account Id`. Neither attached export has them, so both files would be rejected today.
- **Attached export format.** The companies file has 26 columns: `Company Name`, `Company Domain`, `Company Website URL`, `Company Linkedin URL Unique ID`, `Company Location`, `Company Industry`, `Company Employee Exact Count`, `Company Year Founded`, `Company Description`, `Company Specialities`, and so on. The leads file has 54 columns: the person columns (`First Name`, `Last Name`, `Current Job`, `Linkedin URL Public`, …) plus the same company columns. Both have `Matches Filters`/`No Match Reasons` and multi-line quoted cells (`Department Headcounts`).
- **Data quirks in the samples:**
  - mixed-case domains (`BeWell.help`)
  - `http://www.` and trailing-slash websites
  - `Company Year Founded = 0`
  - revenue `"0.0 ONE"`
  - trailing spaces in titles (`"Founder & CEO "`)
  - company LinkedIn given as a numeric-ID URL (`/company/109209384`), not a slug
  - lead `Company Domain` differing from the email domain (`metapause.ai` vs `@themetapause.com`)
- **DB table: 21,795 rows, 27 fields.**
  - The primary field is `Company Website` (`url`). Approval state is `Initial status` (`singleSelect`): Rejected 16,460, Approve 4,342, Manual approve 735, Manual review 189, Old 65, New 4.
  - `Added to Companies` = `Added` on 5,085 rows. This is the automation's transfer marker.
  - Also present: `Company name`, `Company name for mailing`, `LinkedIn URL`, `HQ country`, `Founded year` (number), `Employees` (number), `Industry`, `Keywords`, `Description`, `Added by` (select), `ICP fit`, `Reject reason`, `Approved by`, `Hypothesis` (link).
- **Companies table: 5,106 rows.** `Approve Status` is New 334, Approved 2,617, Rejected 2,155. `Website URL` (`url`). Of its 4,932 unique domains, 4,829 are already in DB, so about 100 exist only in Companies.
- **Website values are almost all full URLs.**
  - DB: 21,098 `https://www.…`, plus `http://`, paths, queries and upper case.
  - Companies has 2 values that are not URLs at all (`"true. Women's Health"`, `"SGP s.r.l"`).
  - After normalization, DB has 32 duplicate domains (`linktr.ee` ×16, `clubpilates.com` ×5, …) and Companies has 139. **Lead → Company matching by domain can be ambiguous and must stay a human choice.**
- **Select fields are polluted by past `typecast: true` imports.** `Initial status`, `Added to Companies`, `Site is operational` and the Contacts `Approve status` contain dozens of junk choices (industries, cities, surnames). The importer must keep `typecast: false`, and write only choices it has checked exist.
- **`Added by` choices differ per table.**
  - DB: `David Gamanuk`, `AI`, …
  - Contacts: `David Hamaniuk`, `David`, …
  - So one shared selection, as in the current importer, cannot be valid for both. Each upload validates against its own table.
- **Full-table reads of DB don't fit the function budget.** 21.8k rows is about 218 pages, roughly 50 s at the adapter's 225 ms gap, against `maxDuration = 60`. Lookups must query only the domains and names in the upload, using `filterByFormula` through the POST `listRecords` endpoint so long formulas fit. Companies (about 52 pages) can keep the existing cached full read.
- **Reusable today:** the Airtable adapter (schema check, throttling, retries, batch create), the Companies match logic (`companyMatch`: LinkedIn → domain → name, with ambiguity detection), `company_search`, the existing-contact skip, admin-only POST actions on `/api/import`, and the independent `import.csv.companies` and `import.csv.contacts` capability checks.

## Decisions
- **Two independent tabs on the CSV Import page: "Companies → DB" and "Leads → Contacts".** Either can run alone, in any order. They are gated by the existing `import.csv.companies` and `import.csv.contacts` capabilities respectively. The unified Apollo flow and the `Apollo Account Id` requirement are removed.
- **Uploading the wrong file in a tab fails clearly** (header-signature check). A leads file dropped in the Companies tab, or the reverse, is rejected with a pointer to the right tab.
- **Header mapping** targets the attached export format. Apollo People/Accounts header names stay as aliases, so older exports still parse.
- **Companies upload → DB.**
  - Dedupe key: the normalized domain, taken from `Company Domain` or else `Company Website URL`. A row with no usable domain is invalid.
  - A domain already in DB (any status) or in Companies is skipped. The result shows "N companies skipped as duplicates" with each name, domain and where it was found, e.g. "DB · Rejected" or "Companies · Approved".
  - Repeats inside the file are skipped the same way.
  - A name-only match is a warning in the preview. The row is still created unless the DS unticks it.
- **DB field mapping for new rows:**

  | DB field | Source |
  |---|---|
  | `Company Website` | normalized bare domain |
  | `Company name` | `Company Name` |
  | `LinkedIn URL` | `Company Linkedin URL Unique ID`, canonical `https://www.linkedin.com/company/<id>/` |
  | `HQ country` | last comma segment of `Company Location`, falling back to `Company Headquarters (Full Address)` |
  | `Founded year` | `Company Year Founded`; `0` or out of range is left blank |
  | `Employees` | `Company Employee Exact Count` |
  | `Industry` | `Company Industry` |
  | `Keywords` | `Company Specialities` |
  | `Description` | `Company Description` |
  | `Initial status` | `New` |
  | `Added by` | the DS's selection from DB choices |

  `Company name for mailing` stays blank.
- **Leads upload → Contacts. Leads are grouped by company:** normalized domain first, then company LinkedIn, then normalized name. For each group the importer suggests a Companies record: a single domain match first, then a LinkedIn match, then an exact normalized-name match.
  - **The DS must confirm every group.** The suggestion is preselected, but nothing is written until it is confirmed.
  - The DS can pick another suggestion or search Companies manually by name, domain or LinkedIn.
  - A "Confirm all single domain matches" bulk action counts as the manual confirmation, for speed.
- **Groups that cannot be linked are classified from Companies and DB:**
  - Companies record exists but `Approve Status = Rejected` → **declined**, leads skipped.
  - DB `Initial status = Rejected` → **declined**, leads skipped.
  - DB row in any other state (New, Manual review, Manual approve, Approve or Old, but not yet in Companies) → **pending approval**, leads held.
  - Found nowhere → **company not uploaded**, leads held. The DS can still link manually through search.
- **Held/declined report.** The result lists the held lead count and the company names awaiting approval (with DB status), and separately the declined companies whose leads were skipped. The DS asks an SDR to approve, then presses **Re-check**. This re-runs the preview on the same loaded file: newly approved companies become linkable, and already-created contacts show as existing. Re-uploading the file later behaves the same.
- **Contacts written:** `Persona LinkedIn` (canonical `https://www.linkedin.com/in/<slug>/` from `Linkedin URL Public`), `First name`, `Full name`, `Title` (from `Current Job`, trimmed), `Company` (the confirmed record), `Added by` (from Contacts choices), `Approve status = New`. An existing contact (same normalized person URL) is skipped. The rest of the row is dropped at the browser allowlist, so email and similar columns never reach the server.
- **Domain normalization** lives in one shared module used by the browser parser and the server:
  1. trim;
  2. if there is no scheme, prefix `https://`;
  3. parse as a URL and take the hostname, which drops scheme, credentials, port, path, query and fragment;
  4. lower-case, convert IDN to punycode, strip the trailing dot;
  5. strip a leading `www.`/`www<n>.`;
  6. require at least two labels and an alphabetic TLD;
  7. reject IP literals.

  Other subdomains are **kept**, with no public-suffix collapsing, so `foo.webflow.io`-style hosts and regional sites are never merged into another company. A blocklist of non-company hosts counts as "no usable domain": `linktr.ee`, `linkedin.com`, `facebook.com`, `instagram.com`, `x.com`, `twitter.com`, `youtube.com`, `google.com`, `sites.google.com`, `bit.ly`. `normalizeDomain` in `contactImport.ts` is replaced by this module.
- **Plain domain is stored in the Website fields.** New DB rows get the bare domain in `Company Website`, so the automation carries it into Companies `Website URL`. Matching normalizes both sides, so the existing full-URL values keep working without a backfill. Rewriting the existing 21.8k DB and 5.1k Companies values is a separate, optional, owner-approved step (phase 5).
- **Record lookups are targeted.** DB lookups use a normalized-domain `filterByFormula` (`REGEX_REPLACE` over `LOWER({Company Website})`) plus a name formula, batched through POST `listRecords`. No full DB read happens. Companies keeps its cached full read, and every commit forces a fresh read.

## Approach
Keep the `/api/import` action surface and admin/POST guard, but point the company actions at DB:

- `company_metadata`: DB schema check and DB `Added by` choices.
- `company_preview`: duplicate lookup in DB and Companies.
- `company_commit`: DB creates only. The enrichment/update path and the Companies write go away.

The contact actions keep their names:

- `contact_preview`: runs the group classification against Companies plus targeted DB lookups, and returns per-group suggestions and a hold/decline status.
- `contact_commit`: accepts only rows that carry a DS-confirmed Companies record ID. It re-checks that the record still exists and is not Rejected, and never re-matches.
- `company_search`: unchanged.

On the browser side:

- `csvImport.ts` gets two parsers, a companies file and a leads file, with header-signature detection, alias mapping and the shared domain normalizer.
- `UnifiedApolloCsvImport.tsx` is replaced by a two-tab page built from `src/ui` primitives (`Tabs`, `TableFrame`, `Field`, `Dialog`, `Button`) per `docs/ui-standard.md`.
- The leads tab shows one row per company group with its leads count, suggestion, match method, status chip and a confirm/change control. The result panel has the held/declined lists, a Re-check button, and a downloadable row-level report.

## Implementation phases
1. **Shared domain normalizer + parsers (M).**
   - `src/lib/domain.ts` with a table-driven test covering scheme/www/case/path/query/port/IDN/trailing-dot/IP/blocklist/garbage inputs, including the real Airtable oddities above.
   - Companies-file and leads-file parsers with alias mapping and wrong-file detection.
   - Lenient number parsing: `0` year becomes blank and `"0.0 ONE"` is ignored.
   - Synthetic fixtures with the attached headers. The real files contain personal data and stay out of the repo.
2. **Companies → DB server path (M).**
   - DB field IDs in `AIRTABLE_IDS`, and a DB schema check (types, `Initial status` has `New`, `Added by` choices).
   - Targeted POST `listRecords` lookups (adapter gains a narrow `findRecordsByFormula`).
   - Duplicate classification against DB and Companies, and batched creates with `typecast: false`.
   - Remove the Companies create/enrich code.
3. **Leads → Contacts server path (M).**
   - Group classification: confirmed, suggested (domain/LinkedIn/name), ambiguous, pending (with DB status), declined, not uploaded.
   - Commit accepts only confirmed Companies IDs and re-verifies them, including the Rejected check.
   - Contacts `Added by` validated against its own choices.
4. **Two-tab UI (L).**
   - Companies tab: upload → preview (new / duplicate with location / name warning / invalid) → commit → result with the duplicate list and report.
   - Leads tab: upload → group review with confirm/search/bulk confirm → commit → result with held/declined lists, Re-check and report.
   - Update `unifiedApolloCsvImport.test.tsx` and `csvImportStates.test.tsx` into per-tab tests, and run `npm run ui:inventory`.
5. **Optional: website backfill (S, owner-approved).** Dry-run script that reports the bare domain each DB `Company Website` and Companies `Website URL` would become. Values that do not normalize are listed and left untouched. The real rewrite is run only on an explicit go-ahead, in 10-record batches.
6. **Verification + docs (S).**
   - Handler tests with a mocked adapter; `importRoute.test.ts` keeps the auth and capability invariants.
   - Frontend tests, `npm run build`, and a separate API typecheck (`npm run build` skips `api/`).
   - A browser walkthrough of both tabs with a fake Airtable.
   - Update `README.md` import docs and archive the 2026-08-13 spec.

## Affected files/modules
- `frontend/src/lib/domain.ts` (new), `frontend/src/lib/csvImport.ts`, `frontend/src/lib/importApi.ts`
- `frontend/src/pages/UnifiedApolloCsvImport.tsx` (replaced by the two-tab page), `frontend/src/components/CompanyResolutionModal.tsx` (reused for per-group company choice), `frontend/src/lib/navigation.ts` if the route label changes
- `frontend/api/_lib/airtable.ts` (DB IDs, formula lookup), `frontend/api/_lib/companyImport.ts`, `frontend/api/_lib/contactImport.ts`, `frontend/api/import.ts` (action sets only)
- `frontend/tests/csvImport.test.ts`, `companyImport.test.ts`, `contactImport.test.ts`, `importRoute.test.ts`, `unifiedApolloCsvImport.test.tsx`, `csvImportStates.test.tsx`, plus a new `domain.test.ts`

## Risks & how to verify
- **Writing to Companies by mistake.** Test that `company_commit` only ever targets the DB table ID and no code path creates or updates Companies records.
- **Duplicate DB rows.** DB has no uniqueness constraint. Preview and commit both re-query DB and Companies by normalized domain immediately before creating, and in-file repeats are collapsed. Test that `https://www.X.com/path`, `X.COM` and `x.com.` all collide.
- **Wrong company linked to a lead.** No auto-link: every group needs a confirmation. Ambiguous domains (139 in Companies) show all candidates. Commit re-verifies the chosen ID.
- **Held/declined misclassification.** Unit-test each status source: Companies Rejected, DB Rejected, each non-rejected DB state, not found. Test that a declined group can never be committed.
- **Function timeout on the 21.8k-row DB.** Assert that preview issues only formula-scoped DB queries, and measure a 500-row preview against the live base (read-only) before release.
- **Formula injection.** Domains and names put into `filterByFormula` are escaped. Domains are already constrained to `[a-z0-9.-]`. Names are quote-escaped and length-capped, and tested with quotes and backslashes.
- **Select pollution.** `typecast: false` everywhere. `Initial status = New` and `Added by` are checked against live choices before writing.
- **Automations relying on full URLs.** New DB rows carry a bare domain. Before release, confirm with the Airtable owner that the DB → Companies automation and Interface work with a bare domain in `Company Website`.
- **PII in fixtures.** Only synthetic rows in tests. A payload-allowlist test asserts that email, email status, phone and profile summary never leave the browser.

## Open items (Airtable owner)
1. Confirm that the automation copies `Company Website` into Companies `Website URL` unchanged, and treats a bare domain correctly.
2. Confirm the status semantics above: DB `Rejected` = declined; `Approve`/`Manual approve` without `Added to Companies` = still pending transfer; `Old` = pending.
3. Decide whether phase 5 (rewriting existing websites to bare domains) should run.
4. Optionally clean the junk choices out of the polluted select fields. The importer does not depend on it.

## Definition of done
- The attached companies export imports into DB as 13 new `Initial status = New` rows with bare-domain websites. Re-uploading it skips all 13 and lists them as duplicates in DB.
- Nothing in the import path writes to the Companies table.
- The attached leads export previews two company groups. Neither is linkable until its company exists in Companies, and both are reported as "company not uploaded" with lead counts. After an SDR approves and the automation transfers them, Re-check makes them confirmable, and commit creates the Contacts linked to the confirmed records.
- A lead whose company is Rejected (in DB or Companies) is skipped and reported. Existing contacts are skipped.
- Every domain written or compared goes through the shared normalizer, and all listed junk forms collapse to one key.
- Human import stays admin-only and POST-only, the two capabilities stay independent, and machine operations on `/api/import` are unaffected.
- Tests, API typecheck, `npm run build` and `npm run ui:inventory` pass. Both tabs are browser-verified against a fake Airtable, with no live writes during verification.
