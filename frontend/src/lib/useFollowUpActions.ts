import { useCallback, useMemo } from 'react'
import { adminPost } from './admin'
import { useData } from './DataContext'
import { followUpKey, followUpStateMap } from './followUps'
import { useToast } from './ToastContext'
import { usePipelineActions } from './usePipelineActions'
import type {
  FollowUpMutationResult,
  FollowUpState,
  Lead,
} from './types'

type FollowUpAction =
  | 'schedule_follow_up'
  | 'reschedule_follow_up'
  | 'reassign_follow_up'
  | 'complete_follow_up'
  | 'skip_follow_up'
  | 'cancel_follow_up'

interface MutationOptions {
  action: FollowUpAction
  lead: Lead
  state?: FollowUpState | null
  ownerId?: number | null
  nextDate?: string | null
  reason?: string | null
}

class FollowUpApiError extends Error {
  status: number
  state: FollowUpState | null

  constructor(message: string, status: number, state: FollowUpState | null = null) {
    super(message)
    this.status = status
    this.state = state
  }
}

function optimisticState(
  lead: Lead,
  current: FollowUpState | null,
  action: FollowUpAction,
  ownerId: number | null | undefined,
  nextDate: string | null | undefined,
  actor: string,
): FollowUpState {
  const now = new Date().toISOString()
  const base: FollowUpState = current ?? {
    instance_id: lead.instance_id,
    profile_url: lead.profile_url,
    next_follow_up_date: null,
    owner_id: null,
    revision: 0,
    last_event_id: null,
    last_mutation_id: null,
    created_at: now,
    updated_at: now,
    updated_by: actor,
    archived_at: null,
  }

  let due = base.next_follow_up_date
  let owner = base.owner_id
  if (action === 'schedule_follow_up' || action === 'reschedule_follow_up') {
    due = nextDate ?? due
    if (ownerId !== undefined && ownerId !== null) owner = ownerId
  } else if (action === 'reassign_follow_up') {
    owner = ownerId ?? owner
  } else if (action === 'complete_follow_up' || action === 'skip_follow_up') {
    due = nextDate ?? null
    if (nextDate && ownerId != null) owner = ownerId
  } else if (action === 'cancel_follow_up') {
    due = null
  }

  return {
    ...base,
    next_follow_up_date: due,
    owner_id: owner,
    revision: base.revision + 1,
    updated_at: now,
    updated_by: actor,
    archived_at: null,
  }
}

export function useFollowUpActions() {
  const { data, patchFollowUpState, refetch } = useData()
  const { actor, setActor, members } = usePipelineActions()
  const toast = useToast()
  const states = useMemo(
    () => followUpStateMap(data?.followUpStates ?? []),
    [data?.followUpStates],
  )

  const mutate = useCallback(
    async ({
      action,
      lead,
      state: suppliedState,
      ownerId,
      nextDate,
      reason,
    }: MutationOptions): Promise<FollowUpMutationResult> => {
      const cleanActor = actor.trim()
      if (!cleanActor) throw new Error('Pick “Who am I” before updating a follow-up.')
      const key = followUpKey(lead.instance_id, lead.profile_url)
      const current = suppliedState === undefined ? states.get(key) ?? null : suppliedState
      const snapshot = current
      const optimistic = optimisticState(
        lead,
        current,
        action,
        ownerId,
        nextDate,
        cleanActor,
      )
      patchFollowUpState(key, optimistic)

      try {
        const res = await adminPost('/api/pipeline', {
          action,
          instance_id: lead.instance_id,
          profile_url: lead.profile_url,
          actor: cleanActor,
          expected_revision: current?.revision ?? 0,
          mutation_id: crypto.randomUUID(),
          owner_id: ownerId ?? null,
          next_follow_up_date: nextDate ?? null,
          reason: reason ?? null,
        })
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
        if (!res.ok) {
          const authoritative = (body.state as FollowUpState | null | undefined) ?? null
          throw new FollowUpApiError(
            (body.error as string) || `HTTP ${res.status}`,
            res.status,
            authoritative,
          )
        }
        const result = body as unknown as FollowUpMutationResult
        patchFollowUpState(key, result.state)
        return result
      } catch (error) {
        if (error instanceof FollowUpApiError && error.status === 409 && error.state) {
          patchFollowUpState(key, error.state)
          toast.error(`Follow-up changed elsewhere: ${error.message}`)
          throw error
        }
        patchFollowUpState(key, snapshot)
        const message = error instanceof Error ? error.message : String(error)
        toast.error(`Couldn't update follow-up: ${message}`)
        if (error instanceof FollowUpApiError && error.status === 503) refetch()
        throw error
      }
    },
    [actor, patchFollowUpState, refetch, states, toast],
  )

  return {
    actor,
    setActor,
    members,
    states,
    schedule: (lead: Lead, ownerId: number, nextDate: string) =>
      mutate({ action: 'schedule_follow_up', lead, ownerId, nextDate }),
    reschedule: (lead: Lead, state: FollowUpState, nextDate: string) =>
      mutate({
        action: 'reschedule_follow_up',
        lead,
        state,
        ownerId: state.owner_id,
        nextDate,
      }),
    reassign: (lead: Lead, state: FollowUpState, ownerId: number) =>
      mutate({ action: 'reassign_follow_up', lead, state, ownerId }),
    complete: (
      lead: Lead,
      state: FollowUpState,
      next?: { ownerId: number; date: string } | null,
    ) =>
      mutate({
        action: 'complete_follow_up',
        lead,
        state,
        ownerId: next?.ownerId ?? null,
        nextDate: next?.date ?? null,
      }),
    skip: (
      lead: Lead,
      state: FollowUpState,
      reason: string,
      next?: { ownerId: number; date: string } | null,
    ) =>
      mutate({
        action: 'skip_follow_up',
        lead,
        state,
        reason,
        ownerId: next?.ownerId ?? null,
        nextDate: next?.date ?? null,
      }),
    cancel: (lead: Lead, state: FollowUpState, reason?: string) =>
      mutate({ action: 'cancel_follow_up', lead, state, reason: reason ?? null }),
  }
}
