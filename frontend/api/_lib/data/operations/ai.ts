/**
 * The AI store's operation vocabulary — everything the `app_system` path may
 * ask the database for, and nothing else.
 *
 * This registry is deliberately **not** the application registry and is never
 * merged into it: the two are authorized by different principals. The
 * application registry runs as `app_runtime` under actor-scoped policies; this
 * one runs as `app_system`.
 *
 * ## What `app_system` can reach, corrected for step 007
 *
 * This file used to say that `app_system` held no table grant at all and that
 * `EXECUTE` on the guard was its whole capability. That was true when it was
 * written and it is no longer true. Ledger step 007
 * (`postgres/tenant-baseline/v1/007_ai_system_write_path.sql`) is applied, and
 * it gave the role `SELECT, INSERT, UPDATE` — never `DELETE` — on exactly five
 * relations (`briefing_jobs`, `briefings`, `messages`, `leads`,
 * `saved_searches`), each behind a `FOR ALL TO app_system` policy that opens
 * only when the published `app.actor_id` is the nil uuid. So the shape is now
 * two-part, and the split follows the grant graph:
 *
 * - **The guard, for reads.** Arbitrary investigation and every fixed query in
 *   *this* file still go through `public.ai_execute_sql`, the `SECURITY
 *   DEFINER` step-`003` function owned by the NOLOGIN, SELECT-only
 *   `app_ai_runner`. It remains the only way to read a relation outside those
 *   five — `campaigns`, `instances`, `hypotheses` and the rest are still
 *   invisible to a direct `app_system` statement — and it is still SELECT-only,
 *   1000 rows, 10 seconds. Step 007 loosened nothing about it.
 * - **A narrow, named DML surface, for the server-owned jobs.** The endpoints
 *   with no human actor — the reply notifier, the machine-authenticated library
 *   write — need to change rows, and a SELECT-only guard cannot express that.
 *   Those statements live in `aiSystem.ts` and are composed into this registry
 *   by `buildAiRegistry` below, so `getAiDataStore()` serves both halves from
 *   one store. They are named one-per-statement exactly like every other
 *   operation; nothing generic writes.
 *
 * ## The two kinds of entry in this file
 *
 * Everything registered *here* is still one call to the guard; what varies is
 * the SQL text passed to it as a bound parameter.
 *
 * - `ai.executeSql`, the generic one. Its parameter is arbitrary SQL, and that
 *   is compatible with an allowlist only because of what the grant graph makes
 *   true: whatever the parameter contains, it can reach exactly the guard's
 *   bounded capability and nothing else — one SELECT/WITH statement, 1000 rows,
 *   10 seconds, the sandbox role's column-scoped reads. The blast radius is a
 *   property of the grants, identical for every possible parameter value. The
 *   chat copilot's model-authored queries and the briefing's server-composed
 *   seed queries go through it.
 * - One entry per fixed query the application itself authors. Each is the same
 *   guard call with SQL text this file owns, registered under its own name so
 *   the allowlist records each fixed query as its own reviewed entry — the same
 *   discipline S14 applied when nineteen fixed statements replaced two generic
 *   helpers. The text lives here, in the adapter, in exactly one place; the AI
 *   layer's Supabase branch imports it from here so the two providers cannot
 *   drift on it.
 */

import { NeonOperationRegistry, type NeonRow } from '../neon.js'
import type { DataStoreParams } from '../contracts.js'
import { registerSystemOperations } from './aiSystem.js'

export const AI_OPERATIONS = {
  executeSql: 'ai.executeSql',
  weeklyFunnel: 'ai.weeklyFunnel',
  campaignOverview: 'ai.campaignOverview',
  pipelineOverview: 'ai.pipelineOverview',
  hypothesisOverview: 'ai.hypothesisOverview',
  acceptLag: 'ai.acceptLag',
  inviteQueue: 'ai.inviteQueue',
  weeklyFunnelByAccount: 'ai.weeklyFunnelByAccount',
  dailyTrend: 'ai.dailyTrend',
  instancesList: 'ai.instancesList',
  icpRoster: 'ai.icpRoster',
  hypothesisRoster: 'ai.hypothesisRoster',
} as const

/** The fixed queries, named exactly as their operation names. */
export type AiNamedQuery = Exclude<keyof typeof AI_OPERATIONS, 'executeSql'>

