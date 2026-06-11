// Shared data-access core for the AI layer. Used by both /api/chat (Vercel AI
// SDK tools) and /api/mcp (MCP server) so the two surfaces stay in sync.
import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null

function db(): SupabaseClient {
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
  created_at timestamptz

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

messages — actual message texts (mostly inbound replies)
  id bigint PK, instance_id, campaign_id, profile_url, direction text ('in'|'out'),
  body text, sent_at timestamptz

campaign_steps — outbound message sequence per campaign with aggregates
  campaign_id -> campaigns, step_index int (0-based), step_label text,
  step_type text, template_body text (the message copy),
  sent_count int, replied_count int (first replies attributed to this step),
  current_count int (people whose furthest step is this one), updated_at

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

ANALYSIS GUIDANCE
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
