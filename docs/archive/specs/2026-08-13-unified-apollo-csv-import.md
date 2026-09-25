# Unified Apollo CSV import

## Goal
Replace the separate Contacts and Companies CSV workflows with one Apollo People-export workflow. A single uploaded file is parsed into unique company candidates and contacts, creates or resolves the companies first, and then imports contacts linked to the resulting Airtable Company record IDs.

The workflow must preserve the existing human review for ambiguous company matches, existing-contact skip behavior, and safe retry behavior if the two-stage Airtable write only partially succeeds.

## Non-goals
- Importing Apollo email, phone, address, funding, revenue, intent, technology, SIC, NAICS, or other newly available fields.
- Updating existing Airtable Companies or Contacts from the CSV.
- Supporting Apollo Accounts exports, Ensun exports, or a provider-neutral CSV format in this iteration.
- Adding a new top-level serverless function or changing Airtable schema.
- Performing a live Airtable import as part of automated verification.

## Research findings
- The current UI, browser parser, API client, and server handlers split Contacts and Companies into separate workflows.
- The attached Apollo People export is a valid UTF-8 CSV with 75 unique headers and 43 well-formed contact rows representing 24 companies. Repeated company attributes are internally consistent.
- Every row has the fields needed by the current Contact importer and eight reusable Company fields. The People export does not include the Accounts-only `Short Description` and `Founded Year` fields, so those values cannot be populated.
- `Apollo Account Id` is the required grouping key for companies within this file. Rows without it fail closed. If rows sharing an account ID contain conflicting nonblank company identity or mapped field values, the whole company group and its Contacts are invalid. Airtable matching must still use the current priority: normalized Company LinkedIn URL, website domain, then exact normalized name.
- Airtable Companies has no guaranteed uniqueness constraint. Ambiguous or conflicting matches must remain a user decision; the importer must never select the first candidate blindly.
- Contacts require Airtable Company record IDs, so Company resolution/creation must finish before Contact preview and commit.
- Airtable does not provide a transaction spanning both table writes. The workflow therefore needs explicit partial-success reporting and resumability.
- Existing parsing limits are 5 MB and 500 rows. Browser and server payloads are allowlisted, so unused sensitive Apollo columns are not sent.
- The shared `/api/import` route is intentional because of the Vercel function budget. The Airtable adapter already validates schema, paginates, batches writes, throttles requests, retries transient failures, and uses `typecast: false`.

## Decisions
- One uploaded Apollo People CSV always processes both Companies and Contacts; the old mode selector is removed.
- Rows are grouped into company candidates by `Apollo Account Id`. Missing Airtable companies are created; existing companies are reused.
- Airtable company matching remains LinkedIn URL, then website domain, then exact name. Ambiguous/conflicting matches and every name-only match remain visible choices for the operator; name alone never silently selects or creates a Company.
- Only fields already supported by the current importers are imported. Extra Apollo fields are ignored; unavailable `Short Description` and `Founded Year` remain blank.
- All valid new companies in the file are created even if every associated Contact is already present or skipped.
- Existing Contacts are skipped and never updated.
- A single required `Added by` selection is used for both tables and must be valid for both Airtable fields.
- If Company writes succeed and Contact writes fail, the created Companies remain. A retry resumes by re-reading Airtable, reusing those Companies, and importing only still-missing Contacts.
- The existing `import.csv.companies` and `import.csv.contacts` server operation boundaries remain independent. The unified browser workflow requires both capabilities to be enabled; it does not weaken either check or alter machine operations sharing `/api/import`.

## Approach
Add a unified browser-side parser that validates the Apollo People export once, requires `Apollo Account Id`, retains the current allowlisted Contact mapping, and derives a deduplicated Company payload keyed by that account ID. Repeated rows may contribute a missing value, but conflicting nonblank values invalidate the group. Keep provider IDs client-side for grouping only; do not add them to Airtable.

Refactor the import page into one staged workflow: upload and mapping review, shared `Added by` selection, Company preview/resolution, Company commit, resolved-company verification, Contact preview, Contact commit, and a combined result. Automatically propose creation only for companies with no Airtable match. Require explicit operator action for name-only, ambiguous, and conflicting matches, and preserve searchable existing-company selection.

Reuse the current Company and Contact server handlers through the shared import route. Build one authoritative `Apollo Account Id → Airtable Company record ID` map from stable existing matches, operator-selected matches, and successful/adopted Company commit results. Every Contact preview and commit carries that resolved record ID; the server verifies it still exists and never rematches the Contact to a different Company. Force fresh Airtable reads after Company commit so newly created IDs are visible and stale company caches cannot cause false failures.

Make retries postcondition-driven: re-fetch current Airtable records, adopt Companies already created by stable LinkedIn/domain identity, rebuild the authoritative account-to-record map, and create only still-missing Contacts. Preserve a combined, downloadable row-level result report across both stages.