// Per-campaign invite queue: who is still WAITING for an invite (not yet invited,
// not excluded), how many of those sit in warm-up steps before InvitePerson, and how
// recently leads were added. This is the ground truth for interpreting a zero-invite
// stretch. Runtime status is now a separate last-synchronized observation, but
// the queue remains the evidence for whether a batch is warming up or exhausted;
// never infer queue mechanics from Running/Sleeping alone.
export const INVITE_QUEUE_SQL = `
with invite_step as (
  select campaign_id, min(step_index) as invite_idx
  from campaign_steps
  where step_type = 'InvitePerson'
  group by 1
),
warmup as (
  select s.campaign_id, sum(s.current_count) as in_warmup
  from campaign_steps s
  join invite_step v on v.campaign_id = s.campaign_id
  where s.step_index < v.invite_idx
  group by 1
),
queue as (
  select campaign_id,
         count(*) filter (where coalesce(status, '') not like '-%') as awaiting_invite,
         count(*) filter (where coalesce(status, '') not like '-%'
                            and added_at > now() - interval '3 days') as added_3d,
         max(added_at) filter (where coalesce(status, '') not like '-%') as last_added_at
  from leads
  where invited_at is null
  group by 1
),
last_inv as (
  select campaign_id, max(invited_at)::date as last_invite_date
  from leads
  group by 1
)
select c.id as campaign_id, c.name as campaign, c.instance_id,
       coalesce(i.account_name, i.label, c.instance_id) as account,
       (v.invite_idx is not null)      as has_invite_step,
       coalesce(q.awaiting_invite, 0)  as leads_awaiting_invite,
       coalesce(w.in_warmup, 0)        as in_pre_invite_warmup,
       coalesce(q.added_3d, 0)         as added_last_3d,
       q.last_added_at,
       li.last_invite_date
from campaigns c
join instances i on i.id = c.instance_id
left join invite_step v on v.campaign_id = c.id
left join queue q on q.campaign_id = c.id
left join warmup w on w.campaign_id = c.id
left join last_inv li on li.campaign_id = c.id
order by 4, 2
`.trim()

export const WEEKLY_FUNNEL_SQL = `
select
  date_trunc('week', l.invited_at)::date as invite_week,
  count(*)                               as invites,
  count(l.connected_at)                  as accepted,
  count(l.replied_at)                    as replied,
  round(100.0 * count(l.connected_at) / nullif(count(*), 0), 1)               as acceptance_rate,
  round(100.0 * count(l.replied_at) filter (where l.connected_at is not null)
        / nullif(count(l.connected_at), 0), 1)                                as reply_rate_of_accepted,
  round(avg(extract(epoch from (l.replied_at - l.invited_at)) / 86400.0), 1)  as avg_days_to_reply
from leads l
where l.invited_at is not null
group by 1
order by 1 desc
limit 16
`.trim()

// Actual observed invite-to-accept lag, last 90 days. Grounds "is this cohort old enough
// to judge yet" in real data instead of a guessed threshold — see SCHEMA_DOC's ACCEPT_LAG_SQL
// note. A rising median/p90 vs the historical norm means people are slower to accept right
// now (e.g. a holiday slowdown), not that a campaign got worse.
export const ACCEPT_LAG_SQL = `
select
  round((percentile_cont(0.5) within group (
    order by extract(epoch from (connected_at - invited_at)) / 86400))::numeric, 1) as median_days_to_accept,
  round((percentile_cont(0.9) within group (
    order by extract(epoch from (connected_at - invited_at)) / 86400))::numeric, 1) as p90_days_to_accept,
  count(*) as accepted_n
from leads
where connected_at is not null and invited_at > now() - interval '90 days'
`.trim()

