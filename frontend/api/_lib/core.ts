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

// ai_execute_sql (migration 021, updated 030-035) hard-caps results at 1000 rows
// server-side; this layer trims further to MAX_ROWS / MAX_CHARS below.
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

/** Compact, cheap "ICP + hypothesis roster" for the chat copilot's always-on system
 *  prompt (names + a one-line summary each) so it's ICP-aware without a tool call;
 *  depth (personas, full keyword lists, per-hypothesis funnel) is left to run_sql /
 *  hypothesis_overview on demand. Flat selects joined in JS (matches the rest of this
 *  codebase's style — no PostgREST relationship embedding). Empty string when neither
 *  table has any live (non-archived) rows yet, so a blank ICP layer adds nothing to
 *  the prompt. */
export async function loadIcpRoster(): Promise<string> {
  const [{ data: icps }, { data: hyps }] = await Promise.all([
    db()
      .from('icps')
      .select('id,name,main_product,core_sphere')
      .eq('archived', false)
      .order('name'),
    db()
      .from('hypotheses')
      .select('name,icp_id,description')
      .eq('archived', false)
      .order('name'),
  ])
  const icpRows = (icps ?? []) as { id: number; name: string; main_product: string | null; core_sphere: string | null }[]
  const hypRows = (hyps ?? []) as { name: string; icp_id: number | null; description: string | null }[]
  if (icpRows.length === 0 && hypRows.length === 0) return ''

  const icpNameById = new Map(icpRows.map((i) => [i.id, i.name]))
  const icpLines = icpRows.map((i) => {
    const bits = [i.main_product, i.core_sphere].filter(Boolean)
    return `- "${i.name}"${bits.length ? `: ${bits.join(' — ')}` : ''}`
  })
  const hypLines = hypRows.map((h) => {
    const icpName = h.icp_id != null ? icpNameById.get(h.icp_id) : null
    const scope = icpName ? ` (ICP: "${icpName}")` : ' (no ICP assigned)'
    return `- "${h.name}"${scope}${h.description ? `: ${h.description}` : ''}`
  })

  return [
    icpLines.length ? `ICPs (Ideal Customer Profiles):\n${icpLines.join('\n')}` : '',
    hypLines.length ? `Hypotheses:\n${hypLines.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
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
  READABLE COLUMNS: id text PK (e.g. "notebook-kyiv"), label text,
  last_sync_at timestamptz, agent_version text, created_at timestamptz,
  account_name text, account_url text, account_avatar text,
  config_updated_at timestamptz
  WARNING: never \`select *\` from instances — it also has a config jsonb column
  (online config overrides the agent merges over its local config.yaml;
  operational, not analytical) that the AI's SQL role can NOT read (column-level
  grant); \`select *\` will fail with a permission error. List columns explicitly,
  e.g. select id, label, account_name, last_sync_at from instances.

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
  raw jsonb, updated_at,
  -- MANUAL CRM LAYER (set by the team on the dashboard's pipeline board; NOT
  -- synced from LH2). Distinct from the raw LH2 status code above AND from the
  -- milestone timestamps — those track LH2's scripted funnel; these track where
  -- the human sales process has taken the lead.
  pipeline_stage text (canonical stage slug, see STAGE VOCABULARY below;
    NULL pipeline_stage = NOT YET TRIAGED, it NEVER means the lead was dropped),
  pipeline_substatus text (a sub-state slug valid only for certain stages),
  lost_reason text (free text, set only when pipeline_stage='lost'),
  pipeline_stage_changed_at timestamptz (when pipeline_stage last MOVED; a
    substatus-only edit does not touch it — use it for time-in-current-stage),
  assigned_to bigint -> team_members.id (the SDR who owns this lead; NULL = unassigned)
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
  -- DEMOGRAPHICS LAYER (inferred; internal outreach analytics only). Age is a
  -- RANGE, not a point; gender is a statistical inference until an SDR confirms it.
  education_start_year int (university/school start year, from LH2; text signal),
  first_job_start_year int (earliest job start year, from LH2; text signal),
  birth_year_min int, birth_year_max int (INCLUSIVE birth-year RANGE; NULL = no age
    signal. Render an AGE range from the current year: age ~= current_year - birth_year.
    e.g. birth_year_min=1990, birth_year_max=1995 with current year 2026 -> "~31-36".
    Computed by arithmetic from the two start years, no model),
  gender text ('male'|'female'|'unknown'; NULL = not yet inferred. 'unknown' is a
    first-class value — ambiguous, initials-only, or non-Western names the model
    can't call reliably — NOT a failure state),
  gender_confidence real (0..1; the model's confidence in the gender label. 1 for manual overrides),
  demo_inferred_at timestamptz (when demographics were last computed; NULL = not yet
    processed by the classify job),
  demo_model text ('claude-haiku-4-5' = AI inference; 'manual' = SDR-CONFIRMED via the
    dashboard — treat 'manual' rows as GROUND TRUTH, never re-inferred).
  NOTE: gender/age are INFERRED for internal analytics; always describe them as
  inferred-with-confidence unless demo_model='manual'. Name-based gender is less
  accurate for non-Western names — prefer 'unknown' over a low-confidence guess.
  photo_path text (bucket-relative path to the lead's avatar in Supabase Storage,
    <instance_id>/<slug>.jpg; NULL = no photo. UI DISPLAY ONLY — never fetch for
    inference/classification; never pass to any model),
  photo_synced_at timestamptz (when the agent last resolved a photo; a non-NULL
    photo_synced_at with NULL photo_path means "checked, none available")

events — action log (drives daily-activity charts)
  id bigint PK, instance_id, campaign_id, profile_url,
  event_type text ('invite_sent'|'invite_accepted'|'message_sent'|'reply_received'|...),
  occurred_at timestamptz, raw jsonb
  NOT append-only: unique per (instance_id, campaign_id, profile_url, event_type) —
  one row per lead per event type, upserted. occurred_at is NOT part of that key
  and can shift later if the underlying milestone is corrected (e.g. a backfilled
  reply time) — don't expect duplicate rows for the same event_type on a lead,
  and don't treat occurred_at as immutable history.

messages — actual message texts; full conversation threads, both directions
  id bigint PK, instance_id, campaign_id, profile_url, direction text ('in'|'out'),
  body text, sent_at timestamptz,
  content_hash text (internal dedup hash of body; part of the identity key that
    distinguishes manually-imported rows from agent-synced ones),
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
  reason text (one-line rationale), classified_at timestamptz, classified_model text,
  notified_at timestamptz — when the inbound reply was announced to Slack (or
    deliberately skipped as stale/pre-feature); NULL = notification pending.
    Bookkeeping for /api/notify-replies only, not a funnel signal.
  updated_at timestamptz (bumps only on a real change, e.g. sentiment gets
    classified — not touched by every sync pass; same only-on-real-change
    semantics apply to leads.updated_at and campaigns.updated_at)

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

team_members — the SDRs who own leads in the manual CRM pipeline
  id bigint PK, name text (unique), active bool (default true; inactive members
  can't be newly assigned), created_at
  leads.assigned_to references this table.

lead_notes — free-text notes pinned to a single lead in the pipeline board
  id bigint PK, lead_id uuid -> leads, author text (nullable), body text, created_at

pipeline_events — append-only log of every manual pipeline change on a lead.
  This is the ONLY source for pipeline history / time-in-stage — reconstruct
  durations from the gaps between a lead's consecutive events.
  id bigint PK, lead_id uuid -> leads, kind text ('stage'|'assignment'),
  actor text (who made the change; default 'unknown'),
  from_stage/to_stage text, from_substatus/to_substatus text (kind='stage'),
  from_assignee/to_assignee text — assignee NAMES, not ids (kind='assignment'),
  lost_reason text, occurred_at timestamptz (default now())

STAGE VOCABULARY (pipeline_stage slug -> label, funnel rank; allowed substatuses)
  rank 0  first_contact          "First Contact"            (no substatuses)
  rank 1  interested             "Interested"               (no substatuses)
  rank 1  neutral                "Neutral"                  (no substatuses)
  rank 1  negative               "Negative"                 substatus: soft_no | hard_no | lost
  rank 1  following_up           "Following Up"             (no substatuses)
  rank 2  negotiations_call      "Negotiations about Call"  (no substatuses)
  rank 3  call_booked            "Call Booked"              (no substatuses)
  rank 4  call_done              "Call Done"                substatus: proposal | later | not_a_fit
  rank 5  proposal_in_progress   "Proposal In Progress"     (no substatuses)
  rank 6  proposal_presented     "Proposal Presented"       substatus: waiting_decision | contract | needs_changes
  rank 7  client                 "Client (Contracted)"      (no substatuses)
  rank 7  lost                   "Lost"                     (no substatuses; free-text lost_reason applies here)
  Higher rank = further down the sales funnel. Some ranks hold several stages
  (interested/neutral/negative/following_up all rank 1; client/lost both rank 7).
  following_up = the semi-warm holding lane: the lead replied at least once, a
  follow-up was RECORDED after their last inbound, and they have been silent
  >= 14 days ("replied once, now ghosting our follow-ups"). pipeline_auto_advance
  parks interested/neutral leads here automatically (pipeline_events actor='auto');
  humans can also move leads in/out by hand, and auto never overrides a human-set
  stage. It is a holding state, NOT funnel progress — hence the shared rank 1.

saved_searches — the Search Library: shared, named sourcing-search RECIPES
  (Apollo / Sales Navigator / esun / …) that data sourcers reproduce BY HAND on the
  platform. These are filter SETUPS to share, NOT executed searches or query history,
  and nothing here runs against any platform API.
  id bigint PK, name text, platform text (free text — 'Apollo', 'Sales Navigator',
  'esun', and others; not an enum), description text, include_keywords text[],
  exclude_keywords text[], boolean_query text (free-form AND/OR/NOT string pasteable
  into the platform), filters jsonb (platform-specific settings, flat key->value),
  notes text, author text (free text; who the search belongs to), archived boolean,
  hypothesis_id bigint -> hypotheses (nullable; which hypothesis this search recipe
  executes for — the EXECUTION side of an ICP's keywords, vs icp_industries which is
  the DEFINITION side), created_at, updated_at.
  The LIVE set is archived=false; archived=true is the soft-deleted/retired set
  (hidden by default in the UI). Unique per (platform, lower(name)) — same name can
  exist under different platforms but not twice within one platform.

icps — Ideal Customer Profile definitions (migration 043), fully structured (no
  Markdown body). Editable via the /icp page; the AI never writes these.
  id bigint PK, name text (unique), airtable_url text,
  main_product/core_sphere/secondary_sphere/product_stage/monetization text,
  features_note text, purchase_triggers text[], features text[],
  company_countries text[], company_headcount text, company_age text,
  apollo_industries text[], funding text, dev_team_availability text,
  dev_team_location text, exclude_keywords text[] (the one ICP-wide exclude
  list; include keywords live per sub-industry on icp_industries below),
  archived boolean, created_at, updated_at.
  A hypothesis (below) points at one icps row; one ICP can back many
  hypotheses.

icp_personas — buyer personas per ICP (seed: management/product/technical;
  kind is free text, not an enum — more can be added in the editor)
  id bigint PK, icp_id -> icps, kind text, job_titles text[], age_range text,
  location text, background text, profile_status text, connections_note text,
  followers_note text, sort int (display order), created_at, updated_at

icp_industries — DEFINITION side of per-sub-industry INCLUDE keywords (an ICP's
  Apollo industries, each with its OWN include keyword list). Exclude keywords
  are ICP-wide only (icps.exclude_keywords above); this table holds includes
  only — the two scopes never overlap.
  id bigint PK, icp_id -> icps, name text, include_keywords text[] (default
  empty — starts blank, filled in by the team), created_at, updated_at

hypotheses — a named, testable go-to-market hypothesis: groups campaigns under
  one ICP for stats (migration 043). Editable via the /hypotheses page.
  id bigint PK, name text (unique), icp_id -> icps (nullable — a hypothesis can
  be unassigned), description text, archived boolean, created_at, updated_at

hypothesis_campaigns — join table: which campaigns execute a hypothesis. A
  campaign belongs to AT MOST ONE hypothesis (unique on campaign_id). This is a
  SEPARATE table from campaigns — the sync agent never writes to it and never
  sees hypothesis assignments, so a re-sync can't clobber them.
  hypothesis_id -> hypotheses, campaign_id -> campaigns, created_at

sync_runs — sync agent run log
  id uuid PK, instance_id, started_at, finished_at,
  status ('running'|'ok'|'partial'|'error') — 'partial' means the sync completed
    but one or more sections (messages/steps) failed extraction and returned
    empty; see error for which section and why,
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

pipeline_metrics — current manual-CRM stage distribution per campaign:
  campaign_id, instance_id, pipeline_stage, pipeline_substatus, leads (count in
  that stage/substatus), oldest_in_stage timestamptz (min pipeline_stage_changed_at),
  stale_14d (count sitting in-stage > 14 days). Only counts leads with a
  non-NULL pipeline_stage (i.e. already triaged).

ANALYSIS GUIDANCE
- Reply QUALITY, not just count: messages.sentiment classifies each inbound
  reply (positive/neutral/negative/objection/referral/auto). "Positive reply
  rate" = positive inbound replies / total replies. Use campaign_reply_sentiment
  for per-campaign breakdowns, or join messages (direction='in') to campaigns.
  NULL sentiment on an inbound row means it hasn't been classified yet.
  Sentiment is classified ONCE, when the reply arrives, and never re-evaluated:
  a 'positive' label says the reply WAS positive, not that the lead is warm
  today. Before describing any lead as currently warm/hot, apply the
  STALE / GHOSTED rule below.
- MANUAL-REPLY BLIND SPOT — never mistake a missing follow-up for a dropped lead.
  The LH2 agent syncs only the scripted funnel (invite → first templated message →
  the inbound reply); it CANNOT see outbound messages the SDR types by hand in
  LinkedIn after a lead replies. Those human follow-ups enter the DB ONLY when
  someone runs "Import history" (messages.source='manual'). Consequences:
  - A thread with an inbound reply but no later outbound row is NOT evidence the
    lead was dropped — usually it just hasn't been manually re-imported. Absence
    of follow-up in the data ≠ absence of follow-up in reality.
    (Exception: when a RECORDED outbound exists after the last inbound, silence
    is measurable — see STALE / GHOSTED leads below.)
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
- STALE / GHOSTED leads — the ONE sanctioned exception to the blind-spot rule
  above, and a hard limit on the word "warm". Split silent threads by whether a
  follow-up was RECORDED after the lead's last inbound:
      select instance_id, profile_url,
             max(sent_at) filter (where direction='in')  as last_in,
             max(sent_at) filter (where direction='out') as last_out
      from messages group by 1, 2
  - TRUE GHOSTING (last_out > last_in AND last_in < now() - interval '30 days'):
    a recorded follow-up demonstrably went unanswered for 30+ days. You MAY call
    these leads stale / ghosted / in need of re-engagement — this is NOT the
    blind spot, because the outbound after the reply IS in the data.
  - AMBIGUOUS (no recorded outbound after last_in): the blind-spot rule applies
    in full — do NOT call the lead ghosted, dropped, OR still warm; recommend
    importing the thread history first.
  - Either way, NEVER call a lead "warm"/"hot" when its last inbound is 30+ days
    old, whatever its sentiment label says — say "replied positively N days ago,
    silent since" instead.
  - The 'following_up' pipeline stage is an EARLIER, broader version of this
    signal — auto-applied at 14 silent days (not 30) with a recorded follow-up.
    Counting following_up leads via pipeline_overview / pipeline_metrics is a
    safe way to quantify "going quiet on recorded follow-ups" without
    re-deriving it from threads, but call them "in follow-up / gone quiet", not
    "ghosted" — reserve ghosted/stale for the 30-day bar above.
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
- HYPOTHESIS FUNNEL — a hypothesis's stats roll up hypothesis_campaigns -> campaigns
  -> leads. The SAME PERSON can appear in more than one of a hypothesis's campaigns
  (known hazard, see messenger-campaign-person-dupes precedent) — always DEDUPE BY
  PERSON (instance_id, profile_url) before counting, taking the EARLIEST non-null
  milestone across their rows (min(invited_at) etc., ignoring nulls) so a person
  invited via one campaign and only messaged via another still shows one honest
  funnel. Use the hypothesis_overview tool for the ready-made rollup, or replicate its
  dedupe (HYPOTHESIS_OVERVIEW_SQL below) in a custom run_sql query — never sum
  campaign_metrics rows for a hypothesis's campaigns directly, that double-counts
  shared people. The usual replies-lag-invites / cohort-maturity caveats apply
  identically to hypothesis-level rates.
- MANUAL CRM PIPELINE vs the LH2 funnel — keep them separate. Questions about
  calls, negotiations, proposals, or won/lost CLIENTS are about the manual
  pipeline: answer them from leads.pipeline_stage / pipeline_substatus /
  lost_reason / assigned_to and the pipeline_events log — NOT from the milestone
  timestamps (invited_at…replied_at), which only track LH2's scripted funnel and
  know nothing about calls or deals. A lead with pipeline_stage NULL is simply
  not-yet-triaged (often a fresh reply awaiting a human); NULL here NEVER means
  the lead was dropped or lost — 'lost' is an explicit stage.
- TIME-IN-STAGE / pipeline velocity — reconstruct from pipeline_events, which is
  the only history. For a lead, the time it spent in a stage is the gap between
  the event that moved it INTO that stage and the next event; current-stage age
  is now() - leads.pipeline_stage_changed_at (use pipeline_metrics.stale_14d for
  a ready-made "stuck > 14 days" count per stage). Do not infer pipeline timing
  from milestone timestamps.
- All timestamps are timestamptz; use date_trunc for bucketing.
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
