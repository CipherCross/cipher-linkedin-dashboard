# Tenant baseline cutover contract v053

Status: **P1-A accepted**

Decision date: 2026-07-29

Source revision: `5adb6f6c7127b1be6da0c6edf6e31c90cf9199c9`

Historical migration range: `001`–`053`

Catalog digest: `sha256:3acf60b2abc36eb9e701c0e92256ac32596986ee284df77117dcd0310227ff4b`

## Decision

`053` is the tenant baseline cutover version.

- The current internal workspace keeps its existing `001`–`053` migration history.
- A new tenant is created from one immutable schema-only artifact named
  `v053`; it does not replay the historical catalog.
- The tenant migration catalog presented to the deployment runner contains the
  `053` baseline artifact plus shared deltas `054+`. Running the repository-root
  `supabase db push` against a tenant is forbidden because it would see `001`–`052`
  as missing.
- Applying the baseline records version `053` once in
  `supabase_migrations.schema_migrations`. Internal and tenant projects then share
  the same ordered delta stream beginning at `054`.
- `054` is reserved for the P1-C private-photo cutover. It must be idempotent:
  the v053 tenant baseline already provisions `lead-photos` as private, while the
  existing internal project still needs to be migrated from public to private.
- Published `v053` files and their manifest are immutable. A changed source schema
  produces a new baseline version; it never rewrites v053.

