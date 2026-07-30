# Neon migration source measurements

Status: **S01 source baseline complete**

## Measurement identity

- Measurement date: `2026-07-30`
- Full snapshot timestamp: `2026-07-30T13:08:22.352649Z`
- Source environment: current internal Supabase workspace, database
  `postgres`; project identifier, region and credentials were not collected.
- Source Git base: `93eb9d8d640548fc40151443f60044c5ef58b786`
- Measurement scope: read-only database, Storage metadata, extension,
  migration-ledger and cumulative write statistics.

No password, JWT, API key, connection string, private object URL, user email,
message body, lead record or object key was collected or persisted.

## Measurement method

The owner ran the single read-only statement in
[`neon-migration-source-measurements-queries.sql`](./neon-migration-source-measurements-queries.sql)
in the Supabase SQL Editor. The query returns one aggregate JSON document and
does not call application RPCs or execute DDL/DML.

Two cumulative `pg_stat_database` observations are available:

- Snapshot A is the owner-provided SQL result screenshot. Its query output did
  not include a capture timestamp, so `2026-07-30T12:59:35Z` is an approximate
  timestamp derived from the screenshot filename in Europe/Madrid (`UTC+02`).
- Snapshot B is the complete aggregate JSON result with the database-provided
  timestamp `2026-07-30T13:08:22.352649Z`.

Only Snapshot B contains database size, table size/count, time-profile and
Storage measurements. Therefore write-counter deltas are available, but
physical byte growth and exact live-row growth between snapshots remain
unknown.

## Database summary

| Measurement | Result |
|---|---:|
| PostgreSQL | `17.6` |
| Database size | `29,224,083 bytes` (`28 MB` as reported by PostgreSQL) |
| Public table+index relation total | `15,851,520 bytes` |
| Applied migration range | contiguous `001`–`054` |
| Applied migration count | `54` |
| Current migration version | `054` |

The database and Storage object bytes together are approximately
`47,583,186 bytes` (`47.6 MB` decimal). This is only a transfer-planning sum:
database size includes catalogs and Storage metadata, while Storage size is the
sum of object bytes from `storage.objects.metadata`.

## Top-table summary

Sizes include the table and its indexes.

| Public table | Exact rows | Table bytes | Index bytes | Total bytes | Share of public relation total |
|---|---:|---:|---:|---:|---:|
| `messages` | 5,840 | 2,662,400 | 2,580,480 | 5,242,880 | 33.1% |
| `leads` | 3,455 | 2,301,952 | 2,883,584 | 5,185,536 | 32.7% |
| `events` | 4,520 | 761,856 | 1,204,224 | 1,966,080 | 12.4% |
| `sync_runs` | 8,702 | 843,776 | 327,680 | 1,171,456 | 7.4% |

Together these four relations use `13,565,952 bytes`, or approximately `85.6%`
of the measured public table+index footprint. No other public relation exceeds
`500 kB`.

## Critical row counts

The current v053/v054 public business inventory contains 25 tables. The source
schema does not contain a table named `conversation_follow_ups`; its durable
data is represented by `conversation_follow_up_state` and
`follow_up_events`.

| Table | Exact rows | Table | Exact rows |
|---|---:|---|---:|
| `instances` | 4 | `campaigns` | 14 |
| `leads` | 3,455 | `messages` | 5,840 |
| `events` | 4,520 | `annotations` | 0 |
| `team_members` | 4 | `sync_runs` | 8,702 |
| `campaign_steps` | 240 | `conversation_coaching` | 21 |
| `coaching_digest` | 1 | `briefings` | 38 |
| `briefing_jobs` | 30 | `playbook` | 1 |
| `lead_notes` | 42 | `pipeline_events` | 433 |
| `saved_searches` | 0 | `icps` | 1 |
| `icp_personas` | 3 | `icp_industries` | 23 |
| `hypotheses` | 1 | `hypothesis_campaigns` | 8 |
| `follow_up_events` | 18 | `conversation_follow_up_state` | 10 |
| `lead_gender_reviews` | 17 |  |  |

## Time-window profile

These are row timestamps, not measured physical storage growth. A row may have
been backfilled or updated after its timestamp.

| Table / timestamp | Minimum | Maximum | Last 7 d | Last 30 d | Last 90 d |
|---|---|---|---:|---:|---:|
| `leads.added_at` | `2023-05-23T21:00:00Z` | `2026-07-29T16:49:47.154Z` | 277 | 1,067 | 2,231 |
| `messages.sent_at` | `2025-10-16T21:50:31.158Z` | `2026-07-30T11:05:02.781Z` | 438 | 1,676 | 3,856 |
| `events.occurred_at` | `2023-05-23T21:00:00Z` | `2026-07-30T07:14:28.763Z` | 380 | 1,394 | 2,978 |
| `sync_runs.started_at` | `2026-06-10T15:22:21.383376Z` | `2026-07-30T12:52:40.908871Z` | 1,348 | 5,628 | 8,702 |
| `pipeline_events.occurred_at` | `2026-07-09T11:50:45.221727Z` | `2026-07-30T11:23:28.948579Z` | 52 | 433 | 433 |
| `follow_up_events.occurred_at` | `2026-07-28T08:34:49.647581Z` | `2026-07-30T11:24:48.757048Z` | 18 | 18 | 18 |
| `lead_notes.created_at` | `2026-07-09T11:55:07.642413Z` | `2026-07-13T11:45:12.094423Z` | 0 | 42 | 42 |
| `briefings.created_at` | `2026-06-24T09:37:42.038566Z` | `2026-07-30T08:31:19.956Z` | 8 | 31 | 38 |
| `campaigns.created_at` | `2026-06-10T15:22:21.603491Z` | `2026-07-30T11:49:41.710647Z` | 3 | 6 | 14 |
| `annotations.created_at` | — | — | 0 | 0 | 0 |

