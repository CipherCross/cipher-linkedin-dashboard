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
  lh_campaign_id text, name text, status text ('active'|...), created_at,
  updated_at

leads — one row per person per campaign; milestone timestamps drive the funnel
  id uuid PK, instance_id, campaign_id -> campaigns, profile_url text,
  full_name text, headline text, company text, status text (raw LH2 status),
  invited_at timestamptz, connected_at timestamptz, first_message_at timestamptz,
  replied_at timestamptz, last_action_at timestamptz, raw jsonb, updated_at
  NOTE: a NULL timestamp means the milestone never happened. Funnel order:
  invited_at -> connected_at -> first_message_at -> replied_at.

events — append-only action log (drives daily-activity charts)
  id bigint PK, instance_id, campaign_id, profile_url,
  event_type text ('invite_sent'|'invite_accepted'|'message_sent'|'reply_received'|...),
  occurred_at timestamptz, raw jsonb

messages — actual message texts; full conversation threads, both directions
  id bigint PK, instance_id, campaign_id, profile_url, direction text ('in'|'out'),
  body text, sent_at timestamptz,
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
- Replies LAG invites: someone invited this week typically accepts and replies
  days or weeks later. Never compare raw invites-this-week vs replies-this-week.
  For "did the invite spike convert?", build COHORTS by invite week from leads:
    date_trunc('week', invited_at) as cohort, count(*) invites,
    count(connected_at) accepted, count(replied_at) replied
  and compare acceptance/reply rates across cohorts, noting recent cohorts are
  still maturing (rates will rise as time passes).
- Time-to-reply: replied_at - invited_at (or - connected_at) on leads.
- Volume by calendar day/week comes from events or daily_activity.
- When rates differ across weeks, drill into segments: per instance (account),
  per campaign, per campaign step (campaign_steps shows which message in the
  sequence converts), and check annotations for known changes around the date.
- "Why aren't invites going out?" — check campaign_steps for warm-up steps
  before InvitePerson: leads accumulate there (current_count) until warm-up
  completes, so low invite volume can simply mean a long warm-up pipeline.
- All timestamps are timestamptz; use date_trunc for bucketing.
`.trim()

export const WEEKLY_FUNNEL_SQL = `
select
  date_trunc('week', l.invited_at)::date as invite_week,
  count(*)                               as invites,
  count(l.connected_at)                  as accepted,
  count(l.replied_at)                    as replied,
  round(100.0 * count(l.connected_at) / nullif(count(*), 0), 1)               as acceptance_rate,
  round(100.0 * count(l.replied_at) / nullif(count(l.connected_at), 0), 1)    as reply_rate_of_accepted,
  round(avg(extract(epoch from (l.replied_at - l.invited_at)) / 86400.0), 1)  as avg_days_to_reply
from leads l
where l.invited_at is not null
group by 1
order by 1 desc
limit 16
`.trim()

export const CAMPAIGN_OVERVIEW_SQL = `
select cm.*, i.account_name, i.last_sync_at
from campaign_metrics cm
join instances i on i.id = cm.instance_id
order by cm.invites_sent desc
`.trim()
