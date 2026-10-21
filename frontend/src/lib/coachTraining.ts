// Client for the Coach training page: every `training.*` mode of POST /api/coach.
import { authFetch } from './api'
import type { CoachingIdea, CoachingIssue, NextAction } from './types'

export type PromptSource = 'seed' | 'feedback' | 'instruction' | 'manual' | 'revert'
export type MessageOrigin = 'sequence' | 'template' | 'manual' | 'unverified'

export interface PromptVersion {
  id: number
  n: number
  source: PromptSource
  parent_id: number | null
  changelog: string[]
  unaddressed: string[]
  note: string | null
  created_by_name: string
  created_at: string
  /** Only on a single-version read and on the working version. */
  prompt: string | null
  parent_prompt: string | null
}

export interface TrainingCase {
  id: number
  instance_id: string
  profile_url: string
  campaign_id: string | null
  cut_after_message_id: number | null
  note: string | null
  created_at: string
  full_name: string | null
  headline: string | null
  message_count: number
  last_in_at: string | null
  /** The latest run on the working version. */
  run_id: number | null
  run_at: string | null
  run_error: string | null
  run_cut_after_message_id: number | null
  pending_feedback: number
}

export interface TrainingState {
  scope: string
  revision: number
  working: PromptVersion
  published: { id: number; n: number; published_at: string | null; published_by_name: string | null } | null
  versions: PromptVersion[]
  cases: TrainingCase[]
  pending: { feedback: number; comments: number; good: number; bad: number; cases: number }
  leaks: { phrase: string; source: string }[]
  max_cases: number
}

export interface TrainingMessage {
  id: number | null
  direction: 'in' | 'out'
  body: string | null
  sent_at: string
  source: string | null
  origin: MessageOrigin | null
  step_type: string | null
  message_ordinal: number | null
}

export type CriticCriterion =
  | 'follows_instructions' | 'sounds_ai' | 'too_long' | 'generic' | 'invents_facts' | 'ignores_question'
  | 'multiple_asks' | 'wrong_language' | 'off_playbook' | 'bad_timing' | 'unfair_feedback' | 'other'

export interface CriticPoint {
  target: 'take' | 'idea' | 'feedback'
  index: number | null
  criterion: CriticCriterion
  severity: 'blocking' | 'minor'
  problem: string
  suggestion: string
}

export interface CriticRoundView {
  critique: { approve: boolean; summary: string; points: CriticPoint[] } | null
  error: string | null
  ideas: CoachingIdea[]
  notes_to_reviewer: string[]
}

/** The experimental coach/critic loop (training only). */
export interface CriticLoopView {
  pair: string
  role: 'draft' | 'final'
  agreed?: boolean
  stopped?: 'rounds' | 'time' | 'critic_error' | null
  revised?: boolean
  rounds?: CriticRoundView[]
}

export interface CoachOutputBody {
  next_action: NextAction
  summary: string
  issues: CoachingIssue[]
  ideas: CoachingIdea[]
  scope?: { hand_written: number; sequence: number; message_count: number; last_sent_at: string | null }
  loop?: CriticLoopView
}

export const CRITERION_LABEL: Record<CriticCriterion, string> = {
  follows_instructions: 'Instructions',
  sounds_ai: 'Sounds AI',
  too_long: 'Too long',
  generic: 'Generic',
  invents_facts: 'Invents facts',
  ignores_question: 'Ignores question',
  multiple_asks: 'Several asks',
  wrong_language: 'Language',
  off_playbook: 'Off playbook',
  bad_timing: 'Timing',
  unfair_feedback: 'Unfair feedback',
  other: 'Other',
}

export interface TrainingRun {
  id: number
  case_id: number
  version_id: number
  version_n: number
  cut_after_message_id: number | null
  thread_marker: string
  output: CoachOutputBody | null
  model: string | null
  error: string | null
  created_at: string
  /** The thread this run read (up to its cut) has changed since. */
  stale: boolean
}

export type FeedbackTarget = 'take' | 'idea' | 'issue'
export type Verdict = 'good' | 'bad'

export interface TrainingFeedback {
  id: number
  run_id: number
  case_id: number
  version_id: number
  target: FeedbackTarget
  target_index: number | null
  verdict: Verdict | null
  comment: string | null
  consumed_by_version_id: number | null
  created_by_name: string
  updated_at: string
}

