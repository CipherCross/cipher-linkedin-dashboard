// Shared data-access core for the AI layer. Used by both /api/chat (Vercel AI
// SDK tools) and /api/mcp (MCP server) so the two surfaces stay in sync.
import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null

/** Service-role Supabase client (bypasses RLS). Shared by the AI SQL layer and
 *  the reply classifier (/api/classify). */
export function db(): SupabaseClient {
  if (_client) return _client
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY environment variables'
    )
  }
  _client = createClient(url, key, { auth: { persistSession: false } })
  return _client
}

const MAX_ROWS = 200
const MAX_CHARS = 24_000

export interface SqlResult {
  rows: unknown[]
  rowCount: number
  truncated: boolean
}

/** Run a read-only SQL query via the ai_execute_sql RPC (enforced in Postgres). */
export async function executeSql(query: string): Promise<SqlResult> {
  const { data, error } = await db().rpc('ai_execute_sql', { query })
  if (error) throw new Error(`SQL error: ${error.message}`)
  const all = Array.isArray(data) ? data : []
  let rows = all.slice(0, MAX_ROWS)
  // Hard cap on payload size so one giant query can't blow up the context.
  while (rows.length > 1 && JSON.stringify(rows).length > MAX_CHARS) {
    rows = rows.slice(0, Math.ceil(rows.length / 2))
  }
  return { rows, rowCount: all.length, truncated: rows.length < all.length }
}

// Per-campaign invite queue: who is still WAITING for an invite (not yet invited,
// not excluded), how many of those sit in warm-up steps before InvitePerson, and how
// recently leads were added. This is the ground truth for interpreting a zero-invite
// stretch — LH2's runtime state (running/paused) is NOT synced, so the queue is the
// only observable distinction between "batch still warming up" and "ran out of leads".
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