## Implementation phases
1. **Unified parser and contract (M):** Add Apollo People-to-Companies grouping, shared validation, deterministic company candidate IDs, and allowlisted payload generation. Require an account ID, fail closed on conflicting rows within a group, and cover repeated companies, malformed rows, and ignored sensitive fields.
2. **Unified staged UI (L):** Replace the import-type choice and separate page handoff with one combined workflow. Reuse company resolution UI, show per-stage counts and decisions, require a shared `Added by`, and present a combined result with partial-success/retry state.
3. **API orchestration and freshness (M):** Extend the existing import API client/types so Contact preview validates an explicit resolved Company ID, preserve the shared route and independent feature boundaries, validate shared attribution, and guarantee fresh Company state after Company commit.
4. **Verification and documentation (M):** Add parser and handler regressions, exercise partial-failure/retry state without live writes, run the frontend tests and production build, visually verify the local import flow, and update current setup documentation.

## Affected files/modules
- `frontend/src/lib/csvImport.ts`
- `frontend/src/lib/importApi.ts`
- `frontend/src/pages/CsvImport.tsx`
- `frontend/src/pages/CompanyCsvImport.tsx` (remove from routing/use or reduce to shared presentation as appropriate)
- `frontend/src/components/CompanyResolutionModal.tsx`
- `frontend/api/import.ts`
- `frontend/api/_lib/contactImport.ts`
- `frontend/api/_lib/companyImport.ts`
- `frontend/api/_lib/airtable.ts` if shared metadata/cache invalidation needs a narrow change
- `frontend/tests/csvImport.test.ts`
- `frontend/tests/contactImport.test.ts`
- `frontend/tests/companyImport.test.ts`
- `frontend/tests/importRoute.test.ts`
- Current import documentation and styles referenced by the affected pages

## Risks & how to verify
- **Duplicate Companies from repeated contact rows:** assert that the attached 43-row file produces exactly 24 company candidates and stable grouping across row order changes.
- **Incorrect grouping when an account ID is absent or reused inconsistently:** fail the affected group and all of its Contacts; test missing IDs and conflicting nonblank values without fallback grouping.
- **Wrong Airtable Company selected:** retain ordered identifier matching, require human resolution for name-only/ambiguous/conflicting candidates, carry the resolved Company ID to every Contact in that account group, and test that Contact preview cannot rematch it.
- **Stale Company cache after creation:** run Contact preview only after a forced refresh and test that newly created Company IDs resolve immediately.
- **Partial writes:** simulate successful Company commit followed by Contact failure, then verify retry skips existing Companies and imports only missing Contacts.
- **Sensitive-column leakage:** assert that email, phone, funding, revenue, address, technology, and intent columns never appear in Company or Contact API payloads.
- **Attribution mismatch:** intersect/validate `Added by` choices for both Airtable fields and block commit if the selected value is not valid for either table.
- **Authorization or shared-route regression:** retain admin authorization, POST-only human actions, independent Contact/Company operation checks, and the existing machine-operation dispatch order; cover these invariants in route tests.
- **Incomplete audit handoff:** provide one downloadable report that contains every source Contact row plus its company and contact outcomes/IDs, including partial failures and retries.
- **UI regression:** visually verify desktop and narrow layouts for upload, review, ambiguity resolution, partial success, retry, and final summary.

## Definition of done
- The attached Apollo People CSV is accepted by a single import workflow and previews 43 Contacts and 24 unique Companies.
- Missing Companies can be created, existing Companies can be reused, and name-only, ambiguous, or conflicting matches require a visible operator decision.
- Missing `Apollo Account Id` or conflicting company data within an account group blocks that group and its Contacts without fallback matching.
- Company processing completes before Contacts are previewed/created, and every new Contact is linked to the correct Airtable Company record.
- The authoritative account-to-Airtable-ID map is used for Contact preview and commit; Contact processing cannot independently select another Company.
- Existing Companies and Contacts are not updated; existing Contacts are reported as skipped.
- Only existing allowlisted fields are sent or written, with one valid `Added by` value used for both tables.
- A Contact-stage failure after Company creation can be retried without duplicate Companies or Contacts.
- One downloadable combined report preserves row-level Company and Contact outcomes and Airtable IDs across partial success and retry.
- Human import remains admin-only and POST-only, both import capability checks remain independent, and existing machine operations on `/api/import` are unaffected.
- Relevant automated tests, API typecheck, and `npm run build` pass.
- The complete local UI flow is visually verified without performing live Airtable writes.
- Current documentation describes the unified import and no longer presents separate Contacts/Companies modes.
- Implementation changes are committed in one or more logical commits, preserving the pre-existing untracked tenant-owner spec.
