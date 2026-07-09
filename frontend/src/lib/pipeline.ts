// Canonical vocabulary + helpers for the manual CRM pipeline overlay.
//
// Keep in sync with frontend/api/_lib/pipeline.ts — the same stage ids, ranks,
// and substatus slugs are validated server-side by /api/pipeline. Changing a
// slug/label here without changing it there (or vice versa) will silently drop
// moves on the floor.
import type { Lead, PipelineEvent } from './types'
import { leadKey } from './leads'

export type PipelineStageId =
  | 'first_contact'
  | 'interested'
  | 'neutral'
  | 'negative'
  | 'negotiations_call'
  | 'call_booked'
  | 'call_done'
  | 'proposal_in_progress'
  | 'proposal_presented'
  | 'client'
  | 'lost'

export interface PipelineStage {
  id: PipelineStageId
  label: string
  /** Funnel depth. Several stages can share a rank (rank-1 sentiment split,
   *  rank-7 win/loss) — rank is "how far down the happy path", not a unique key. */
  rank: number
  /** Allowed substatus slugs for this stage ([] = no substatus picker). */
  substatuses: string[]
}

// Order matters: this is the left-to-right board column order.
export const PIPELINE_STAGES: PipelineStage[] = [
  { id: 'first_contact', label: 'First Contact', rank: 0, substatuses: [] },
  { id: 'interested', label: 'Interested', rank: 1, substatuses: [] },
  { id: 'neutral', label: 'Neutral', rank: 1, substatuses: [] },
  { id: 'negative', label: 'Negative', rank: 1, substatuses: ['soft_no', 'hard_no', 'lost'] },
  { id: 'negotiations_call', label: 'Negotiations about Call', rank: 2, substatuses: [] },
  { id: 'call_booked', label: 'Call Booked', rank: 3, substatuses: [] },
  { id: 'call_done', label: 'Call Done', rank: 4, substatuses: ['proposal', 'later', 'not_a_fit'] },
  { id: 'proposal_in_progress', label: 'Proposal In Progress', rank: 5, substatuses: [] },
  {
    id: 'proposal_presented',
    label: 'Proposal Presented',
    rank: 6,
    substatuses: ['waiting_decision', 'contract', 'needs_changes'],
  },
  { id: 'client', label: 'Client (Contracted)', rank: 7, substatuses: [] },
  // 'lost' requires a free-text lost_reason (captured on the move, not a substatus).
  { id: 'lost', label: 'Lost', rank: 7, substatuses: [] },
]

// Explicit display labels for substatus slugs; fall back to a generic humanizer
// for anything unmapped.
const SUBSTATUS_OVERRIDE: Record<string, string> = {
  soft_no: 'Soft no',
  hard_no: 'Hard no',
  lost: 'Lost',
  proposal: 'Proposal',
  later: 'Later',
  not_a_fit: 'Not a fit',
  waiting_decision: 'Waiting for decision',
  contract: 'Contract',
  needs_changes: 'Needs changes in proposal',
}