export const SCHEMA_DOC = `
PostgreSQL (Supabase) schema for a LinkedIn outreach dashboard. Data is synced
from Linked Helper 2 (LH2) running on several machines ("instances"); each
instance corresponds to one real LinkedIn account.

TABLES

instances — one row per LH2 instance / LinkedIn account
  id text PK (e.g. "notebook-kyiv"), label text, last_sync_at timestamptz,
  agent_version text, account_name text, account_url text, account_avatar text,
  created_at timestamptz, config jsonb (online config overrides the agent merges
  over its local config.yaml; operational, not analytical), config_updated_at timestamptz

campaigns — one row per LH2 campaign per instance
  id text PK ("<instance_id>:<lh_campaign_id>"), instance_id -> instances,
  lh_campaign_id text, name text, status text (raw LH2 value — a mix of codes
  like 'active'/'1'; NOT a reliable running/paused indicator), created_at,
  updated_at

leads — one row per person per campaign; milestone timestamps drive the funnel
  id uuid PK, instance_id, campaign_id -> campaigns, profile_url text,
  full_name text, headline text, company text, status text (raw LH2 code:
  '1' = active; negative codes like '-1'/'-999' = excluded/failed/withdrawn),
  added_at timestamptz, invited_at timestamptz, connected_at timestamptz,
  first_message_at timestamptz, replied_at timestamptz, last_action_at timestamptz,
  raw jsonb, updated_at
  NOTE: a NULL timestamp means the milestone never happened. Funnel order:
  invited_at -> connected_at -> first_message_at -> replied_at.
  added_at is NOT a funnel milestone: it is when the lead was QUEUED into the
  campaign (LH2's add_to_target_date; earliest milestone as fallback for rows
  synced before v1.8.0). Use it for "when / how many leads were added per
  campaign": date_trunc('week', added_at), count(*) grouped by campaign_id.
  NULL added_at = unknown add date, not "never added".
  Milestones may also be backfilled from manually imported conversations
  (/api/import-conversation); a DB trigger keeps a non-NULL milestone from
  regressing to NULL when the agent re-syncs.

events — append-only action log (drives daily-activity charts)
  id bigint PK, instance_id, campaign_id, profile_url,
  event_type text ('invite_sent'|'invite_accepted'|'message_sent'|'reply_received'|...),
  occurred_at timestamptz, raw jsonb

messages — actual message texts; full conversation threads, both directions
  id bigint PK, instance_id, campaign_id, profile_url, direction text ('in'|'out'),
  body text, sent_at timestamptz,
  source text ('sync'|'manual') — 'sync' rows come from the LH2 agent and their
    sent_at is the LH2 action-RUN time, which can lag the real message by
    hours/days; 'manual' rows were pasted by the SDR from LinkedIn ("Import
    history" in the dashboard) and carry the real message time. Threads the SDR
    took over by hand are complete only thanks to manual imports — see the
    MANUAL-REPLY BLIND SPOT guidance before reading anything into a missing
    outbound follow-up.
  sentiment text — reply classification, set ONLY on inbound replies (direction='in'):
    'positive' (interested, wants to talk), 'neutral' (acknowledgement / not now),
    'negative' (not interested / unsubscribe), 'objection' (question or pushback),
    'referral' (talk to someone else), 'auto' (out-of-office / autoresponder).
    NULL = outbound, or an inbound reply not yet classified.
  reason text (one-line rationale), classified_at timestamptz, classified_model text

campaign_steps — the FULL campaign sequence per campaign with aggregates,
  including WARM-UP steps that run before the invite (profile visits, post
  likes, follows, endorsements...), not just messaging steps.
  campaign_id -> campaigns, step_index int (0-based position in sequence),
  step_label text, step_type text, template_body text (message copy; null for
  warm-up steps), sent_count int (people processed by this step),
  replied_count int (first replies; only ever attributed to messaging steps),
  current_count int (people whose furthest step is this one), updated_at
  step_type 'InvitePerson' and 'MessageToPerson' are messaging steps; any
  other step_type is a warm-up/auxiliary action.
  IMPORTANT: a lead with NULL invited_at is often NOT idle — it may be sitting
  in a warm-up step that precedes the invite. Check current_count of the steps
  before the InvitePerson step to see how many leads are still warming up.
  (Synced by agent v1.5.0+; instances on older agents only show messaging steps.)

annotations — manual notes pinned to dates (e.g. "changed template on X")
  id bigint PK, instance_id (null = all accounts), campaign_id (null = all),
  note text, noted_at date, created_at

sync_runs — sync agent run log
  id uuid PK, instance_id, started_at, finished_at, status ('running'|'ok'|'error'),
  rows_upserted int, error text

VIEWS

campaign_metrics — per-campaign funnel rollup:
  campaign_id, campaign_name, instance_id, status, total_leads, invites_sent,
  accepted, replies, acceptance_rate (%), reply_rate (% of accepted),
  last_activity_at

daily_activity — events bucketed per day:
  day date, instance_id, event_type, cnt

campaign_reply_sentiment — inbound reply sentiment counts per campaign:
  campaign_id, sentiment, cnt (only classified inbound replies)

ANALYSIS GUIDANCE
- Reply QUALITY, not just count: messages.sentiment classifies each inbound
  reply (positive/neutral/negative/objection/referral/auto). "Positive reply
  rate" = positive inbound replies / total replies. Use campaign_reply_sentiment
  for per-campaign breakdowns, or join messages (direction='in') to campaigns.
  NULL sentiment on an inbound row means it hasn't been classified yet.
- MANUAL-REPLY BLIND SPOT — never mistake a missing follow-up for a dropped lead.
  The LH2 agent syncs only the scripted funnel (invite → first templated message →
  the inbound reply); it CANNOT see outbound messages the SDR types by hand in
  LinkedIn after a lead replies. Those human follow-ups enter the DB ONLY when
  someone runs "Import history" (messages.source='manual'). Consequences:
  - A thread with an inbound reply but no later outbound row is NOT evidence the
    lead was dropped — usually it just hasn't been manually re-imported. Absence
    of follow-up in the data ≠ absence of follow-up in reality.
  - Before EVER claiming "warm/positive replies aren't being followed up" (or any
    post-reply drop-off / SDR-not-responding pattern), check message source on the
    threads in question. If the "no follow-up" threads are source='sync' only
    (zero manual rows) while the "followed-up" threads are the manually-imported
    ones, the pattern is a data-completeness artifact, not SDR behaviour — say so
    and RETRACT the leak claim.
  - This is NOT a stale-sync problem: instances.last_sync_at can be minutes old and
    the blind spot still applies. It is structural to how LH2 syncs — do NOT
    diagnose or dismiss it via sync freshness.
  - Detection: split the threads in question by source, e.g.
      select profile_url,
             count(*) filter (where source='manual') as manual_n,
             count(*) filter (where source='sync')   as sync_n
      from messages where instance_id = <id> and profile_url in (<urls>)
      group by profile_url
    A clean split (followed-up = manual_n > 0; not-followed-up = sync-only,
    manual_n = 0) confirms the artifact.
  - Correct recommendation is "manually import these threads so post-reply activity
    becomes visible/measurable" — NEVER "the SDR is dropping leads" or "add an
    automated follow-up sequence". Only after import can post-reply conversion
    (reply → follow-up → call) be measured honestly.
- PROACTIVE IMPORT SUGGESTIONS — surface blind-spot leads without being asked.
  When the user asks about warm replies, follow-ups, post-reply drop-off, pipeline
  health, or which leads need attention, proactively list the import candidates:
  leads with a valuable inbound reply (priority positive > objection > referral,
  most recent first) whose thread is sync-only (zero source='manual' rows), because
  their post-reply state is unknown. Use:
      with inbound as (
        select instance_id, profile_url,
               max(sent_at) filter (where direction='in') as last_reply_at,
               (array_agg(sentiment order by array_position(
                   array['positive','objection','referral'], sentiment))
                 filter (where direction='in'
                         and sentiment in ('positive','objection','referral')))[1] as best_sentiment,
               count(*) filter (where source='manual') as manual_msgs
        from messages
        group by 1, 2
      )
      select coalesce(i.account_name, i.label, ib.instance_id) as account,
             l.full_name, l.company, ib.best_sentiment,
             ib.last_reply_at::date as replied_on, ib.profile_url
      from inbound ib
      join instances i on i.id = ib.instance_id
      left join (
        select distinct on (instance_id, profile_url)
               instance_id, profile_url, full_name, company
        from leads
        order by instance_id, profile_url, updated_at desc nulls last
      ) l on l.instance_id = ib.instance_id and l.profile_url = ib.profile_url
      where ib.manual_msgs = 0            -- never hand-imported -> post-reply state unknown
        and ib.best_sentiment is not null -- had a valuable reply worth pursuing
      order by array_position(array['positive','objection','referral'], ib.best_sentiment),
               ib.last_reply_at desc
  - Frame this as a data-completeness action, not a performance problem: "these
    warm threads are sync-only, so we're blind to what happened after the reply —
    import their history to make follow-ups and booked calls visible."
  - List the specific leads (name, company, account, reply date, sentiment) so the
    SDR can act immediately.
  - NEVER infer from this list that a lead was dropped or follow-up is missing —
    the point is the data can't yet tell us.
  - Point the user to the dashboard's "Import history" action for each listed lead.
- Replies LAG invites, and so does ACCEPTANCE: someone invited today typically connects
  2-7 days later, then replies days or weeks after that — and the accept lag runs LONGER
  during holidays / low-activity stretches (e.g. summer), when people are simply slower to
  respond. Never compare raw invites-this-week vs replies-this-week. NEVER cite the
  acceptance_rate (or reply rate) of a cohort whose invites are still inside the current
  observed lag window as evidence of a decline, a weak campaign/channel, or "volume going
  somewhere bad" — a fresh cohort's rate is mechanically near-zero because most of it
  hasn't had the CHANCE to convert yet, not because anything is actually wrong. Use
  ACCEPT_LAG_SQL (below) to get the actual observed median/p90 days-to-accept instead of
  guessing; treat any cohort younger than that p90 as unmatured and either omit its rate or
  say explicitly it's too early to judge — never build a headline, risk, or "weak channel"
  claim on it.
  For "did the invite spike convert?", build COHORTS by invite week from leads:
    date_trunc('week', invited_at) as cohort, count(*) invites,
    count(connected_at) accepted, count(replied_at) replied
  and compare acceptance/reply rates only across cohorts old enough to have matured, noting
  the most recent 1-2 cohorts are still maturing (rates will keep rising as time passes).
- ACCEPT_LAG_SQL — the actual observed invite-to-accept lag (last 90 days), to ground
  "how mature does a cohort need to be" in real data instead of a guess:
    select round(percentile_cont(0.5) within group (
             order by extract(epoch from (connected_at - invited_at)) / 86400), 1) as median_days_to_accept,
           round(percentile_cont(0.9) within group (
             order by extract(epoch from (connected_at - invited_at)) / 86400), 1) as p90_days_to_accept,
           count(*) as accepted_n
    from leads
    where connected_at is not null and invited_at > now() - interval '90 days'
  Compare a recent 30-day window against this 90-day one if you suspect the lag itself has
  shifted (e.g. a summer/holiday slowdown) — a rising median/p90 means people are simply
  slower to accept right now, not that the campaign got worse.
- Time-to-reply: replied_at - invited_at (or - connected_at) on leads.
- Volume by calendar day/week comes from events or daily_activity.
- When rates differ across weeks, drill into segments: per instance (account),
  per campaign, per campaign step (campaign_steps shows which message in the
  sequence converts), and check annotations for known changes around the date.
- LH2's RUNTIME state is NOT synced: whether a campaign is running or paused in
  Linked Helper — or whether LH2 itself is open on the notebook — is invisible
  here (campaigns.status is a raw unreliable code). NEVER claim a campaign is
  paused/stopped/dead and never prescribe "resume/reactivate" it: you cannot
  observe that. Describe the observable instead (invites at 0 for N days) and
  use the invite queue below to interpret it.
- "Why aren't invites going out?" — check the INVITE QUEUE before interpreting a
  zero-invite stretch. Warm-up sequences put multi-day Waiter delays before the
  InvitePerson step, so a freshly added batch of leads yields 0 invites for
  several days BY DESIGN. INVITE_QUEUE_SQL (per campaign):
${INVITE_QUEUE_SQL}
  Non-empty queue (leads_awaiting_invite / in_pre_invite_warmup > 0) → the batch
  is progressing through warm-up; invites are expected — report the queued volume
  and when leads were added (added_last_3d / last_added_at), not a stall cause.
  Empty queue → the campaign ran out of people to invite; the correct action is
  "add new leads to <campaign>", never "reactivate". Ignore campaigns with
  has_invite_step = false — they never send invites (scraping/analysis-only).
- All timestamps are timestamptz; use date_trunc for bucketing.
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
  round(percentile_cont(0.5) within group (
    order by extract(epoch from (connected_at - invited_at)) / 86400), 1) as median_days_to_accept,
  round(percentile_cont(0.9) within group (
    order by extract(epoch from (connected_at - invited_at)) / 86400), 1) as p90_days_to_accept,
  count(*) as accepted_n
from leads
where connected_at is not null and invited_at > now() - interval '90 days'
`.trim()

export const CAMPAIGN_OVERVIEW_SQL = `
select cm.*, i.account_name, i.last_sync_at
from campaign_metrics cm
join instances i on i.id = cm.instance_id
order by cm.invites_sent desc
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
