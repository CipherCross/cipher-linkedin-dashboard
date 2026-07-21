export interface Instance {
  id: string
  label: string
  last_sync_at: string | null
  agent_version: string | null
  account_name: string | null
  account_url: string | null
  account_avatar: string | null
  // Desired overrides edited on the Health page; merged over the notebook's local
  // config.yaml by the sync agent (remote wins). null = never configured online.
  config: Record<string, unknown> | null
  config_updated_at: string | null
}

export type Sentiment =
  | 'positive'
  | 'neutral'
  | 'negative'
  | 'objection'
  | 'referral'
  | 'auto'

export interface Message {
  id: number
  instance_id: string
  campaign_id: string | null
  profile_url: string
  direction: string
  body: string | null
  sent_at: string
  sentiment: Sentiment | null
  reason: string | null
  classified_at: string | null
  classified_model?: string | null
  /** 'sync' = written by the LH2 agent (sent_at is the action-run time);
   *  'manual' = pasted by the SDR via Import history (real message time). */
  source?: string | null
}

export interface Annotation {
  id: number
  instance_id: string | null
  campaign_id: string | null
  note: string
  noted_at: string
}

export interface CampaignStep {
  campaign_id: string
  step_index: number
  step_label: string | null
  step_type: string | null
  template_body: string | null
  sent_count: number
  replied_count: number
  current_count: number
}

export interface CampaignMetrics {
  campaign_id: string
  campaign_name: string
  instance_id: string
  status: string
  total_leads: number
  invites_sent: number
  accepted: number
  replies: number
  acceptance_rate: number | null
  reply_rate: number | null
  last_activity_at: string | null
  /** Leads added within the selected range. Only present on rows computed
   *  client-side by rangedCampaigns — the campaign_metrics view has no ranges. */
  leads_added?: number
}

export interface DailyActivity {
  day: string
  instance_id: string
  event_type: string
  cnt: number
}

/** Inferred (or SDR-confirmed) gender for a lead. `unknown` is a first-class
 *  value — name-based inference is unreliable for many naming cultures. */
export type Gender = 'male' | 'female' | 'unknown'

export interface Lead {
  id: string
  instance_id: string
  campaign_id: string
  profile_url: string
  full_name: string | null
  headline: string | null
  company: string | null
  /** When the lead was queued into the campaign (LH2 add_to_target_date;
   *  earliest milestone as fallback). null = unknown, not "never". */
  added_at: string | null
  invited_at: string | null
  connected_at: string | null
  first_message_at: string | null
  replied_at: string | null
  last_action_at: string | null
  // --- Manual CRM pipeline overlay (edited by SDRs, not synced from LH2) ------
  // May be absent on a pre-migration DB — DataContext falls back to the old
  // column list, leaving these undefined/null.
  pipeline_stage: string | null
  pipeline_substatus: string | null
  lost_reason: string | null
  pipeline_stage_changed_at: string | null
  assigned_to: number | null
  // --- Demographics (migration 041) + photo (migration 042) ------------------
  // All optional: the LEAD_COLUMNS retry ladder drops these rungs on a DB that
  // hasn't run the migrations yet, leaving them undefined. Age is arithmetic
  // (birth-year bounds), gender is inferred (Haiku) or SDR-confirmed.
  education_start_year?: number | null
  first_job_start_year?: number | null
  birth_year_min?: number | null
  birth_year_max?: number | null
  gender?: Gender | null
  gender_confidence?: number | null
  demo_inferred_at?: string | null
  /** 'claude-haiku-4-5' = AI-inferred; 'manual' = SDR-confirmed (ground truth). */
  demo_model?: string | null
  /** Bucket-relative path in the public `lead-photos` Storage bucket. Display
   *  only — never used as an inference input. */
  photo_path?: string | null
  photo_synced_at?: string | null
}

/** A named, shareable sourcing search (Apollo / Sales Navigator / esun / …).
 *  Sourcers apply these filter recipes by hand — the app never executes them.
 *  `filters` is a flat platform-specific bag (string / number / boolean /
 *  string[] values). See migration 040 (`saved_searches`). */
export interface SavedSearch {
  id: number
  name: string
  platform: string
  description: string | null
  include_keywords: string[]
  exclude_keywords: string[]
  boolean_query: string | null
  filters: Record<string, string | number | boolean | string[]>
  notes: string | null
  author: string | null
  archived: boolean
  /** Which hypothesis this search recipe executes for (migration 043); null =
   *  unassigned. The EXECUTION side of an ICP's keywords — IcpIndustry below is
   *  the DEFINITION side. */
  hypothesis_id?: number | null
  created_at: string
  updated_at: string
}

// --- ICP + Hypothesis layer (see migration 043) ------------------------------

/** Ideal Customer Profile — fully structured, no Markdown body. Seed: "Web 2 Mob". */
export interface Icp {
  id: number
  name: string
  airtable_url: string | null
  main_product: string | null
  core_sphere: string | null
  secondary_sphere: string | null
  product_stage: string | null
  monetization: string | null
  features_note: string | null
  purchase_triggers: string[]
  features: string[]
  company_countries: string[]
  company_headcount: string | null
  company_age: string | null
  apollo_industries: string[]
  funding: string | null
  dev_team_availability: string | null
  dev_team_location: string | null
  /** The one ICP-wide exclude list. Include keywords live per-industry on
   *  IcpIndustry below — the two scopes never overlap (migration 044). */
  exclude_keywords: string[]
  archived: boolean
  created_at: string
  updated_at: string
}