// Per-hypothesis rollup: ICP name, #campaigns, and the funnel — invited/connected/
// replied + rates — deduped by PERSON (instance_id, profile_url) across the
// hypothesis's campaigns, taking the earliest non-null milestone per person (see the
// HYPOTHESIS FUNNEL guidance in SCHEMA_DOC above). campaign_counts and person_agg are
// aggregated in SEPARATE CTEs before the final join specifically so joining hypotheses
// to both at once can't cross-multiply campaigns x people into an inflated count.
export const HYPOTHESIS_OVERVIEW_SQL = `
with campaign_counts as (
  select hypothesis_id, count(*) as campaigns
  from hypothesis_campaigns
  group by 1
),
person_leads as (
  select hc.hypothesis_id, l.instance_id, l.profile_url,
         min(l.invited_at)   as invited_at,
         min(l.connected_at) as connected_at,
         min(l.replied_at)   as replied_at
  from leads l
  join hypothesis_campaigns hc on hc.campaign_id = l.campaign_id
  group by hc.hypothesis_id, l.instance_id, l.profile_url
),
person_agg as (
  select hypothesis_id,
         count(*)             as leads,
         count(invited_at)    as invited,
         count(connected_at)  as connected,
         count(replied_at)    as replied
  from person_leads
  group by 1
)
select
  h.id as hypothesis_id,
  h.name as hypothesis,
  i.name as icp,
  coalesce(cc.campaigns, 0) as campaigns,
  coalesce(pa.leads, 0)     as leads,
  coalesce(pa.invited, 0)   as invited,
  coalesce(pa.connected, 0) as connected,
  coalesce(pa.replied, 0)   as replied,
  round(100.0 * pa.connected / nullif(pa.invited, 0), 1)   as connect_rate,
  round(100.0 * pa.replied / nullif(pa.connected, 0), 1)   as reply_rate
from hypotheses h
left join icps i on i.id = h.icp_id
left join campaign_counts cc on cc.hypothesis_id = h.id
left join person_agg pa on pa.hypothesis_id = h.id
where h.archived = false
order by pa.leads desc nulls last
`.trim()

export const CAMPAIGN_OVERVIEW_SQL = `
select cm.*, i.account_name, i.last_sync_at
from campaign_metrics cm
join instances i on i.id = cm.instance_id
order by cm.invites_sent desc
`.trim()

// Current manual-CRM pipeline snapshot: how many leads sit in each stage per
// campaign (with account name), how many are stale (>14d in-stage), plus a single
// summary row counting UNTRIAGED replies — leads that have replied but nobody has
// put into the pipeline yet (pipeline_stage IS NULL), the top of the triage queue.
export const PIPELINE_OVERVIEW_SQL = `
with by_stage as (
  select pm.campaign_id,
         coalesce(c.name, pm.campaign_id)              as campaign,
         pm.instance_id,
         coalesce(i.account_name, i.label, pm.instance_id) as account,
         pm.pipeline_stage,
         pm.pipeline_substatus,
         sum(pm.leads)     as leads,
         min(pm.oldest_in_stage) as oldest_in_stage,
         sum(pm.stale_14d) as stale_14d
  from pipeline_metrics pm
  left join campaigns c on c.id = pm.campaign_id
  left join instances i on i.id = pm.instance_id
  group by 1, 2, 3, 4, 5, 6
)
select 'stage'::text as row_type, campaign_id, campaign, instance_id, account,
       pipeline_stage, pipeline_substatus, leads, oldest_in_stage, stale_14d
from by_stage
union all
select 'untriaged_replies'::text, null, null, null, null,
       null, null, count(*), null, null
from leads
where replied_at is not null and pipeline_stage is null
order by row_type, leads desc nulls last
`.trim()

// Same cohort math as WEEKLY_FUNNEL_SQL, but broken out per account instead of
// aggregated across all of them — needed to spot one account's cohorts quietly
// declining even while the fleet-wide trend looks fine.
export const WEEKLY_FUNNEL_BY_ACCOUNT_SQL = `
select
  l.instance_id,
  coalesce(i.account_name, i.label, l.instance_id)                            as account,
  date_trunc('week', l.invited_at)::date                                      as invite_week,
  count(*)                                                                    as invites,
  count(l.connected_at)                                                       as accepted,
  count(l.replied_at)                                                         as replied,
  round(100.0 * count(l.replied_at) filter (where l.connected_at is not null)
        / nullif(count(l.connected_at), 0), 1)                                as reply_rate_of_accepted
from leads l
join instances i on i.id = l.instance_id
where l.invited_at is not null and l.invited_at > now() - interval '120 days'
group by 1, 2, 3
order by 1, 3 desc
`.trim()

// The deterministic anomaly signal feed: per-day event counts, last three weeks.
export const DAILY_TREND_SQL = `
select day, instance_id, event_type, cnt
from daily_activity
where day > current_date - interval '21 days'
  and event_type in ('invite_sent', 'invite_accepted', 'reply_received')
order by day
`.trim()

