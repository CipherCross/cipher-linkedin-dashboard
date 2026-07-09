// Optimistic mutations for the manual CRM pipeline, plus the SDR's "who am I"
// identity. Every write patches the shared lead in place first (so the board /
// drawer / leads table all update instantly), then POSTs to /api/pipeline; a
// failure reverts and surfaces via the app-wide toast.
import { useCallback, useEffect, useState } from 'react'
import { adminPost } from './admin'
import { useData } from './DataContext'
import { useToast } from './ToastContext'
import type { Lead, LeadNote, TeamMember } from './types'

const ACTOR_KEY = 'pipelineActor'
// Broadcast actor changes so every hook instance (board header, drawer, notes)
// stays in sync without a shared context.
const ACTOR_EVENT = 'pipelineActor'

async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await adminPost('/api/pipeline', body)
  let j: Record<string, unknown> = {}
  try {
    j = await res.json()
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new Error((j.error as string) || `HTTP ${res.status}`)
  return j
}

/** Pipeline mutation helpers + actor identity. setStage/assign are fire-and-
 *  forget: they patch optimistically and, on failure, revert + toast internally
 *  (callers can `void` them). addNote/deleteNote/addMember throw so their callers
 *  can revert their own local optimistic state. */
export function usePipelineActions() {
  const { data, patchLead, refetch } = useData()
  const toast = useToast()

  const [actor, setActorState] = useState<string>(
    () => localStorage.getItem(ACTOR_KEY) ?? '',
  )

  // Keep every hook instance's actor in sync.
  useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      setActorState(detail ?? localStorage.getItem(ACTOR_KEY) ?? '')
    }
    window.addEventListener(ACTOR_EVENT, onEvent)
    return () => window.removeEventListener(ACTOR_EVENT, onEvent)
  }, [])

  const setActor = useCallback((name: string) => {
    localStorage.setItem(ACTOR_KEY, name)
    setActorState(name)
    window.dispatchEvent(new CustomEvent(ACTOR_EVENT, { detail: name }))
  }, [])

  const members: TeamMember[] = data?.teamMembers ?? []
  const memberName = useCallback(
    (id: number | null | undefined): string =>
      (id != null && members.find((m) => m.id === id)?.name) || '',
    [members],
  )

  const setStage = useCallback(
    async (
      lead: Lead,
      stage: string | null,
      opts?: { substatus?: string | null; lostReason?: string | null },
    ) => {
      const snapshot: Partial<Lead> = {
        pipeline_stage: lead.pipeline_stage,
        pipeline_substatus: lead.pipeline_substatus,
        lost_reason: lead.lost_reason,
        pipeline_stage_changed_at: lead.pipeline_stage_changed_at,
      }
      patchLead(lead.id, {
        pipeline_stage: stage,
        pipeline_substatus: opts?.substatus ?? null,
        lost_reason: opts?.lostReason ?? null,
        pipeline_stage_changed_at: new Date().toISOString(),
      })
      try {
        const j = await post({
          action: 'set_stage',
          lead_id: lead.id,
          stage,
          substatus: opts?.substatus ?? null,
          lost_reason: opts?.lostReason ?? null,
          actor,
        })
        // Reconcile with the server's authoritative values. The API returns only
        // the fields it actually changed: a no-op sends {changed:false} with
        // none, and a substatus-only edit omits pipeline_stage_changed_at (it
        // keeps the original time). Mirror that precisely so the optimistic
        // changed_at bump is corrected without clobbering unrelated fields.
        if (j.changed === false) {
          patchLead(lead.id, snapshot)
        } else {
          const reconcile: Partial<Lead> = {}
          if ('pipeline_stage' in j) reconcile.pipeline_stage = j.pipeline_stage as string | null
          if ('pipeline_substatus' in j)
            reconcile.pipeline_substatus = j.pipeline_substatus as string | null
          if ('lost_reason' in j) reconcile.lost_reason = j.lost_reason as string | null
          reconcile.pipeline_stage_changed_at =
            'pipeline_stage_changed_at' in j
              ? (j.pipeline_stage_changed_at as string | null)
              : snapshot.pipeline_stage_changed_at ?? null
          patchLead(lead.id, reconcile)
        }
        // The lead moved, but the append-only history event failed to log —
        // non-fatal for the move, but it corrupts the "ever reached" funnel math.
        if (j.event_error)
          toast.error(`Moved, but history log failed: ${String(j.event_error)}`)
      } catch (e) {
        patchLead(lead.id, snapshot)
        toast.error(`Couldn't move lead: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [actor, patchLead, toast],
  )

  const assign = useCallback(
    async (lead: Lead, memberId: number | null) => {
      const snapshot: Partial<Lead> = { assigned_to: lead.assigned_to }
      patchLead(lead.id, { assigned_to: memberId })
      try {
        const j = await post({ action: 'assign', lead_id: lead.id, member_id: memberId, actor })
        if (j.event_error)
          toast.error(`Assigned, but history log failed: ${String(j.event_error)}`)
      } catch (e) {
        patchLead(lead.id, snapshot)
        toast.error(`Couldn't assign lead: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [actor, patchLead, toast],
  )

  const addNote = useCallback(
    async (leadId: string, body: string): Promise<LeadNote> => {
      const j = await post({ action: 'add_note', lead_id: leadId, body, author: actor })
      // Accept either a bare row or a { note } envelope.
      return ((j.note as LeadNote) ?? (j as unknown as LeadNote))
    },
    [actor],
  )

  const deleteNote = useCallback(async (noteId: number) => {
    await post({ action: 'delete_note', note_id: noteId })
  }, [])

  const addMember = useCallback(
    async (name: string): Promise<TeamMember> => {
      const j = await post({ action: 'add_member', name })
      // team_members is tiny; refetch to surface the new member globally.
      refetch()
      return ((j.member as TeamMember) ?? (j as unknown as TeamMember))
    },
    [refetch],
  )

  const setMemberActive = useCallback(
    async (memberId: number, active: boolean) => {
      await post({ action: 'set_member_active', member_id: memberId, active })
      refetch()
    },
    [refetch],
  )

  return {
    actor,
    setActor,
    members,
    memberName,
    setStage,
    assign,
    addNote,
    deleteNote,
    addMember,
    setMemberActive,
  }
}