/** A buyer persona attached to one ICP. `kind` is free text (seed:
 *  management/product/technical), not an enum — more can be added in the editor. */
export interface IcpPersona {
  id: number
  icp_id: number
  kind: string
  job_titles: string[]
  age_range: string | null
  location: string | null
  background: string | null
  profile_status: string | null
  connections_note: string | null
  followers_note: string | null
  sort: number
  created_at: string
  updated_at: string
}

/** Per-sub-industry INCLUDE keyword list on one ICP. Exclude keywords are
 *  ICP-wide (see Icp.exclude_keywords); this scope holds includes only
 *  (migration 044). saved_searches.hypothesis_id below is the execution side. */
export interface IcpIndustry {
  id: number
  icp_id: number
  name: string
  include_keywords: string[]
  created_at: string
  updated_at: string
}

/** A named, testable go-to-market hypothesis: groups campaigns under one ICP
 *  for stats. `icp_id` is nullable — a hypothesis can be created unassigned. */
export interface Hypothesis {
  id: number
  name: string
  icp_id: number | null
  description: string | null
  archived: boolean
  created_at: string
  updated_at: string
}

/** hypothesis_campaigns join row: a campaign belongs to AT MOST ONE hypothesis
 *  (unique on campaign_id) — the agent never writes to this table. */
export interface HypothesisCampaign {
  hypothesis_id: number
  campaign_id: string
  created_at: string
}

/** A person on the team who can own leads in the manual pipeline. */
export interface TeamMember {
  id: number
  name: string
  active: boolean
  created_at: string
}

/** A free-text note attached to one lead's pipeline card. */
export interface LeadNote {
  id: number
  lead_id: string
  author: string | null
  body: string
  created_at: string
}

/** Append-only log of manual pipeline actions (stage moves + assignments),
 *  used to reconstruct "ever reached stage X" for the pipeline funnel. */
export interface PipelineEvent {
  id: number
  lead_id: string
  kind: 'stage' | 'assignment'
  actor: string | null
  from_stage: string | null
  to_stage: string | null
  from_substatus: string | null
  to_substatus: string | null
  // Assignee change events log member NAMES (text), not ids.
  from_assignee: string | null
  to_assignee: string | null
  lost_reason: string | null
  occurred_at: string
}

export interface SyncRun {
  id: string
  instance_id: string
  started_at: string
  finished_at: string | null
  status: string
  rows_upserted: number | null
  error: string | null
}

// --- AI conversation coaching (see /api/coach) -------------------------------

export type NextAction = 'reply' | 'wait' | 'book_call' | 'refer' | 'close' | 'none'

export type IssueKind =
  | 'ignored_question'
  | 'too_long'
  | 'too_salesy'
  | 'generic'
  | 'slow_followup'
  | 'no_cta'
  | 'multiple_asks'
  | 'pushy'
  | 'other'

export type IssueSeverity = 'low' | 'med' | 'high'

export interface CoachingIssue {
  kind: IssueKind
  severity: IssueSeverity
  quote: string // the SDR's own outbound snippet that was the problem
  fix: string // how to do it better
}

/** Per-conversation coaching as returned by POST /api/coach. */
export interface Coaching {
  next_action: NextAction
  issues: CoachingIssue[]
  tips: string[]
  summary: string | null
  last_msg_marker: string | null
  coached_at: string | null
  model: string | null
  cached?: boolean
}

export interface CoachingPattern {
  issue: string
  count: number
  advice: string
}

/** Per-account rolled-up self-correction digest (coaching_digest table). */
export interface CoachingDigest {
  instance_id: string
  summary: string | null
  patterns: CoachingPattern[]
  computed_at: string | null
  model: string | null
}

// --- Morning Briefing (see /api/briefing) ------------------------------------

export interface BriefingSection {
  title: string
  body: string
}

export interface BriefingAction {
  text: string
  priority: 'high' | 'med' | 'low'
}

export interface BriefingRisk {
  kind: string
  severity: 'low' | 'med' | 'high'
  text: string
}

/** A day-over-day delta vs the previous briefing (what changed / progressed). */
export interface BriefingChange {
  text: string
  trend?: 'up' | 'down' | 'flat' | 'new' | 'resolved'
}

/** One headline number in the briefing's key-metrics strip. */
export interface BriefingMetric {
  label: string
  value: string
  note?: string
}

/** One daily AI-generated pipeline digest (briefings table). */
export interface Briefing {
  id: string
  briefing_date: string
  headline: string | null
  summary: string | null
  changes: BriefingChange[]
  sections: BriefingSection[]
  actions: BriefingAction[]
  risks: BriefingRisk[]
  metrics?: BriefingMetric[]
  model: string | null
  created_at: string
}

export interface DashboardData {
  instances: Instance[]
  campaigns: CampaignMetrics[]
  activity: DailyActivity[]
  leads: Lead[]
  syncRuns: SyncRun[]
  messages: Message[]
  annotations: Annotation[]
  steps: CampaignStep[]
  briefing: Briefing | null
  prevBriefing: Briefing | null
  teamMembers: TeamMember[]
  pipelineEvents: PipelineEvent[]
  savedSearches: SavedSearch[]
  icps: Icp[]
  icpPersonas: IcpPersona[]
  icpIndustries: IcpIndustry[]
  hypotheses: Hypothesis[]
  hypothesisCampaigns: HypothesisCampaign[]
  error?: string
}
