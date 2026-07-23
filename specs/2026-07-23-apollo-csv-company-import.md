# Apollo CSV Company Import

## Goal
Extend the existing Airtable CSV importer so an SDR can choose whether an Apollo export contains Leads / Contacts or Companies. Company imports will create new records directly in Airtable’s `Companies` table, attach the selected `Added by` value, and give every new Company `Approve Status = New`.

The flow must prevent accidental duplicate Companies, surface uncertain matches for an SDR decision, and report every skipped or failed row without changing the Airtable schema.

## Non-goals
- Updating or enriching Companies that already exist in Airtable.
- Creating new Airtable fields for Apollo IDs or other source-only columns.
- Importing Ensun company exports.
- Writing to the Airtable `DB` staging table.
- Writing automation-owned, linked, AI-generated, campaign, hypothesis, outreach, timestamp, or Web App fields.
- Adding authentication or changing the deliberately deferred-auth posture.
- Persisting import history outside the downloadable immediate results report.

## Research findings
- The current page is a Contact-only wizard backed by Papa Parse, fixed Apollo mappings, `/api/import`, and a narrow server-side Airtable adapter. The adapter already provides schema validation, pagination, fixed field IDs, `typecast: false`, throttling/backoff, and ten-record write batches.
- The project already uses all 12 top-level Vercel functions, so Company actions must extend the existing `/api/import` dispatcher.
- The supplied Apollo Accounts export contains 14 valid rows and these 12 headers: `Company Name`, `Company Name for Emails`, `# Employees`, `Industry`, `Website`, `Company Linkedin Url`, `Company Country`, `Keywords`, `Apollo Record Id`, `Short Description`, `Founded Year`, and `Subsidiary of (Organization ID)`.
- The direct writable mapping is:
  - `Company Name` → `Company name`
  - `Company Name for Emails` → `Company name for mailing`
  - `Website` → `Website URL`
  - `Company Linkedin Url` → `LinkedIn URL`
  - `Company Country` → `HQ country`
  - `Founded Year` → `Founded year`
  - `# Employees` → `Employees`
  - `Industry` → `Industry`
  - `Keywords` → `Keywords`
  - `Short Description` → `Description`
- `Apollo Record Id` and `Subsidiary of (Organization ID)` have no destination in `Companies` and must be ignored.
- Keywords and descriptions can exceed the Contact importer’s generic 1,000-character validation limit. Company validation therefore needs field-specific bounds and request-size protection.
- Airtable contains duplicate normalized name, domain, and LinkedIn keys, so no single Companies field is a database-enforced unique identifier.
- Stable duplicate detection can reuse normalized company LinkedIn paths and website domains. A unique name-only match is weaker and needs an SDR decision. Conflicting or ambiguous stable identifiers must never silently select a record.
- All 14 companies in the supplied sample already exist in Airtable by both domain and LinkedIn, so the approved skip-and-report policy would create zero records from this particular file.
- Airtable limits create batches to ten records and requests to five per second per base. Retry after an uncertain response must rebuild the duplicate index before creating again.

## Decisions
- Existing Company match: skip the uploaded row and include it in the results report; do not update the existing record.
- Automatic matching: a unique company LinkedIn or website-domain match is an existing duplicate and is skipped.
- Name-only match: require the SDR to choose the existing Company or confirm creation as a new Company.
- Identifier conflict or ambiguity: require the SDR to choose one of the matching Companies or skip the row.
- New records: write directly to `Companies` with `Approve Status = New`.
- Attribution: require one import-wide `Added by` selection and write it to every newly created Company.
- Field scope: import every compatible field available in the existing `Companies` schema and leave unmapped/automation-owned fields untouched.
- Apollo identifiers: discard `Apollo Record Id` and `Subsidiary of (Organization ID)`; do not alter the Airtable schema.
- Duplicate rows within the same file: keep the first valid row eligible and skip/report subsequent rows with the same stable identity.
- Import result: show created, duplicate, skipped, invalid, and failed counts immediately and provide a downloadable row-level CSV report.

## Approach
Keep a single CSV Import page and add a first-step import-type selector for `Leads / Contacts` or `Companies`. The selected type controls file recognition, source-to-target mappings, copy, progress labels, preview behavior, commit payloads, and result reporting while reusing the current layout and upload limits.

Add an Apollo Accounts parser/mapping beside the existing Apollo People parser. Company rows will be normalized into a dedicated typed structure. Numeric fields will be parsed strictly as optional integers, blank values will be omitted, company LinkedIn URLs will be canonicalized, and long Keywords/Description fields will receive bounds compatible with Airtable and the endpoint body limit.

