import { useCallback, useRef, useState } from 'react'
import {
  draftFromReview, needsAutoResetConfirmation, newMutationId, saveReplyReview, setReplyWorkflow,
  validateReview, type ReplyReview, type ReplyReviewDraft, type ReplyWorkflowMutation,
  type SaveReplyReviewResult,
} from './replyReview'

export interface ReplyConflict {
  status: 409
  message: string
  current: unknown
}
export interface ReplyReviewActions {
  saving: boolean
  error: string | null
  conflict: ReplyConflict | null
  saveReview: (request: SaveReviewInput) => Promise<SaveReplyReviewResult | null>
  saveWorkflow: (request: SaveWorkflowInput) => Promise<SaveReplyReviewResult | null>
  clearError: () => void
}
export interface SaveReviewInput {
  instance_id: string
  profile_url: string
  message_id: number
  expected_review_revision: number
  review: ReplyReviewDraft
  workflow?: ReplyWorkflowMutation
  confirmAutoReset?: boolean
}
export interface SaveWorkflowInput {
  instance_id: string
  profile_url: string
  workflow: ReplyWorkflowMutation
}

function toError(reason: unknown): Error & { status?: number; current?: unknown } {
  return reason instanceof Error ? reason as Error & { status?: number; current?: unknown } : new Error(String(reason))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]))
  }
  return value
}

function requestKey(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function useReplyReviewActions(onSaved?: () => void): ReplyReviewActions {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ReplyConflict | null>(null)
  const pendingMutations = useRef(new Map<string, string>())
  const run = useCallback(async (key: string, work: () => Promise<SaveReplyReviewResult>) => {
    setSaving(true); setError(null); setConflict(null)
    try {
      const result = await work()
      pendingMutations.current.delete(key)
      onSaved?.()
      return result
    } catch (reason: unknown) {
      const err = toError(reason)
      // A network failure is retryable and must retain the same idempotency key.
      // Definitive API responses (including conflicts and validation failures) are
      // a new logical attempt and therefore discard the pending key.
      if (err.status != null) pendingMutations.current.delete(key)
      if (err.status === 409) setConflict({ status: 409, message: err.message, current: err.current })
      else setError(err.message)
      return null
    } finally { setSaving(false) }
  }, [onSaved])

  const saveReview = useCallback(async (request: SaveReviewInput) => {
    const errors = validateReview(request.review)
    if (Object.keys(errors).length) { setError(Object.values(errors)[0]); return null }
    if (needsAutoResetConfirmation(request.review) && !request.confirmAutoReset) {
      setError('Подтвердите очистку несовместимых причин и intent для auto.')
      return null
    }
    const payload = {
      action: 'save_reply_review' as const, instance_id: request.instance_id,
      profile_url: request.profile_url, message_id: request.message_id,
      expected_review_revision: request.expected_review_revision, review: request.review,
      workflow: request.workflow,
    }
    const key = requestKey(payload)
    const mutationId = pendingMutations.current.get(key) ?? newMutationId()
    pendingMutations.current.set(key, mutationId)
    return run(key, () => saveReplyReview({ ...payload, mutation_id: mutationId }))
  }, [run])

  const saveWorkflow = useCallback(async (request: SaveWorkflowInput) => {
    const payload = {
      action: 'set_reply_workflow' as const, instance_id: request.instance_id,
      profile_url: request.profile_url, workflow: request.workflow,
    }
    const key = requestKey(payload)
    const mutationId = pendingMutations.current.get(key) ?? newMutationId()
    pendingMutations.current.set(key, mutationId)
    return run(key, () => setReplyWorkflow({ ...payload, mutation_id: mutationId }))
  }, [run])

  const clearError = useCallback(() => { setError(null); setConflict(null) }, [])
  return { saving, error, conflict, saveReview, saveWorkflow, clearError }
}

export function reviewDraftForMessage(review: ReplyReview | null | undefined): ReplyReviewDraft {
  return draftFromReview(review)
}
