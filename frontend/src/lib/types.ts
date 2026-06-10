export interface Instance {
  id: string
  label: string
  last_sync_at: string | null
  agent_version: string | null
  account_name: string | null
  account_url: string | null
  account_avatar: string | null
}

export interface Message {
  id: number
  instance_id: string
  campaign_id: string | null
  profile_url: string
  direction: string
  body: string | null
  sent_at: string
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

export interface DashboardData {
  instances: Instance[]
  campaigns: CampaignMetrics[]
  activity: DailyActivity[]
  leads: Lead[]
  syncRuns: SyncRun[]
  messages: Message[]
  annotations: Annotation[]
  steps: CampaignStep[]
  error?: string
}