Supabase's schema squash intentionally omits data-manipulation statements, including
Storage bucket rows. P1-B must therefore review the generated schema dump and add the
approved private bucket metadata explicitly; it must not copy historical DML back into
the baseline. See the
[Supabase CLI migration squash reference](https://supabase.com/docs/reference/cli/supabase-migration-repair#supabase-migration-squash).

## Approved tenant schema inventory

The P1-B artifact must reproduce the final state after migration 053, with the
deliberate Storage differences listed below. All table columns, identity sequences,
defaults, checks, unique constraints, foreign keys, comments and final indexes are
schema and must be preserved even when their historical migration also contained a
backfill.

### Postgres objects

- Extension: `pgcrypto`.
- Dedicated role: `ai_sql_runner` (`NOLOGIN`, no `BYPASSRLS`, no default table
  grants, no access to `instances.config` or Auth identity columns).
- Public tables (25):
  `instances`, `campaigns`, `leads`, `events`, `sync_runs`, `messages`,
  `annotations`, `campaign_steps`, `conversation_coaching`, `coaching_digest`,
  `briefings`, `playbook`, `briefing_jobs`, `team_members`, `lead_notes`,
  `pipeline_events`, `saved_searches`, `icps`, `icp_personas`,
  `icp_industries`, `hypotheses`, `hypothesis_campaigns`, `follow_up_events`,
  `conversation_follow_up_state`, `lead_gender_reviews`.
- Public views (7), all with `security_invoker = true`:
  `campaign_metrics`, `daily_activity`, `campaign_reply_sentiment`,
  `pipeline_metrics`, `campaign_reply_intent`, `conversation_reply_intent`,
  `conversation_latest_message`.
- Public functions (13), preserving the final bodies, owners, search paths and
  execute grants:
  `ai_execute_sql(text)`, `touch_updated_at()`, `leads_keep_milestones()`,
  `pipeline_auto_advance()`, `delete_manual_message(bigint)`,
  `set_hypothesis_campaigns(bigint,text[])`,
  `apply_follow_up_action(text,text,text,text,bigint,uuid,bigint,date,text)`,
  `archive_follow_up_after_last_lead()`, `refresh_lead_age_estimate()`,
  `reset_lead_gender_on_input_change()`, `is_active_team_member()`,
  `is_app_admin()`, and
  `admin_update_team_member(bigint,text,text,boolean)`.
- Triggers (12):
  `leads_keep_milestones`, `touch_leads_updated_at`,
  `touch_campaigns_updated_at`, `touch_messages_updated_at`,
  `touch_saved_searches_updated_at`, `touch_icps_updated_at`,
  `touch_icp_personas_updated_at`, `touch_icp_industries_updated_at`,
  `touch_hypotheses_updated_at`, `refresh_lead_age_estimate`,
  `reset_lead_gender_on_input_change`, and
  `archive_follow_up_on_last_lead_delete`.
- All 25 public tables have RLS enabled and exactly the final read surfaces from
  migrations 051–052:
  one `authenticated` SELECT policy guarded by
  `is_active_team_member()` and one SELECT policy for `ai_sql_runner`.
  `public` and `anon` have no SELECT grant on these tables or the seven views.
- `authenticated` has SELECT on the 25 tables and seven views. `ai_sql_runner`
  has only the analytical grants from migration 052, including column-scoped
  access to `instances` and `team_members`. Service-only functions remain
  executable only by `service_role`; the two Auth helper predicates remain
  executable only by `authenticated`.
- The corrected, NUL-free advisory lock expressions from migration 053 are baked
  directly into `apply_follow_up_action` and
  `archive_follow_up_after_last_lead`. The baseline must not contain migration
  053's introspective `pg_get_functiondef` patch.

Implicit sequences, primary-key indexes, constraint-backed indexes and array/check
constraints belong to the tables above and are included even though they are not
listed as separate top-level objects.

### Storage

- Provision `lead-photos` with `public = false`.
- Do not create an anonymous object-read policy for `lead-photos`.
- Do not provision the `agent` bucket in a tenant project.
- P1-B verifies the private bucket state. P1-C adds authenticated/signed delivery
  and migrates the existing internal project's public bucket.

### Initial data state

The tenant business schema is empty after the baseline.

- No instances, campaigns, leads, events, messages, annotations, briefings, team
  members, ICPs, hypotheses, searches, follow-ups, reviews or pipeline rows.
- No `Web 2 Mob` row, Airtable URL, personas or industries.
- No `notebook-1`, `notebook-1:4`, test-campaign or analysis-campaign marker.
- No singleton `playbook` row. This row is not required for bootstrap:
  reads use `maybeSingle()` and the first admin save performs an upsert.
- The first company admin and time-limited platform support membership are later
  bootstrap operations, not baseline seed data.
- The only allowed DML in the baseline is provider metadata required to create the
  approved private `lead-photos` bucket (and the standard migration-ledger record
  written by the runner).

## Internal-only and historical data inventory

These items are intentionally absent from every tenant baseline:

- Internal reusable seed:
  the `Web 2 Mob` ICP, its Airtable URL, three personas and the final 23-industry
  taxonomy. P1-B moves the final post-045 representation to
  `supabase/seeds/internal/`; the tenant operations runner must have no code path
  that applies it.
- Internal infrastructure:
  the private `agent` update bucket from migration 004. Agent releases move to the
  owner-controlled update plane and are not stored in tenant projects.
- Internal cleanups:
  stale milestone events from 002 and the hard-coded `notebook-1:4` campaign
  removals from 037–038.
- Historical repairs/backfills:
  message deduplication and classification preservation (015), message content
  hash population/deduplication (017), old instance playbook cleanup (022),
  `leads.added_at` population (025), event deduplication (035), old reply
  notification stamping (036), and demographics lifecycle backfills (048).
- Superseded transitions:
  `instances.weekly_invite_target`, legacy anonymous read policies, intermediate
  `campaign_metrics` and function definitions, the `ai_readonly` role and its
  grants, old message/event unique keys, old briefing keys, old ICP keyword
  columns, and migration 053's runtime function-rewrite block.
- The empty playbook insert from 022 is omitted as unnecessary bootstrap data.

Historical repairs are not moved to the internal seed package: they have already
served their one-time purpose in the internal workspace and must not run on a clean
database.

## Migration-by-migration audit

Legend:

- **Materialize** — preserve the final schema effect in v053.
- **Materialize final only** — preserve only the resulting definition, not the
  superseded transition or data repair.
- **Internal seed** — extract to the internal-only seed artifact.
- **Exclude** — do not include in either tenant baseline or reusable seed.

| Version | Baseline action | Audit result |
|---|---|---|
| 001 | Materialize final only | Base extension, tables and views; replace old anonymous policies and superseded view definitions with final state. |
| 002 | Exclude | One-time stale-event cleanup originating from the internal notebook. |
| 003 | Materialize | Instance account identity columns. |
| 004 | Exclude | Internal `agent` Storage bucket. |
| 005 | Materialize final only | `messages` and `annotations`; omit transient weekly target and old policies. |
| 006 | Exclude | Historical removal of the transient weekly target. |
| 007 | Materialize final only | `campaign_steps`; use final authenticated/AI policies. |
| 008 | Exclude | Superseded `ai_readonly` role/function state. |
| 009 | Exclude | Superseded AI SQL function body. |
| 010 | Exclude | Superseded invoker/role-drop implementation. |
| 011 | Exclude | Superseded AI SQL function body. |
| 012 | Materialize | Reply-classification columns, index and sentiment view. |
| 013 | Materialize | Remote instance config columns. |
| 014 | Materialize | Coaching tables and final read policies. |
| 015 | Exclude | Existing-message cleanup only. |
| 016 | Materialize | Briefings table and index, with final key shape from 049. |
| 017 | Materialize final only | Final `content_hash` column and message identity; omit update/delete repair. |
| 018 | Materialize final only | Final validated message foreign keys. |
| 019 | Exclude | Intermediate `campaign_metrics` definition superseded by 030/049. |
| 020 | Materialize | Final annotation scope uniqueness. |
| 021 | Materialize final only | `ai_sql_runner` boundary and function ownership; use hardened 034/052 end state. |
| 022 | Materialize final only | `playbook` table; omit singleton insert and old config cleanup. |
| 023 | Materialize | Briefing changes column. |
| 024 | Materialize final only | Briefing jobs table; use final composite key from 049. |
| 025 | Materialize final only | `leads.added_at` and index; omit historical backfill. |
| 026 | Materialize final only | Manual-message source schema and milestone trigger; use final 039 trigger body. |
| 027 | Materialize final only | Team/pipeline schema; use final stage check and Auth fields. |
| 028 | Materialize final only | Keep `pipeline_metrics`; function body is superseded by 039. |
| 029 | Materialize | Briefing metrics column. |
| 030 | Exclude | Intermediate `campaign_metrics` definition superseded by 049. |
| 031 | Materialize | Change-aware timestamps and triggers. |
| 032 | Materialize | Supporting indexes and validated FK end state. |
| 033 | Exclude | Intermediate pipeline function superseded by 039. |
| 034 | Materialize final only | Final bounded AI SQL guard, least-privilege role and explicit grants; omit legacy-role cleanup block. |
| 035 | Materialize final only | Four-column event identity; omit existing-row deduplication. |
| 036 | Materialize final only | Notification column and partial index; omit historic notification stamping. |
| 037 | Exclude | Hard-coded internal analysis-campaign cleanup. |
| 038 | Exclude | Repeat of the hard-coded internal cleanup. |
| 039 | Materialize | Final pipeline/milestone/delete-manual-message functions and stage check. |
| 040 | Materialize | Saved-search schema and trigger. |
| 041 | Materialize final only | Lead demographics columns as subsequently extended by 048. |
| 042 | Materialize final only | Lead photo columns; replace the public bucket insert with approved private bucket metadata. |
| 043 | Materialize + Internal seed | ICP/hypothesis schema and service function are schema; `Web 2 Mob` rows are internal-only. |
| 044 | Materialize final only | Final keyword scope: omit the removed columns rather than replaying drops. |
| 045 | Internal seed | Merge the final 23-industry taxonomy into the internal `Web 2 Mob` seed. |
| 046 | Materialize final only | Follow-up tables/view/functions/trigger, with the corrected 053 lock expressions. |
| 047 | Materialize | Intent columns, index and intent views. |
| 048 | Materialize final only | Demographic lifecycle columns/functions/triggers/review table/index; omit both lead backfills. |
| 049 | Materialize | Final campaign metrics and daily/weekly briefing schema. |
| 050 | Materialize | Auth identity fields, helper/admin functions and grants. |
| 051 | Materialize final only | Authenticated table/view RLS and grants, merged with 052 AI access. |
| 052 | Materialize | Final AI policies and column-scoped analytical grants. |
| 053 | Materialize final only | Bake corrected function bodies directly; omit introspective patch DDL. |

## P1-B acceptance inputs

P1-B may begin only from this contract and must produce:

1. `supabase/tenant-baseline/v053/` with immutable SQL plus a manifest containing
   source revision, cutover version and checksums.
2. A tenant migration set that exposes only baseline `053` plus shared `054+`
   deltas to the deployment runner.
3. `supabase/seeds/internal/` containing the final `Web 2 Mob` seed, never referenced
   by tenant provisioning.
4. Clean-room tests proving:
   empty database → v053 → all available `054+` deltas; no internal markers or
   business rows; exact table/view/function/trigger inventory; RLS and grants;
   `SECURITY DEFINER` owners/search paths; private `lead-photos`; no `agent` bucket;
   and a correct `053` migration-ledger entry.

The linked internal project's live migration ledger was not queried during P1-A
because no Supabase access token was available. Before publishing v053, P1-B must
verify read-only that internal schema history includes `001`–`053` and has no
untracked remote schema drift.
