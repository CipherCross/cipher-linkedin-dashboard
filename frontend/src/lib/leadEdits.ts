import type { Lead } from './types'

/**
 * Lead edits made this session through DataContext's `patchLead`.
 *
 * `data.leads` already carries them. They are kept separately for the leads it
 * does not hold: Leads reads its rows page by page, so a lead opened from there
 * is in neither list, and without this the drawer and the table keep showing
 * the stage, owner or gender from before the save.
 */
export interface LeadEdit {
  readonly patch: Partial<Lead>
  /** `Date.now()` of the latest edit folded into `patch`. */
  readonly at: number
}

/**
 * `lead` with this session's edits on top. Pass `fetchedAt` — when the read that
 * produced `lead` started — and an edit made before it is left out, because the
 * row already reflects it (and a later change by someone else must not be masked).
 */
export function withLeadEdits(
  lead: Lead,
  edits: ReadonlyMap<string, LeadEdit> | undefined,
  fetchedAt?: number | null,
): Lead {
  const edit = edits?.get(lead.id)
  if (!edit || (fetchedAt != null && edit.at <= fetchedAt)) return lead
  return { ...lead, ...edit.patch }
}
