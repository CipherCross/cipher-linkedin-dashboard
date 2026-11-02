# CSV import: Team stats tab

## Status (2026-11-02)

Implemented on `main` (not pushed, not deployed). Delete this file once it ships.

Still open:
- Not run against a live base. The formula (`IS_AFTER`/`IS_BEFORE` on `CREATED_TIME()` with
  `DATETIME_PARSE` of an ISO instant) is checked only by the fake Airtable; the server's exact
  `createdTime` re-check makes an over-match harmless, but an under-match would not be caught.
  First run: compare one person's day against an Airtable view filtered the same way.
- `Companies.Added by` (`fld1EGZGzOsuj4qkP`) was not type-checked by any importer before; the
  stats read accepts a string, `{ name }` or a list of either.
- Visual check ran in a throwaway Vite harness with a fake `importApi` (the UI fixture server
  needs the Vercel CLI, which is not installed here), at 1440×900 and 1280×720.

## Goal

A third tab on CSV import (`#/csv-import`), **Team stats**, beside "Companies → DB" and
"Leads → Contacts". For one Airtable base and a period it shows who added how many
companies and leads and how many of them are approved, per person and per day, with an
explicit zero on days a person uploaded nothing. An **All bases** view sums the same
numbers over every configured base.

## Non-goals

- Any write: nothing goes to Airtable or Neon. No ledger step, table or row.
- A separate approval date. Approval is read from the current status; the record's
  creation time is the only date.
- A new serverless function (the deployment is at Vercel Hobby's 12).
- Any change to the importers (`companyImport.ts`, `contactImport.ts`) or the coach.

## The four blocks

Every block reads records **created** in the period (`CREATED_TIME()` / `createdTime`,
UTC), grouped by the record's `Added by` and its **current** status.

| Block | Table | Status field | Added by |
| --- | --- | --- | --- |
| Company additions | DB `AIRTABLE_IDS.dbTable` | `db.initialStatus` | `db.addedBy` |
| Company approvals | Companies `AIRTABLE_IDS.companiesTable` (a row lands here when an automation copies an approved DB row, so its creation ≈ the approval) | `companies.approveStatus` | `companies.addedBy` |
| Lead additions | Contacts `AIRTABLE_IDS.contactsTable` | `contacts.approveStatus` | `contacts.addedBy` |
| Lead approvals | the same Contacts records | `contacts.approveStatus` | `contacts.addedBy` |

Columns in every block: **All / New / Approve / Reject**. The day (or week) cells show one
of those; the default is All for the three addition-like blocks and Approve for Lead
approvals, and each block can switch it.

## Status mapping

One constant, `STATUS_GROUPS` in `frontend/api/_lib/importStats.ts`:

- Approve ← `Approve`, `Approved`, `Manual approve`
- Reject ← `Reject`, plus anything `isRejected` accepts (`Rejected`)
- Excluded ← `Old` — filtered out in the Airtable formula and again on the server;
  never counted, not even in All
- New ← `New`, `Manual review`, blank, and every unknown value

`Approved` / `Rejected` are added because Companies and Contacts spell their statuses
that way (see `CompanyRecord.approveStatus` and the fixture schema); without them every
approved company would count as New. Matching is case-insensitive and trimmed.

All = New + Approve + Reject. The response also lists each table's live status choices
with the group each maps to, so the tab can show what counts where.

## People

Rows = the table's `Added by` choices from the live schema (`choicesOf` +
`importAddedByChoices`), so a person with no uploads is a row of zeros; plus any other
value actually found on a record (a non-person choice such as `AI`, so no record is
dropped); plus **Not set** for records with an empty `Added by`. Records added by hand in
Airtable count like any other.

## Period

- `teamStatsRanges(now)` in `src/lib/leads.ts`, beside `presetRanges` (unchanged):
  Today, Yesterday, This week, Last week, Past 14 days, This month, Last month,
  Past 30 days. UTC days; weeks start Monday (`weekStart`).