export interface TrainingCaseDetail {
  case: TrainingCase
  thread: TrainingMessage[]
  runs: TrainingRun[]
  feedback: TrainingFeedback[]
}

export interface ConversationHit {
  instance_id: string
  profile_url: string
  campaign_id: string | null
  full_name: string | null
  headline: string | null
  message_count: number
  hand_written: number
  last_in_at: string | null
  in_training: boolean
}

export interface MovedPointer {
  version_id: number
  n: number
  revision: number
  changelog?: string[]
  unaddressed?: string[]
  unchanged?: boolean
}

export class TrainingError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message)
    this.name = 'TrainingError'
  }
}

async function call<T>(mode: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await authFetch('/api/coach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, ...body }),
  })
  let parsed: unknown = null
  try { parsed = await res.json() } catch { /* empty or non-JSON body */ }
  const record = (parsed ?? {}) as { error?: unknown; code?: unknown }
  if (!res.ok) {
    throw new TrainingError(
      typeof record.error === 'string' ? record.error : `HTTP ${res.status}`,
      res.status,
      typeof record.code === 'string' ? record.code : null,
    )
  }
  return parsed as T
}

export const coachTraining = {
  state: () => call<TrainingState>('training.state'),
  version: (versionId: number) => call<{ version: PromptVersion }>('training.version', { version_id: versionId }),
  search: (query: string) => call<{ results: ConversationHit[] }>('training.search', { query }),
  caseDetail: (caseId: number) => call<TrainingCaseDetail>('training.case', { case_id: caseId }),
  addCase: (hit: Pick<ConversationHit, 'instance_id' | 'profile_url' | 'campaign_id'>) =>
    call<{ case_id: number }>('training.addCase', hit),
  setCut: (caseId: number, cutAfterMessageId: number | null) =>
    call<{ ok: true }>('training.setCut', { case_id: caseId, cut_after_message_id: cutAfterMessageId }),
  archiveCase: (caseId: number) => call<{ ok: true }>('training.archiveCase', { case_id: caseId }),
  run: (caseId: number, versionId?: number, critic = false) =>
    call<{ run: TrainingRun | null; draft?: TrainingRun | null }>('training.run', {
      case_id: caseId, version_id: versionId, ...(critic ? { critic: true } : {}),
    }),
  feedback: (args: { runId: number; target: FeedbackTarget; targetIndex: number | null; verdict: Verdict | null; comment: string | null }) =>
    call<{ feedback: TrainingFeedback }>('training.feedback', {
      run_id: args.runId, target: args.target, target_index: args.targetIndex, verdict: args.verdict, comment: args.comment,
    }),
  improve: (expectedRevision: number, general: string) =>
    call<MovedPointer>('training.improve', { expected_revision: expectedRevision, general }),
  instruct: (expectedRevision: number, instruction: string) =>
    call<MovedPointer>('training.instruct', { expected_revision: expectedRevision, instruction }),
  saveManual: (expectedRevision: number, prompt: string) =>
    call<MovedPointer>('training.saveManual', { expected_revision: expectedRevision, prompt }),
  revert: (expectedRevision: number, versionId: number) =>
    call<MovedPointer>('training.revert', { expected_revision: expectedRevision, version_id: versionId }),
  publish: (expectedRevision: number, versionId: number) =>
    call<MovedPointer>('training.publish', { expected_revision: expectedRevision, version_id: versionId }),
}

export type CoachTrainingClient = typeof coachTraining

export const PROMPT_SOURCE_LABEL: Record<PromptSource, string> = {
  seed: 'Built-in prompt',
  feedback: 'Improved from feedback',
  instruction: 'AI instruction',
  manual: 'Edited by hand',
  revert: 'Restored',
}

export const ORIGIN_LABEL: Record<MessageOrigin, string> = {
  sequence: 'Sequence',
  template: 'Template',
  manual: 'Hand-written',
  unverified: 'Unverified',
}

/** A minimal line diff (LCS) for the version history: enough for prompts of a
 *  few hundred lines. */
export function lineDiff(before: string, after: string): { kind: 'same' | 'add' | 'del'; text: string }[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: { kind: 'same' | 'add' | 'del'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ kind: 'del', text: a[i] }); i++ }
    else { out.push({ kind: 'add', text: b[j] }); j++ }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] })
  while (j < m) out.push({ kind: 'add', text: b[j++] })
  return out
}