For volume context, the last-seven-day averages are approximately 39.6 leads,
62.6 messages and 54.3 events per day. These rolling values help size future
ingest but do not replace a longer pair of full size/count snapshots.

## Storage summary

| Bucket | Object count | Object bytes | Provider display |
|---|---:|---:|---:|
| `agent` | 1 | 76,296 | 75 kB |
| `lead-photos` | 601 | 18,282,807 | 17 MB |
| **Total** | **602** | **18,359,103** | **18 MB** |

Validation passed:

- bucket object counts: `1 + 601 = 602`;
- bucket object bytes: `76,296 + 18,282,807 = 18,359,103`;
- both sums exactly match the separately reported Storage totals.

The database dump will not contain these object bytes. `lead-photos` requires a
separate object-copy and checksum procedure. The `agent` release object belongs
to the owner-controlled release path and is not tenant business data.

## Extension inventory

| Extension | Version | Source schema | Portability action |
|---|---|---|---|
| `pgcrypto` | `1.3` | `extensions` | Required by the business baseline for `gen_random_uuid()`; verify on Neon. |
| `plpgsql` | `1.0` | `pg_catalog` | Core procedural language; expected, but confirm in rehearsal. |
| `pg_stat_statements` | `1.11` | `extensions` | Operational only; verify availability/configuration separately from schema restore. |
| `uuid-ossp` | `1.1` | `extensions` | Installed, but no repository baseline usage was found; confirm before excluding. |
| `supabase_vault` | `0.3.1` | `vault` | Supabase-specific; do not assume portability or restore it into the business baseline. Verify that no live dependency/data is needed. |

Only `pgcrypto` is declared by the current tenant business baseline. Extension
availability and ownership must still be tested on the selected Neon tier.

## Write-profile snapshots

Both snapshots have `stats_reset =
2026-05-22T15:13:20.515541Z`, so their cumulative counter deltas are comparable.
The interval is approximately `527 seconds` (`8 min 47 sec`).

| Counter | Snapshot A | Snapshot B | Delta | Approx. per minute |
|---|---:|---:|---:|---:|
| `xact_commit` | 2,955,233 | 2,957,544 | +2,311 | 262.9 |
| `tup_inserted` | 261,946 | 262,101 | +155 | 17.6 |
| `tup_updated` | 24,607,394 | 24,622,890 | +15,496 | 1,763.1 |
| `tup_deleted` | 230,286 | 230,436 | +150 | 17.1 |

Snapshot B additionally reports:

- `xact_rollback = 3,489`;
- `conflicts = 0`;
- `deadlocks = 0`;
- `temp_files = 5,032`;
- `temp_bytes = 9,836,904,792`.

Interpretation:

- the short interval captured substantial update churn, consistent with an
  active sync/background-work period;
- these counters cover the whole database and count tuple operations, including
  repeated updates; they are not equivalent to new business rows or byte growth;
- inserted minus deleted counter delta is `+5`, but it must not be treated as an
  exact live-row delta;
- because Snapshot A lacks full table/Storage sizes and exact counts, growth in
  bytes per hour/day remains **unknown**. A longer pair of full snapshots should
  be captured before the cutover rehearsal if capacity forecasting is needed.

## Preliminary cutover assessment

`pg_dump`/`pg_restore` remains the default strategy:

- the source database is only `29.2 MB` and the separately copied Storage
  payload is `18.4 MB`;
- the largest public relations are about `5.2 MB` each;
- there are only 602 Storage objects;
- no measured size alone justifies logical replication.

Preliminary planning ranges, not an SLA:

- database-only dump, transfer and restore: **5–15 minutes**;
- first rehearsal slot including extension/ownership fixes and reconciliation:
  **30–60 minutes**;
- provisional full production maintenance window including write freeze,
  database restore, object copy, verification, environment switch and initial
  agent catch-up: **60–90 minutes**.

Actual timings must replace these ranges after a disposable-environment
rehearsal. Logical replication remains a fallback if rehearsal cannot fit the
owner-approved downtime window; it must not be selected from size alone.

## Unknowns before rehearsal

- compressed dump size and measured dump/restore throughput;
- selected Neon region/tier, connection path and extension catalog;
- extension ownership/grant differences and removal of Supabase-specific
  `supabase_vault`;
- long-interval physical database and Storage growth;
- object-copy throughput and per-object checksums;
- portable handling of `auth.*`, `storage.*`, Supabase roles and migration
  ledger during the later schema sessions;
- lock/freeze duration, final reconciliation time and sync-agent catch-up time;
- owner-approved downtime window, RPO and RTO.

## Read-only query reference

Canonical query:
[`docs/platform-ops/neon-migration-source-measurements-queries.sql`](./neon-migration-source-measurements-queries.sql).

The query was successfully executed against the source Supabase workspace. Its
top-level statement is `WITH … SELECT`; all relation access is read-only.
