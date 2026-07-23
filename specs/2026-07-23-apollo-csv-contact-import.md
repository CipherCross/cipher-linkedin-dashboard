# Apollo CSV Contact Import

## Goal
Add an in-app import flow that lets an SDR upload an Apollo people CSV, review a safe fixed mapping, link every importable person to an existing Airtable `Companies` record, and create the person in Airtable `Contacts`. The flow replaces row-by-row use of Airtable’s “Add New Contact” form while preserving the company-link and lead-approval workflow.

## Non-goals
- Ensun CSV support in this iteration; the supplied Ensun export contains companies, not people, and is not used for lead imports.
- Creating, staging, or editing Airtable company records. A contact whose company cannot be resolved to an existing `Companies` record must be manually linked or skipped.
- Updating an existing Airtable Contact. Existing people are skipped and reported.
- Adding Airtable fields for email, Apollo IDs, source, phone, or import-batch data. Those source columns are ignored.
- Automatically fuzzy-matching company names or silently selecting among multiple Airtable records.
- Arbitrary CSV-to-Airtable schema mapping. The importer exposes only an allowlisted Contact mapping.
- Individual user authentication or the existing `ADMIN_SECRET` gate for this new import flow. Authentication is deferred; the resulting public write surface is a consciously accepted temporary risk.
- Persistent import history. Results exist for the current browser session and can be downloaded immediately, but completed batches are not stored for later retrieval.
- A background-job system for very large CSVs. The first version is a bounded synchronous import intended for Apollo-sized SDR batches.

