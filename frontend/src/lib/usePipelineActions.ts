// Optimistic mutations for the manual CRM pipeline. Authenticated identity is
// authoritative on the server. Every write patches the shared lead in place first (so the board /
// drawer / leads table all update instantly), then POSTs to /api/pipeline; a
// failure reverts and surfaces via the app-wide toast.
import { useCallback, useMemo } from 'react'
import { authPost } from './api'
import { useAuth } from './AuthContext'
import { useData } from './DataContext'
import {
  MEMBER_WRITES_BLOCKED,
  assignableMembers,
  memberWritesAllowed,
} from './rosterWrites'
import { useToast } from './ToastContext'
import type { Lead, LeadNote, TeamMember } from './types'

async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await authPost('/api/pipeline', body)
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
  const { member, isAdmin } = useAuth()
  const toast = useToast()
  const actor = member?.name ?? ''

  const members: TeamMember[] = data?.teamMembers ?? []
  /**
   * The roster's provenance, and with it whether a member id may be written
   * back. `supabase` on every deployment today, and on that value nothing below
   * behaves differently from the way it always has.
   */
  const rosterPath = data?.rosterPath ?? 'supabase'
  const canWriteMembers = memberWritesAllowed(rosterPath)
  /**
   * The display roster and the assignment roster are deliberately two lists.
   * `memberName` must resolve `lead.assigned_to` on both paths — that is the
   * whole point of reading the roster from wherever the leads came from — while
   * the dropdowns that send an id *back* must offer nobody when the writer would
   * resolve it against the other database. See `rosterWrites.ts`.
   */
  const assignable = useMemo(
    () => assignableMembers(members, rosterPath),
    [members, rosterPath],
  )
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
    [patchLead, toast],
  )

  const assign = useCallback(
    async (lead: Lead, memberId: number | null) => {
      // The refusal is here as well as in the dropdowns, because a control that
      // offers nobody is a convention and this is the guarantee: `member_id`
      // reaches a writer that resolves it against Supabase whatever the read
      // path is, so a Neon id would commit against a different person.
      // Unassigning (`null`) names nobody and stays available.
      if (memberId !== null && !canWriteMembers) {
        toast.error(MEMBER_WRITES_BLOCKED)
        return
      }
      const snapshot: Partial<Lead> = { assigned_to: lead.assigned_to }
      patchLead(lead.id, { assigned_to: memberId })
      try {
        const j = await post({ action: 'assign', lead_id: lead.id, member_id: memberId })
        if (j.event_error)
          toast.error(`Assigned, but history log failed: ${String(j.event_error)}`)
      } catch (e) {
        patchLead(lead.id, snapshot)
        toast.error(`Couldn't assign lead: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [canWriteMembers, patchLead, toast],
  )

  const addNote = useCallback(
    async (leadId: string, body: string): Promise<LeadNote> => {
      const j = await post({ action: 'add_note', lead_id: leadId, body })
      // Accept either a bare row or a { note } envelope.
      return ((j.note as LeadNote) ?? (j as unknown as LeadNote))
    },
    [],
  )

  const deleteNote = useCallback(async (noteId: number) => {
    await post({ action: 'delete_note', note_id: noteId })
  }, [])

  // `add_member` and `set_member_active` write Supabase's `team_members` and
  // have no caller in the SPA today — the Team page posts `update_member`
  // instead. They are guarded anyway rather than left as the one unguarded way
  // back to the wrong roster.
  const addMember = useCallback(
    async (name: string): Promise<TeamMember> => {
      if (!canWriteMembers) throw new Error(MEMBER_WRITES_BLOCKED)
      const j = await post({ action: 'add_member', name })
      // team_members is tiny; refetch to surface the new member globally.
      refetch()
      return ((j.member as TeamMember) ?? (j as unknown as TeamMember))
    },
    [canWriteMembers, refetch],
  )

  const setMemberActive = useCallback(
    async (memberId: number, active: boolean) => {
      if (!canWriteMembers) throw new Error(MEMBER_WRITES_BLOCKED)
      await post({ action: 'set_member_active', member_id: memberId, active })
      refetch()
    },
    [canWriteMembers, refetch],
  )

  return {
    actor,
    isAdmin,
    /** Every member, for display and for resolving an id to a name. */
    members,
    /**
     * The subset whose ids may be sent to `/api/pipeline` — all of `members`
     * today, and none of them while the roster is Neon's. Every owner dropdown
     * builds its options from this one.
     */
    assignableMembers: assignable,
    /** Why the dropdowns are empty, or `null` when they are not. */
    memberWritesBlockedReason: canWriteMembers ? null : MEMBER_WRITES_BLOCKED,
    rosterPath,
    memberName,
    setStage,
    assign,
    addNote,
    deleteNote,
    addMember,
    setMemberActive,
  }
}