// The account display names behind every signal's `account` label — the
// anomalies module's one direct table read, moved into the guard like the rest.
export const INSTANCES_LIST_SQL = `
select id, account_name, label
from instances
order by id
`.trim()

// The copilot's always-on ICP/hypothesis awareness: names and one-liners only,
// so it knows what exists without spending a tool call to find out. Depth —
// personas, keyword lists, per-hypothesis funnel — stays with
// `hypothesis_overview` and `run_sql`.
//
// Two queries rather than one join, deliberately. `loadIcpRoster` resolves each
// hypothesis's ICP name against the ICP rows it actually received, so a
// hypothesis pointing at an *archived* ICP reads as unassigned — which is the
// behaviour the PostgREST pair had, and a `LEFT JOIN` here would silently
// change it. Two round trips also give each list its own row cap instead of
// making one crowd the other out.
export const ICP_ROSTER_SQL = `
select id, name, main_product, core_sphere
from icps
where archived = false
order by name
`.trim()

export const HYPOTHESIS_ROSTER_SQL = `
select name, icp_id, description
from hypotheses
where archived = false
order by name
`.trim()

/** Every fixed query and the SQL it runs under, for the Supabase branch. */
export const AI_NAMED_SQL: Record<AiNamedQuery, string> = {
  weeklyFunnel: WEEKLY_FUNNEL_SQL,
  campaignOverview: CAMPAIGN_OVERVIEW_SQL,
  pipelineOverview: PIPELINE_OVERVIEW_SQL,
  hypothesisOverview: HYPOTHESIS_OVERVIEW_SQL,
  acceptLag: ACCEPT_LAG_SQL,
  inviteQueue: INVITE_QUEUE_SQL,
  weeklyFunnelByAccount: WEEKLY_FUNNEL_BY_ACCOUNT_SQL,
  dailyTrend: DAILY_TREND_SQL,
  instancesList: INSTANCES_LIST_SQL,
  icpRoster: ICP_ROSTER_SQL,
  hypothesisRoster: HYPOTHESIS_ROSTER_SQL,
}

export interface AiExecuteSqlParams extends DataStoreParams {
  readonly query: string
}

/**
 * The guard returns one row of one jsonb column — the aggregate of up to 1000
 * rows, never NULL. `pg` parses jsonb into a JS array, so the mapper asserts
 * the shape and hands the array onward; anything else is a contract break the
 * caller must not paper over.
 *
 * Exported for `aiSystem.ts`, whose out-of-grant reads are guard calls too.
 * Sharing the mapper rather than copying four lines is what keeps "a guard call
 * answers in one shape" a fact about the code instead of a convention.
 */
export function mapGuardRow(row: NeonRow): unknown[] {
  const result = row.result
  if (!Array.isArray(result)) {
    throw new Error('ai_execute_sql did not return a row aggregate')
  }
  return result
}

/** The guard call itself, with the query bound as a parameter. Exported for
 *  the same reason as `mapGuardRow`. */
export const guardStatement = (query: string) => ({
  text: 'SELECT public.ai_execute_sql($1) AS result',
  values: [query] as readonly unknown[],
})

/**
 * Build the AI registry. Exported — like `buildApplicationRegistry` — so a
 * test can build an identical one without reaching for the module-scope store.
 *
 * It composes `aiSystem.ts`'s registrations at the end, so one store answers
 * both the guard reads and the system DML step 007 opened. They are separate
 * modules and one registry because they are one principal.
 */
export function buildAiRegistry(): NeonOperationRegistry {
  const registry = new NeonOperationRegistry()

  registry.registerQuery<unknown[], AiExecuteSqlParams>(AI_OPERATIONS.executeSql, {
    build: ({ params }) => {
      const query = params?.query
      if (typeof query !== 'string' || query.trim() === '') {
        // Refused before any connection is acquired, exactly like an
        // unregistered operation.
        throw new Error('ai.executeSql requires a non-empty query parameter')
      }
      return guardStatement(query)
    },
    mapRow: mapGuardRow,
  })

  for (const [name, sql] of Object.entries(AI_NAMED_SQL) as [
    AiNamedQuery,
    string,
  ][]) {
    registry.registerQuery<unknown[]>(AI_OPERATIONS[name], {
      build: () => guardStatement(sql),
      mapRow: mapGuardRow,
    })
  }

  return registerSystemOperations(registry)
}