function humanize(slug: string): string {
  const s = slug.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function substatusLabel(slug: string | null | undefined): string {
  if (!slug) return ''
  return SUBSTATUS_OVERRIDE[slug] ?? humanize(slug)
}

/** Convenience map for callers that want to iterate labels directly. */
export const SUBSTATUS_LABEL: Record<string, string> = { ...SUBSTATUS_OVERRIDE }

const BY_ID = new Map<string, PipelineStage>(PIPELINE_STAGES.map((s) => [s.id, s]))

export function stageById(id: string | null | undefined): PipelineStage | undefined {
  return id ? BY_ID.get(id) : undefined
}

export function stageLabel(id: string | null | undefined): string {
  return stageById(id)?.label ?? (id ?? '')
}

/** Funnel depth of a stage; -1 for null/unknown (never entered the pipeline). */
export function pipelineRank(stage: string | null | undefined): number {
  return stageById(stage)?.rank ?? -1
}

export function stageAllowsSubstatus(
  stage: string | null | undefined,
  sub: string | null | undefined,
): boolean {
  if (!sub) return false
  return !!stageById(stage)?.substatuses.includes(sub)
}

// Per-stage accent, drawn from the app's existing theme tokens (see styles.css
// :root). Distinct enough to read a column at a glance; all resolve per-theme.
export const STAGE_COLOR: Record<PipelineStageId, string> = {
  first_contact: 'var(--text-muted)',
  interested: 'var(--success)',
  neutral: 'var(--info)',
  negative: 'var(--chart-cat-pink)',
  negotiations_call: 'var(--accent)',
  call_booked: 'var(--chart-cat-teal)',
  call_done: 'var(--chart-cat-lime)',
  proposal_in_progress: 'var(--warning)',
  proposal_presented: 'var(--chart-cat-amber)',
  client: 'var(--purple)',
  lost: 'var(--danger)',
}

export function stageColor(id: string | null | undefined): string {
  return (id && STAGE_COLOR[id as PipelineStageId]) || 'var(--text-muted)'
}

/** Whole days since the lead entered its current stage (UTC-safe, floored).
 *  null when the lead has never been staged. Mirrors daysBetween() in leads.ts. */
export function daysInStage(lead: Lead): number | null {
  if (!lead.pipeline_stage_changed_at) return null
  const d =
    (Date.now() - new Date(lead.pipeline_stage_changed_at).getTime()) / 86_400_000
  return d < 0 ? 0 : Math.floor(d)
}

/** Happy-path checkpoints for the pipeline funnel (Funnel.tsx). A lead has
 *  "reached" a checkpoint when its deepest-ever rank is >= the checkpoint rank —
 *  EXCEPT the terminal "Client" checkpoint, which is matched by stage id: 'client'
 *  and 'lost' share rank 7, so a rank threshold would wrongly count Lost leads as
 *  Clients. `terminalId` flags the checkpoint that must match a stage id exactly. */
export const PIPELINE_CHECKPOINTS: Array<{
  id: PipelineStageId
  label: string
  rank: number
  terminalId?: PipelineStageId
}> = [
  { id: 'interested', label: 'Interested', rank: 1 },
  { id: 'negotiations_call', label: 'Negotiations about Call', rank: 2 },
  { id: 'call_booked', label: 'Call Booked', rank: 3 },
  { id: 'call_done', label: 'Call Done', rank: 4 },
  { id: 'proposal_presented', label: 'Proposal Presented', rank: 6 },
  { id: 'client', label: 'Client', rank: 7, terminalId: 'client' },
]

/** Per-person pipeline reach across the current stage ∪ event history, for the
 *  funnel. Keyed by leadKey(instance, profile) — the same person can hold a lead
 *  row in several campaigns of one instance (invite + messenger), and keying by
 *  lead id would count them once per row. Only events whose lead_id is among
 *  `leads` are counted — callers pass a lead SUBSET (e.g. one campaign) but the
 *  shared pipelineEvents list is global, so unscoped events would leak other
 *  campaigns' progress into the counts. */
export interface LeadReach {
  /** Deepest happy-path rank ever reached (current stage or any to_stage). */
  rank: number
  /** Whether this lead ever became a Client (stage id 'client'), distinct from
   *  rank 7 which 'lost' also occupies. */
  isClient: boolean
}

export function reachByPerson(leads: Lead[], events: PipelineEvent[]): Map<string, LeadReach> {
  const keyById = new Map(leads.map((l) => [l.id, leadKey(l.instance_id, l.profile_url)]))
  const out = new Map<string, LeadReach>()
  const bump = (key: string, stage: string | null) => {
    // 'lost' is a terminal off-ramp, not happy-path depth: it shares rank 7 with
    // 'client', so letting it through would count a person bulk-moved straight to
    // Lost as having "reached" every checkpoint up to Proposal Presented. Treat it
    // as rank 0 — the person entered the pipeline (kept in the reach map) but
    // clears no checkpoint; any real stage they touched still sets their depth.
    const rank = stage === 'lost' ? 0 : pipelineRank(stage)
    const isClient = stage === 'client'
    if (rank < 0 && !isClient) return
    const cur = out.get(key) ?? { rank: -1, isClient: false }
    out.set(key, { rank: Math.max(cur.rank, rank), isClient: cur.isClient || isClient })
  }
  for (const l of leads) bump(leadKey(l.instance_id, l.profile_url), l.pipeline_stage)
  for (const e of events) {
    if (e.kind !== 'stage') continue
    const key = keyById.get(e.lead_id)
    if (key) bump(key, e.to_stage)
  }
  return out
}

/** Count of leads that have reached a given checkpoint, honoring the terminal
 *  stage-id match for 'Client' (so Lost leads don't count as Clients). */
export function checkpointCount(
  reach: Map<string, LeadReach>,
  cp: { rank: number; terminalId?: PipelineStageId },
): number {
  let n = 0
  for (const r of reach.values()) {
    if (cp.terminalId === 'client' ? r.isClient : r.rank >= cp.rank) n++
  }
  return n
}