- Custom through `DateRangePicker`, which gains an optional `maxDays` prop that disables
  calendar days beyond 92 from the first click.
- ≤ 31 days → day columns; longer → week columns (Monday-based, clipped to the range).
- The server refuses > 92 days, malformed dates and `from > to` with a 400.

## Server: `import_stats` on `/api/import`

- New action set `STATS_ACTIONS = {'import_stats'}` in `api/import.ts`, behind the same
  admin guard as the CSV actions; `base` through `baseOf`.
- `api/_lib/importStats.ts`:
  - Unset base env (`airtableConfigured(base)` in `airtable.ts`) → `200 {configured:false}`;
    nothing is fetched.
  - Schema (cached 5 min per base): the three tables must exist with their status and
    Added by fields, else 503 schema mismatch.
  - Per table, one `findRecordsByFormula` query:
    `AND(IS_AFTER(CREATED_TIME(), DATETIME_PARSE(from − 1 day)), IS_BEFORE(CREATED_TIME(),
    DATETIME_PARSE(to + 2 days)), LOWER(TRIM({status}&"")) != "old")`, fields = Added by +
    status only. The formula over-matches by a day either side on purpose; the exact
    `[from 00:00Z, to+1 00:00Z)` comparison runs on `createdTime` in code, as the DB
    domain lookup does.
  - Page budget: `findRecordsByFormula` gains an optional `maxPages`; stats passes 50
    (5,000 records per table) and turns the overrun into a 422 naming the table and
    asking for a shorter period. Three tables × 50 pages at the 225 ms gap ≈ 34 s, inside
    `maxDuration` 60.
  - Cache per (base, table, from, to) for 5 min (`CACHE_MS`); `force: true` bypasses it.
  - Response: `{ ok, base, configured, from, to, fetchedAt, tables: {db|companies|contacts:
    { people, statuses }}, buckets: [{ table, day, addedBy, group, count }] }` — non-zero
    buckets only; `addedBy: ''` is Not set.

## Client

- `src/lib/teamStats.ts`: response types, `teamStatsColumns` (days or weeks), the four
  block definitions, and the aggregation (per person × column, totals, summing several
  bases for All bases).
- `importApi.ts`: `fetchImportStats(base, from, to, { force })`.
- `src/pages/CsvImportStats.tsx`: one `TeamStats` instance, mounted the first time the tab
  opens and kept mounted. It follows the header base switch; a scope control switches
  between that base and **All bases**. All bases loads each base with its own request,
  one after another (selected base first), so two bases never share one 60 s budget or one
  process's rate gate. A not-configured base is an `EmptyState`; in All bases it is named
  in a notice as not included, as is a base that failed.
- Layout: toolbar (scope, period, refresh), KPI tiles (companies added, companies
  approved, leads added, leads approved), then one `Panel` per block with a
  `TableFrame`/`Table` modelled on `LeadUploadTracker`: person × column, zeros shown as a
  muted `0`, totals columns All/New/Approve/Reject, and an "All people" footer.

## Tests

- `tests/importStats.test.ts` (fake Airtable): date filter incl. boundaries, status
  mapping (unknown → New, Old excluded everywhere), zero rows, Not set, non-person
  Added by, not-configured base, unknown base 400, range > 92 days / malformed 400,
  page budget 422, cache and `force`, no writes and only formula-scoped reads.
- `tests/importRoute.test.ts`: `import_stats` refused unauthenticated; a member gets 403.
- `tests/teamStats.test.ts`: presets (week and month edges, month/year rollover, UTC),
  columns (days vs weeks), aggregation and base summing.
- `tests/csvImportStats.test.tsx`: the tab renders zero rows, switches scope, shows a
  not-configured base, and the custom range cap.

## Checks

`npm run build`, `npm run typecheck:api`, `npm test`, `npm run ui:inventory`; visual check
in the local fixture preview if it can serve fake stats.
