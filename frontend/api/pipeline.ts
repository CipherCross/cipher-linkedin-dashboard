// Manual CRM pipeline writer. The dashboard's pipeline board drives leads through
// the team's stage vocabulary (see _lib/pipeline.ts), assigns owners, and pins
// free-text notes. All of this is a MANUAL layer the team maintains by hand on top
// of LH2's synced funnel — distinct from LH2's raw `status` and from the milestone
// timestamps. The Neon writes in _lib/neonWrites.ts own the reads, writes and
// transaction boundary; this file validates and dispatches.
//
// Every stage/assignment change also appends a pipeline_events row, in the same
// transaction, so time-in-stage can be reconstructed from the gaps between events.
//
// Ordinary CRM actions require an active member; demographics and team access
// management require an admin. Actor and role resolve against the database being
// written.
import { PIPELINE_STAGE_IDS, stageAllowsSubstatus } from './_lib/pipeline.js'
import { authorizationResponse } from './_lib/auth.js'
import { unavailableResponse } from './_lib/data/availability.js'
import {
  neonAddNote,
  neonAssign,
  neonDeleteNote,
  neonFollowUp,
  neonSetGender,
  neonSetInstanceConfig,
  neonSetStage,
  neonWriter,
} from './_lib/neonWrites.js'
import {
  neonActivateManualReplyReview,
  neonSaveReplyReview,
  neonSetReplyWorkflow,
} from './_lib/neonReplyReviewWrites.js'
import type {
  ActivateManualReplyReviewRequest,
  SaveReplyReviewRequest,
  SetReplyWorkflowRequest,
} from './_lib/replyReview.js'

export const maxDuration = 10

const MAX_LOST_REASON = 500
const MAX_NOTE = 4000
const MAX_FOLLOW_UP_REASON = 1000
const GENDERS = ['male', 'female', 'unknown'] as const
const FOLLOW_UP_ACTIONS = {
  schedule_follow_up: 'schedule',
  reschedule_follow_up: 'reschedule',
  reassign_follow_up: 'reassign',
  complete_follow_up: 'complete',
  skip_follow_up: 'skip',
  cancel_follow_up: 'cancel',
} as const

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

// --- set_instance_config ---------------------------------------------------
// Notebook config writer, folded in from the former /api/config function so the
// Neon read path (/api/activity-daily) could take its serverless slot without
// exceeding the plan's function limit. Behaviour is unchanged: it persists the
// per-instance override blob the sync agent reads on its next run (see
// apply_remote_config in sync-agent/agent.py), so notebooks can be reconfigured
// from the Health page with no local edits.

// Bootstrap keys are needed locally just to connect/identify a notebook; a remote
// blob must never set them. The agent ignores them too, but we strip here so they
// never even land in the database.
//
// The machine credential is here for a stronger reason than the bootstrap keys.
// The agent's own `LOCAL_ONLY_CONFIG_KEYS` already refuses to read it back, so a
// stored one would be inert — but it would be a machine credential at rest in a
// row that is readable through the AI SQL guard and by every admin, written there
// by somebody who believed it was being delivered. Stripping on the way in means
// it is never stored, rather than stored and ignored. Notify now uses this same
// per-notebook credential; the old NOTIFY_SECRET remains only as a server-side
// compatibility path for older agents.
//
// This set must stay a superset of the agent's `LOCAL_ONLY_CONFIG_KEYS` minus the
// keys the agent needs locally to exist at all. The two retired Supabase keys stay
// listed so a remote blob can never carry a service-role key into the database.
const FORBIDDEN_CONFIG_KEYS = new Set([
  'supabase_url',
  'supabase_service_key',
  'instance_id',
  'ignore_remote_config',
  'ingest_token',
])

const MAX_CONFIG_BYTES = 64_000

async function setInstanceConfig(
  payload: Record<string, unknown>,
  req: Request,
): Promise<Response> {
  const instance_id = payload.instance_id
  const config = payload.config
  if (typeof instance_id !== 'string' || !instance_id) {
    return json({ error: 'instance_id (string) is required' }, 400)
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return json({ error: 'config must be an object' }, 400)
  }

  // Drop bootstrap keys defensively, then size-check what we'll store.
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    if (!FORBIDDEN_CONFIG_KEYS.has(k)) clean[k] = v
  }
  if (JSON.stringify(clean).length > MAX_CONFIG_BYTES) {
    return json({ error: 'config too large' }, 413)
  }

  return neonSetInstanceConfig(req, { instanceId: instance_id, config: clean })
}

// --- set_stage -------------------------------------------------------------

