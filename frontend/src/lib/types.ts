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
}

export interface DailyActivity {
  day: string
  instance_id: string
  event_type: string
  cnt: number
}

export interface Lead {
  id: string
  instance_id: string
  campaign_id: string
  profile_url: string
  full_name: string | null
  headline: string | null
  company: string | null
  invited_at: string | null
  connected_at: string | null
  first_message_at: string | null
  replied_at: string | null
  last_action_at: string | null
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

/** Product/voice grounding for the coach, stored in instances.config.playbook. */
export interface Playbook {
  product?: string
  value_prop?: string
  tone?: string
  dos?: string[]
  donts?: string[]
  cta?: string
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

/** One daily AI-generated pipeline digest (briefings table). */
export interface Briefing {
  id: string
  briefing_date: string
  headline: string | null
  summary: string | null
  sections: BriefingSection[]
  actions: BriefingAction[]
  risks: BriefingRisk[]
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
  error?: string
}