Extend the fixed Airtable ID map and schema validation for the compatible Companies fields. A new server helper will expose Company metadata, preview, and commit actions through `/api/import`. Preview will build complete indexes for normalized LinkedIn, domain, and name values and classify each row as ready, duplicate-existing, duplicate-in-file, needs-decision, invalid, or identifier-conflict.

Stable LinkedIn/domain matches are automatically skipped as existing. Name-only and conflicting/ambiguous matches are grouped for review. For a name-only match, the user can choose the existing Company, create the uploaded Company as new, or skip it. For conflicting or ambiguous identifiers, the user can select an existing Company or skip; selecting an existing record means the uploaded row is reported as skipped/duplicate because existing records are never updated.

Commit accepts only approved new-company rows and a current `Added by` choice. It revalidates the live schema, refreshes all Company identity indexes, rechecks file duplicates and Airtable duplicates, and creates only still-safe rows in batches of ten. After each batch, newly created records are added to the in-memory index so later rows cannot duplicate them. Empty source values are omitted rather than sent, and caller-supplied field IDs are never accepted.

## Implementation phases
1. **S — Shared contract and parsing:** add the import-type model, Apollo Accounts header recognition, fixed Company mapping, Company row construction, field-specific validation, and company result export.
2. **M — Airtable Company service:** extend fixed field IDs/schema checks and add Company metadata, preview, matching classification, review data, commit-time rechecks, batched creates, and structured outcomes.
3. **M — Company workflow UI:** add import-type selection, type-specific upload/mapping copy, Company preview, duplicate/decision review, commit controls, and Company results while leaving Contact behavior unchanged.
4. **M — Automated and manual verification:** cover parsing, numeric/long-text behavior, duplicate classification, decisions, commit field allowlisting, partial failures, result export, API typing, and the production frontend build.

## Affected files/modules
- `frontend/src/pages/CsvImport.tsx`
- `frontend/src/lib/csvImport.ts`
- `frontend/src/lib/importApi.ts`
- `frontend/src/components/CompanyResolutionModal.tsx` or a new Company-import decision component
- `frontend/src/styles.css`
- `frontend/api/import.ts`
- `frontend/api/_lib/airtable.ts`
- New `frontend/api/_lib/companyImport.ts`
- `frontend/tests/csvImport.test.ts`
- New Company importer API tests under `frontend/tests/`
- `frontend/.env.example` only if current Airtable scope documentation needs clarification

## Risks & how to verify
- **False duplicate or false creation:** test LinkedIn-only, domain-only, agreement, disagreement, duplicate-key, name-only, and no-match cases. Confirm only stable unique matches auto-skip and every weak/conflicting case requires a decision.
- **Existing records overwritten:** verify the Company path only calls create, never update, and duplicate outcomes retain existing Airtable record IDs for reporting.
- **Schema drift or field pollution:** verify the server fails closed when field types or the `New`/`Added by` choices change and always writes with `typecast: false`.
- **Long text/body overflow:** test sample-length keywords/descriptions, enforce per-field and total serialized-payload limits, and show a clear split-file error rather than an opaque HTTP failure.
- **Partial or uncertain Airtable writes:** simulate batch failures, verify successful rows retain their IDs, failed rows are retryable, and retry performs a fresh duplicate lookup before another create.
- **Contact regression:** rerun all existing Contact parser, matching, and commit tests plus the production build.
- **Real sample behavior:** preview the supplied 14-row export against live Airtable and confirm all current matches are skipped and reported without writes.

## Definition of done
- The CSV Import page requires the SDR to select `Leads / Contacts` or `Companies`.
- The existing Apollo People → Contacts workflow still behaves as before.
- Apollo Accounts exports are recognized and mapped to every compatible existing Companies field.
- `Added by` is required and every newly created Company receives the selected value and `Approve Status = New`.
- Existing LinkedIn/domain matches and duplicate file rows are skipped and reported.
- Name-only matches require an explicit create-existing/skip decision; ambiguous or conflicting identifiers require select-existing/skip.
- The importer never updates existing Companies, creates schema fields, writes Apollo IDs, or writes automation-owned fields.
- Commit rechecks duplicates against fresh Airtable data and batches creates safely.
- Results include row-level statuses, details, and Airtable record IDs and can be downloaded as CSV.
- Unit/API tests pass, the frontend production build succeeds, and the supplied sample previews with zero new records against the current Airtable base.