async function setStage(
  p: Record<string, unknown>,
  req: Request,
) {
  const leadId = p.lead_id
  if (typeof leadId !== 'string' || !leadId) {
    return json({ error: 'lead_id (string) is required' }, 400)
  }

  // stage: null removes the lead from the pipeline; otherwise a known slug.
  const stage = p.stage
  if (stage !== null && (typeof stage !== 'string' || !PIPELINE_STAGE_IDS.includes(stage))) {
    return json({ error: `stage must be null or one of ${PIPELINE_STAGE_IDS.join(', ')}` }, 400)
  }

  // substatus: only meaningful with a stage that allows it.
  const substatus = p.substatus
  if (substatus !== undefined && substatus !== null) {
    if (typeof substatus !== 'string') {
      return json({ error: 'substatus must be a string' }, 400)
    }
    if (stage === null || typeof stage !== 'string' || !stageAllowsSubstatus(stage, substatus)) {
      return json({ error: `substatus '${substatus}' is not allowed for stage '${stage ?? 'null'}'` }, 400)
    }
  }

  // lost_reason: free text only on the 'lost' stage.
  const lostReasonRaw = p.lost_reason
  if (lostReasonRaw !== undefined && lostReasonRaw !== null) {
    if (typeof lostReasonRaw !== 'string') {
      return json({ error: 'lost_reason must be a string' }, 400)
    }
    if (stage !== 'lost') {
      return json({ error: "lost_reason is only allowed when stage='lost'" }, 400)
    }
  }

  // Resolve the target values. When the lead leaves the pipeline (stage=null),
  // substatus / lost_reason / changed_at all clear too.
  const newStage = stage as string | null
  const newSubstatus =
    newStage !== null && typeof substatus === 'string' && stageAllowsSubstatus(newStage, substatus)
      ? substatus
      : null
  const newLost =
    newStage === 'lost' && typeof lostReasonRaw === 'string'
      ? lostReasonRaw.slice(0, MAX_LOST_REASON)
      : null

  return neonSetStage(req, {
    leadId,
    stage: newStage,
    substatus: newSubstatus,
    lostReason: newLost,
  })
}

// --- assign ----------------------------------------------------------------

async function assign(
  p: Record<string, unknown>,
  req: Request,
) {
  const leadId = p.lead_id
  if (typeof leadId !== 'string' || !leadId) {
    return json({ error: 'lead_id (string) is required' }, 400)
  }

  const memberId = p.member_id
  if (memberId !== null && (typeof memberId !== 'number' || !Number.isInteger(memberId))) {
    return json({ error: 'member_id must be an integer or null' }, 400)
  }
  return neonAssign(req, { leadId, memberId })
}

// --- add_note / delete_note ------------------------------------------------

async function addNote(
  p: Record<string, unknown>,
  req: Request,
) {
  const leadId = p.lead_id
  if (typeof leadId !== 'string' || !leadId) {
    return json({ error: 'lead_id (string) is required' }, 400)
  }
  const body = typeof p.body === 'string' ? p.body.trim() : ''
  if (!body || body.length > MAX_NOTE) {
    return json({ error: `body must be a non-empty string (max ${MAX_NOTE} chars)` }, 400)
  }
  return neonAddNote(req, { leadId, body })
}

async function deleteNote(
  p: Record<string, unknown>,
  req: Request,
) {
  const noteId = p.note_id
  if (typeof noteId !== 'number' || !Number.isInteger(noteId) || noteId <= 0) {
    return json({ error: 'note_id must be a positive integer' }, 400)
  }
  return neonDeleteNote(req, { noteId })
}

// --- set_gender ------------------------------------------------------------
// SDR override for the inferred lead demographics (Feature 2). Unlike the other
// actions this touches the DEMOGRAPHICS layer, not the CRM pipeline, so it writes NO
// pipeline_events row. A concrete gender becomes an SDR-reviewed override
// (demo_model='manual', confidence 1) that the classify job never re-infers; null
// is UNDO for gender only. "Manual" records provenance, not self-identification.
// Age has an independent lifecycle (migration 048) and must not disappear when an
// SDR clears a gender override.

async function setGender(
  p: Record<string, unknown>,
  req: Request,
) {
  const leadId = p.lead_id
  if (typeof leadId !== 'string' || !leadId) {
    return json({ error: 'lead_id (string) is required' }, 400)
  }

  const gender = p.gender
  if (
    gender !== null &&
    !(typeof gender === 'string' && (GENDERS as readonly string[]).includes(gender))
  ) {
    return json({ error: `gender must be null or one of ${GENDERS.join(', ')}` }, 400)
  }

  return neonSetGender(req, { leadId, gender: gender as string | null })
}

// --- conversation follow-ups -----------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1, day))
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  )
}