## Research findings
- The existing React SPA registers lazy pages in `frontend/src/App.tsx` and fixed navigation in `frontend/src/components/Layout.tsx`. `ImportHistoryPanel.tsx` is useful UX prior art for an input → review → import/result flow, warnings, row inclusion, Back/Cancel behavior, and toast feedback.
- Server writes use Vercel functions with Web `Request`/`Response`, explicit validation, server-only credentials, structured JSON errors, and duration limits. Airtable credentials must follow the same server-only pattern and must never use a `VITE_` environment variable.
- The project already has 12 top-level Vercel functions, identified in the code as the Hobby-plan limit. The import feature therefore cannot simply add a thirteenth function. The existing `import-conversation.ts` function should be generalized into one `/api/import` dispatcher that keeps conversation imports protected by `ADMIN_SECRET` while exposing the approved contact-import actions without that secret.
- The supplied Apollo sample has 40 people across 27 companies and 74 columns. Every row has a person LinkedIn value, company name, and title; 38 have a website. Two person URLs use LinkedIn Sales Navigator paths instead of the clean `/in/...` format required by Airtable and cannot be safely converted automatically.
- The supplied Ensun sample has 24 company rows and no person name, title, or personal LinkedIn field, so it cannot truthfully create Contacts.
- The live Airtable base has approximately 3,005 `Companies` and 2,185 `Contacts`. `Contacts.Persona LinkedIn` is the primary URL field; `Contacts.Company` is a linked-record field targeting `Companies` and prefers one linked company. Airtable maintains the reciprocal `Companies.Contacts` link.
- Writable Contact fields relevant to this import are `Persona LinkedIn`, `Full name`, `First name`, `Title`, `Company`, `Approve status`, and `Added by`. The initial workflow status should be `Approve status = New`; `Readiness status` remains unset until the existing approval/personalization process advances it.
- The live base currently has duplicate identity keys: duplicate company LinkedIn URLs, website domains, normalized company names, and person LinkedIn URLs all exist. Even a strong key must therefore produce exactly one Airtable record before it is considered automatic.
- Against the supplied Apollo sample, no company matched the live base by normalized LinkedIn URL or website domain. Seven unique company names produced possible name matches, one of those was ambiguous, and 20 companies had no name match. The review/resolution experience is therefore a primary path, not an edge case.
- Some live Contact select fields contain unexpected choices resembling CSV headers, names, titles, phone numbers, and emails. Whatever produced them, this demonstrates why the new flow must use fixed field IDs, validate field types, disable Airtable typecasting, and reject arbitrary target fields.
- Airtable list responses are paginated at up to 100 records. Complete matching requires offset pagination because empty fields may be omitted from returned records. Create/update operations accept up to 10 records per request, the base limit is 5 requests per second, and a `429` requires backoff. See [Getting started with Airtable’s Web API](https://support.airtable.com/getting-started-with-airtables-web-api) and [Managing API call limits](https://support.airtable.com/v1/docs/managing-api-call-limits-in-airtable).
- Airtable linked-record writes require Airtable record IDs, not company display names. Automatic typecasting can create unintended select choices or linked records, so writes must use existing record IDs and `typecast: false`. See [Linking records](https://support.airtable.com/docs/linking-records-in-airtable) and [Airtable API troubleshooting](https://support.airtable.com/v1/docs/airtable-api-common-troubleshooting).
- A restricted Airtable PAT can be scoped to the single base and only the schema-read and record read/write capabilities needed by this feature. See [Creating personal access tokens](https://support.airtable.com/v1/docs/creating-personal-access-tokens).
- Papa Parse can parse a local browser `File`, detect malformed rows and duplicate headers, skip empty lines, and handle quoted CSV content. It is a better fit than the repo’s export-only CSV helper or the LH2-specific Python ingestion command. See [Papa Parse documentation](https://www.papaparse.com/docs).

## Decisions
- **Ensun scope:** Skip Ensun for this iteration because nobody uses its company-only CSV for lead imports.
- **Missing company:** Do not create a Company. Mark the company/affected lead rows as requiring action; the SDR must select an existing Airtable company record or skip the lead.
- **Uncertain company match:** Surface an action modal. The SDR searches by company name, website, or LinkedIn and selects the correct record from human-readable results, or skips the affected lead. Airtable record IDs are not required from normal users; direct ID entry may exist only as a troubleshooting fallback.
- **Automatic company matching:** Use normalized company LinkedIn URL, then normalized website domain, then exact normalized company name. A key is automatic only when it resolves to exactly one consistent record. Missing, multiple, or conflicting results require user action; fuzzy matches are suggestions only and are never committed automatically.
- **Existing Contact:** Deduplicate by normalized personal LinkedIn URL. Existing Contacts are skipped without modification and included in the result report.
- **Airtable schema:** Do not add source, Apollo ID, email, phone, or import-batch fields to Contacts. Require the SDR to choose an existing `Added by` value before starting the import.
- **Workflow status:** Every created Contact receives `Approve status = New`; `Readiness status` remains empty for the existing workflow to manage later.
- **Mapping UX:** Auto-detect the Apollo profile from known headers, show the proposed mapping for review, allow source-column corrections only for an allowlisted target set, and fail closed on missing required mappings.
- **Access:** The new contact import actions are not protected by `ADMIN_SECRET` in this iteration. Individual authentication will be handled separately. The existing conversation-import action remains admin-secret protected after endpoint consolidation.
- **Results:** Keep the result summary and row outcomes in the current browser session only. Provide an immediate downloadable result CSV; do not add persistent import-history storage.
- **Import limit:** Accept Apollo CSV files up to 5 MB and 500 data rows in the synchronous MVP.

## Approach
Create a dedicated “CSV Import” page with a five-state workflow:

1. **Importer setup:** Fetch the live `Added by` choices from the Airtable Contact field schema. The SDR must select their identity before choosing a file.
2. **Upload and map:** Parse the CSV locally with Papa Parse. Auto-detect the Apollo header profile and propose only these mappings: `Person Linkedin Url → Persona LinkedIn`, `First Name + Last Name → Full name`, `First Name → First name`, `Title → Title`, and Apollo company identity columns for matching. `Company` and `Added by` are resolved values, not CSV mappings. Unsupported fields are visibly ignored.
3. **Validate and preview:** Normalize URLs/domains/names, group rows by source company, detect within-file person duplicates, and send the minimum normalized preview payload to the server. The server paginates the live Airtable Companies and Contacts tables, builds identity indexes, and returns a per-row state: ready, duplicate Contact, invalid, company action required, or skipped.
4. **Resolve company actions:** Apply a company decision to all rows in that source-company group by default. For missing, ambiguous, or conflicting matches, open a modal that searches existing Airtable Companies and displays name, website, and company LinkedIn for confirmation. The user selects a human-readable result or skips individual/all affected leads; raw `rec...` entry is reserved for troubleshooting and is not part of the normal workflow. The importer never creates a linked record from text.
5. **Commit and report:** Revalidate the selected `Added by`, selected company IDs, Contact duplicates, required fields, and workflow defaults on the server. Create Contacts in batches of at most 10 with `typecast: false`. Show created, duplicate-skipped, user-skipped, validation-failed, and API-failed rows separately, with retry limited to unresolved failures and a downloadable result CSV assembled in the browser.

The server integration should be a typed, fail-closed Airtable adapter in `frontend/api/_lib/airtable.ts`:

- Use `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID` server environment variables. Keep stable table and field IDs in a reviewed code-level configuration so Airtable renames do not silently break matching or writes.
- Validate the live schema IDs and field types before preview/commit. Validate that `Added by` is an existing choice and that every selected company ID belongs to `Companies`.
- Use a request scheduler capped below 5 requests/second, 100-record pagination, 10-record create chunks, and explicit retry/backoff for `429` and transient `5xx` responses.
- Maintain a short-lived in-memory company/contact index cache to keep a preview responsive, but recheck selected company IDs and person LinkedIn duplicates immediately before creation so cached data is never the final authority.
- Normalize LinkedIn URLs by host/path and remove query strings/fragments/trailing slashes; normalize website identity to the registrable host representation used by the import; normalize names by Unicode/case/whitespace/punctuation only, without stripping arbitrary legal words. Conflicting stable identifiers always override a name-only automatic match and require review.
- Treat clean LinkedIn `/in/...` URLs as importable. Sales Navigator or otherwise non-canonical person URLs must be corrected by the SDR or skipped.
- Never accept arbitrary Airtable base/table/field IDs or raw Airtable field maps from the browser. The client submits a typed import DTO; the server constructs the Airtable payload from its own allowlist.

Generalize `frontend/api/import-conversation.ts` to `frontend/api/import.ts` so one Vercel function dispatches:

- the existing admin-protected conversation import;
- contact-import metadata;
- contact preview/matching;
- debounced company search and selected-record validation;
- contact commit.

For the synchronous MVP, enforce the confirmed 5 MB and 500-data-row limits on both client and server. Larger files are rejected with guidance to split the export; a durable background importer is deferred.

## Implementation phases
1. **Consolidate the import API and add Airtable foundation — M**
   - Replace the dedicated conversation function with a generic `/api/import` dispatcher without increasing the top-level Vercel function count.
   - Preserve the current conversation-import behavior and its `ADMIN_SECRET` check.
   - Add restricted Airtable environment configuration, stable table/field ID definitions, schema validation, pagination, throttling, retry/backoff, and typed errors.
   - Add a metadata action that returns only the valid Contact `Added by` choices and importer schema version.
   - Verify independently with schema/metadata reads and the existing manual conversation-import flow.

2. **Build local Apollo parsing, mapping, and validation — M**
   - Add Papa Parse and focused parser/mapping types.
   - Implement Apollo header detection, required-field checks, duplicate/blank header errors, encoding/quote/field-count handling, file/row limits, canonical URL validation, and within-file duplicate detection.
   - Build the CSV Import route, navigation entry, required `Added by` selector, upload drop zone, mapping review, and preview table shell.
   - Add fixture-based unit tests using sanitized Apollo-shaped data, including Sales Navigator URLs and malformed CSVs.

3. **Implement company and Contact resolution preview — L**
   - Build server-side paginated indexes for Companies and Contacts with normalization and duplicate-key detection.
   - Return deterministic match evidence and row states rather than a single opaque score.
   - Add grouped company review and the action modal for human-readable company search, selected-record validation, selection, or skipping; keep direct record-ID handling as troubleshooting-only.
   - Reuse one company decision across all contacts from that company while retaining per-row skip control.
   - Test unique matches, no matches, duplicate Airtable keys, cross-key conflicts, invalid person URLs, existing Contacts, and repeated people within the file.

4. **Implement safe commit and session results — M**
   - Revalidate all mutable assumptions at commit time.
   - Create Contacts using fixed field IDs, existing company record IDs, the selected `Added by`, and `Approve status = New`; omit `Readiness status` and all unsupported Apollo fields.
   - Batch writes by 10, throttle requests, record per-chunk outcomes, and continue safely after partial failures.
   - Keep the result model in page/session state without persisting raw rows or batch history.
   - Build the result summary, row-level status table, failed-row retry, and immediate downloadable result CSV.

5. **Hardening and release verification — M**
   - Exercise the flow against a disposable/small Airtable test batch before production use.
   - Verify that duplicate Contacts remain unchanged, no Companies or select choices are created, and reciprocal Company→Contacts links appear automatically.
   - Verify 429/5xx handling, partial success, double-submit prevention, refresh/navigation warnings, schema drift, stale cache behavior, and a repeated upload of the same file.
   - Run parser/matcher tests, `npm run build`, and the full SPA + API flow with `vercel dev`.
   - Document required Airtable PAT scopes, base restriction, environment variables, the temporary unauthenticated write risk, file limits, and the operator rollback procedure.

## Affected files/modules
- **New:** `frontend/src/pages/CsvImport.tsx`
- **New:** `frontend/src/components/CsvImportStepper.tsx`
- **New:** `frontend/src/components/CsvMappingReview.tsx`
- **New:** `frontend/src/components/CompanyResolutionModal.tsx`
- **New:** `frontend/src/components/CsvImportResults.tsx`
- **New:** `frontend/src/lib/csvImport.ts`
- **New:** `frontend/src/lib/importApi.ts`
- **New:** `frontend/src/lib/csvImport.test.ts`
- **New:** `frontend/api/import.ts` (generic dispatcher replacing `frontend/api/import-conversation.ts`)
- **New:** `frontend/api/_lib/airtable.ts`
- **New:** `frontend/api/_lib/contactImport.ts`
- **Update:** `frontend/src/App.tsx`
- **Update:** `frontend/src/components/Layout.tsx`
- **Update:** `frontend/src/components/ConversationDrawer.tsx`
- **Update:** `frontend/src/components/ImportHistoryPanel.tsx`
- **Update:** `frontend/src/lib/types.ts`
- **Update:** `frontend/src/styles.css`
- **Update:** `frontend/package.json`
- **Update:** `frontend/package-lock.json`
- **Update:** `frontend/vercel.json` if route duration/rewrites require explicit configuration
- **Update:** `README.md`
- **Remove after migration:** `frontend/api/import-conversation.ts`

## Risks & how to verify
- **Unauthenticated Airtable write endpoint:** Until auth is added, anyone who can reach the endpoint may attempt imports. Limit the PAT to this base and required scopes, expose no general Airtable proxy, reject arbitrary field IDs, cap payloads/rows, use `typecast: false`, and document this as a temporary production risk. Verify that crafted payloads cannot select another base/table or write a non-allowlisted field.
- **Wrong company links:** Names are not unique and stable identifiers can conflict. Auto-resolve only one consistent record; otherwise require an explicit user selection. Verify with duplicate-name/domain/LinkedIn fixtures and inspect a production preview before committing.
- **Existing Airtable duplicates:** Duplicate company and person keys already exist. Treat multiple matches as unresolved and do not “pick first.” Verify that each duplicate case opens review or skips rather than importing.
- **Contact duplicates and concurrent imports:** Preflight and commit-time checks prevent normal repeat imports, but Airtable has no uniqueness constraint and two simultaneous serverless commits can still race. Disable client double-submit, recheck immediately before each create chunk, record the limitation, and verify sequential repeat imports create zero additional Contacts.
- **Partial Airtable success:** There is no cross-request transaction. Record outcomes per 10-row chunk, never retry successful rows, and make retries re-run duplicate checks. Verify by forcing a middle chunk to fail and confirming the result/retry does not duplicate earlier rows.
- **Rate limits and timeouts:** A cold preview may require dozens of paginated reads, and a 429 imposes a long wait. Use throttling, short-lived indexes, bounded rows, `maxDuration`, and visible retryable errors. Verify a cold run, cached run, and injected 429/5xx behavior.
- **Schema drift or select pollution:** Renamed fields are safe when IDs remain stable, but deleted/retyped fields are not. Validate IDs/types and valid choices on every cold start/metadata refresh; fail closed. Verify a mocked field-type mismatch and confirm no write occurs.
- **Invalid LinkedIn identities:** Sales Navigator paths cannot reliably become public profile URLs. Require correction or skip. Verify the two supplied non-`/in/` rows never reach commit unchanged.
- **Sensitive source data:** Apollo files contain emails and phone data even though the feature does not use them. Parse locally, send only allowlisted normalized values, never log request bodies, and persist no raw CSV or batch contents. Verify API payload construction, browser result downloads, and server logs contain no ignored email/phone fields.
- **Endpoint consolidation regression:** Moving conversation imports could break the existing manual thread workflow. Preserve the action’s payload/response semantics and admin protection, then smoke-test both import entry points before removing the old function.

## Definition of done
- An SDR must select a live Airtable `Added by` choice before uploading a CSV.
- A valid Apollo people CSV is auto-detected and mapped to the fixed Contact fields, with unsupported columns clearly ignored.
- Ensun/company-only files are rejected as unsupported rather than creating malformed Contacts.
- Every source row receives an explicit preview status, and repeated contacts within the CSV or already in Airtable are skipped and reported.
- A company is automatically linked only when the normalized evidence resolves to one consistent Airtable `Companies` record.
- Missing, ambiguous, duplicate, or conflicting company matches require the SDR to select an existing company or skip the lead; the importer never creates a Company.
- Invalid personal LinkedIn URLs must be corrected or skipped.
- Commit creates only new Airtable Contacts with the canonical person LinkedIn URL, full name, first name, title, one selected Company record ID, selected `Added by`, and `Approve status = New`.
- Existing Contacts are not modified. Email, phone, Apollo IDs, source, and readiness fields are not written.
- Airtable writes use stable field IDs, existing linked-record IDs, batches of at most 10, rate limiting/backoff, and `typecast: false`.
- Partial failures produce accurate created/skipped/failed counts and can be retried without re-creating successful rows.
- Results remain available for the current page/session and can be downloaded immediately; no persistent batch history, raw CSV, or ignored sensitive columns are stored.
- The feature stays within the current Vercel function cap and does not weaken the existing conversation import’s admin protection.
- Normalization/matching/parser fixtures pass, `npm run build` passes, and an end-to-end `vercel dev` smoke test confirms Airtable linking and result reporting.
