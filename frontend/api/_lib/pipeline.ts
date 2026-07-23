// Canonical manual-CRM pipeline vocabulary: the ordered stages, their display
// labels, funnel rank, and the substatuses each stage allows. This is the single
// source of truth the serverless pipeline API validates against.
//
// Keep in sync with frontend/src/lib/pipeline.ts (api/ and src/ are separate TS
// roots — no cross-imports; mirror any change by hand, same as the
// api/_lib/conversationImport.ts <-> src/lib/parseLinkedInThread.ts pair).

export interface PipelineStage {
  id: string
  label: string
  rank: number
  substatuses: string[]
}

// Order matters: this is the funnel order shown in the UI. Rank can repeat
// (interested/neutral/negative share rank 1; client/lost share rank 7).
export const PIPELINE_STAGES: PipelineStage[] = [
  { id: 'first_contact', label: 'First Contact', rank: 0, substatuses: [] },
  { id: 'interested', label: 'Interested', rank: 1, substatuses: [] },
  { id: 'neutral', label: 'Neutral', rank: 1, substatuses: [] },
  { id: 'negative', label: 'Negative', rank: 1, substatuses: ['soft_no', 'hard_no', 'lost'] },
  // Semi-warm holding lane: replied at least once, then went silent on recorded
  // follow-ups. Shares rank 1 — a parking spot, not deeper funnel progress.
  { id: 'following_up', label: 'Following Up', rank: 1, substatuses: [] },
  { id: 'negotiations_call', label: 'Negotiations about Call', rank: 2, substatuses: [] },
  { id: 'call_booked', label: 'Call Booked', rank: 3, substatuses: [] },
  { id: 'call_done', label: 'Call Done', rank: 4, substatuses: ['proposal', 'later', 'not_a_fit'] },
  { id: 'proposal_in_progress', label: 'Proposal In Progress', rank: 5, substatuses: [] },
  { id: 'proposal_presented', label: 'Proposal Presented', rank: 6, substatuses: ['waiting_decision', 'contract', 'needs_changes'] },
  { id: 'client', label: 'Client (Contracted)', rank: 7, substatuses: [] },
  { id: 'lost', label: 'Lost', rank: 7, substatuses: [] },
]

export const PIPELINE_STAGE_IDS: string[] = PIPELINE_STAGES.map((s) => s.id)

const BY_ID = new Map(PIPELINE_STAGES.map((s) => [s.id, s]))

/** Funnel rank of a stage slug, or -1 if the slug is unknown. */
export function pipelineRank(stage: string): number {
  return BY_ID.get(stage)?.rank ?? -1
}

/** True only if `stage` is a known slug AND lists `substatus` as allowed. */
export function stageAllowsSubstatus(stage: string, substatus: string): boolean {
  return BY_ID.get(stage)?.substatuses.includes(substatus) ?? false
}