async function followUp(
  p: Record<string, unknown>,
  action: keyof typeof FOLLOW_UP_ACTIONS,
  req: Request,
) {
  const instanceId = typeof p.instance_id === 'string' ? p.instance_id.trim() : ''
  const profileUrl = typeof p.profile_url === 'string' ? p.profile_url.trim() : ''
  const expectedRevision = p.expected_revision
  const mutationId = typeof p.mutation_id === 'string' ? p.mutation_id.trim() : ''
  const ownerId = p.owner_id
  const nextDate = p.next_follow_up_date
  const reason = typeof p.reason === 'string' ? p.reason.trim() : p.reason

  if (!instanceId || !profileUrl) {
    return json({ error: 'instance_id and profile_url are required' }, 400)
  }
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    return json({ error: 'expected_revision must be a non-negative integer' }, 400)
  }
  if (!UUID.test(mutationId)) {
    return json({ error: 'mutation_id must be a UUID' }, 400)
  }
  if (
    ownerId !== undefined &&
    ownerId !== null &&
    (typeof ownerId !== 'number' || !Number.isInteger(ownerId) || ownerId <= 0)
  ) {
    return json({ error: 'owner_id must be a positive integer or null' }, 400)
  }
  if (
    nextDate !== undefined &&
    nextDate !== null &&
    (typeof nextDate !== 'string' || !validDateOnly(nextDate))
  ) {
    return json({ error: 'next_follow_up_date must be a valid YYYY-MM-DD date or null' }, 400)
  }
  if (
    reason !== undefined &&
    reason !== null &&
    (typeof reason !== 'string' || !reason || reason.length > MAX_FOLLOW_UP_REASON)
  ) {
    return json({
      error: `reason must be a non-empty string (max ${MAX_FOLLOW_UP_REASON} chars) or null`,
    }, 400)
  }

  const dbAction = FOLLOW_UP_ACTIONS[action]
  if (dbAction === 'schedule' && (ownerId == null || nextDate == null)) {
    return json({ error: 'owner_id and next_follow_up_date are required' }, 400)
  }
  if (dbAction === 'reschedule' && nextDate == null) {
    return json({ error: 'next_follow_up_date is required' }, 400)
  }
  if (dbAction === 'reassign' && ownerId == null) {
    return json({ error: 'owner_id is required' }, 400)
  }
  if (dbAction === 'skip' && !reason) {
    return json({ error: 'reason is required when skipping' }, 400)
  }
  if (
    (dbAction === 'complete' || dbAction === 'skip') &&
    ((ownerId == null) !== (nextDate == null))
  ) {
    return json({ error: 'next owner and date must be supplied together' }, 400)
  }
  if (dbAction === 'cancel' && (ownerId != null || nextDate != null)) {
    return json({ error: 'cancel does not accept owner_id or next_follow_up_date' }, 400)
  }

  return neonFollowUp(req, {
    action: dbAction,
    instanceId,
    profileUrl,
    expectedRevision,
    mutationId,
    ownerId: ownerId ?? null,
    nextFollowUpDate: nextDate ?? null,
    reason: reason ?? null,
  })
}

async function handle(req: Request): Promise<Response> {
  let role: 'member' | 'admin'
  try {
    const resolvedRole = (await neonWriter(req)).actor.role
    if (resolvedRole !== 'member' && resolvedRole !== 'admin') {
      return json({ error: 'Your account is not an active team member' }, 403)
    }
    role = resolvedRole
  } catch (error) {
    const denial = authorizationResponse(error)
    if (denial) return denial
    // The database was not reached, so no membership decision was taken and
    // the answer below would be a claim about one. Named cause, honest status.
    const unavailable = unavailableResponse(error)
    if (unavailable) return unavailable
    console.error(
      'Pipeline authorization failed:',
      error instanceof Error ? error.name : 'UnknownError',
    )
    return json({ error: 'Could not verify team access' }, 500)
  }

  let payload: Record<string, unknown>
  try {
    payload = (await req.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return json({ error: 'body must be an object' }, 400)
  }

  const adminActions = new Set([
    'add_member',
    'set_member_active',
    'invite_member',
    'update_member',
    'set_gender',
    'set_instance_config',
    'activate_manual_reply_review',
  ])
  if (
    typeof payload.action === 'string' &&
    adminActions.has(payload.action) &&
    role !== 'admin'
  ) {
    return json({ error: 'Admin access required' }, 403)
  }

  // Team administration is a self-hosted Better Auth concern. The old member
  // mutations are retired: the identity endpoint's UUID-keyed admin functions
  // are the only remaining vocabulary, and old callers are pointed there.
  if (
    typeof payload.action === 'string' &&
    new Set(['add_member', 'set_member_active', 'invite_member', 'update_member']).has(
      payload.action,
    )
  ) {
    return json(
      {
        error: 'Team administration moved to /api/identity.',
        redirect: '/api/identity',
      },
      410,
    )
  }

  if (payload.action === 'save_reply_review') return neonSaveReplyReview(req, payload as unknown as SaveReplyReviewRequest)
  if (payload.action === 'set_reply_workflow') return neonSetReplyWorkflow(req, payload as unknown as SetReplyWorkflowRequest)
  if (payload.action === 'activate_manual_reply_review') return neonActivateManualReplyReview(req, payload as unknown as ActivateManualReplyReviewRequest)
  switch (payload.action) {
    case 'set_stage':
      return setStage(payload, req)
    case 'assign':
      return assign(payload, req)
    case 'add_note':
      return addNote(payload, req)
    case 'delete_note':
      return deleteNote(payload, req)
    case 'set_gender':
      return setGender(payload, req)
    case 'set_instance_config':
      return setInstanceConfig(payload, req)
    case 'schedule_follow_up':
    case 'reschedule_follow_up':
    case 'reassign_follow_up':
    case 'complete_follow_up':
    case 'skip_follow_up':
    case 'cancel_follow_up':
      return followUp(payload, payload.action, req)
    default:
      return json({ error: 'unknown action' }, 400)
  }
}

export const POST = (req: Request) => handle(req)
