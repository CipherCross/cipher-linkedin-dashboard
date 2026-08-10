// Manual CRM pipeline writer. The dashboard's pipeline board drives leads through
// the team's stage vocabulary (see _lib/pipeline.ts), assigns owners, and pins
// free-text notes. All of this is a MANUAL layer the team maintains by hand on top
// of LH2's synced funnel — distinct from LH2's raw `status` and from the milestone
// timestamps. Writes need the service-role key (these tables have no RLS write
// policy), reused from _lib/core.
//
// Every stage/assignment change also appends a pipeline_events row so time-in-stage
// can be reconstructed from the gaps between events. The events insert happens after
// the lead row is already committed, so a failed insert is reported as `event_error`
// with a 200 (mirrors milestone_error in /api/import's conversation action).
//
// Ordinary CRM actions require an active member; demographics and team access
// management require an admin. Audit identity comes from the verified JWT.
import { db } from './_lib/core.js'
import { PIPELINE_STAGE_IDS, stageAllowsSubstatus } from './_lib/pipeline.js'
import { authorizationResponse, guardMember } from './_lib/auth.js'
import { deploymentWritePath } from './_lib/data/writePath.js'
import {
  neonAddNote,
  neonDeleteNote,
  neonSetGender,
  neonSetInstanceConfig,
  neonSetStage,
  neonWriter,
} from './_lib/neonWrites.js'

export const maxDuration = 10

const MAX_LOST_REASON = 500
const MAX_NOTE = 4000
const MAX_MEMBER_NAME = 100
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

const nowIso = () => new Date().toISOString()

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
// keys the agent needs locally to exist at all.
const FORBIDDEN_CONFIG_KEYS = new Set([
  'supabase_url',
  'supabase_service_key',
  'instance_id',
  'ignore_remote_config',
  'ingest_token',
])

const MAX_CONFIG_BYTES = 64_000

async function setInstanceConfig(
  supa: ReturnType<typeof db>,
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

  if (deploymentWritePath() === 'neon') {
    return neonSetInstanceConfig(req, { instanceId: instance_id, config: clean })
  }

  const { data, error } = await supa
    .from('instances')
    .update({ config: clean, config_updated_at: nowIso() })
    .eq('id', instance_id)
    .select('id')
  if (error) return json({ error: error.message }, 500)
  if (!data?.length) return json({ error: 'unknown instance_id' }, 404)

  return json({ ok: true, instance_id })
}

// --- set_stage -------------------------------------------------------------

async function setStage(
  supa: ReturnType<typeof db>,
  p: Record<string, unknown>,
  actor: string,
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

  // The provider split happens here: validation above is shared, and everything
  // below — the pre-read, the write, the audit row and the response — belongs to
  // one provider. Splitting later would mean two definitions of a legal stage.
  if (deploymentWritePath() === 'neon') {
    return neonSetStage(req, {
      leadId,
      stage: newStage,
      substatus: newSubstatus,
      lostReason: newLost,
    })
  }

  const { data: lead, error: leadErr } = await supa
    .from('leads')
    .select('id,pipeline_stage,pipeline_substatus,lost_reason')
    .eq('id', leadId)
    .maybeSingle()
  if (leadErr) return json({ error: leadErr.message }, 500)
  if (!lead) return json({ error: 'unknown lead_id' }, 404)

  // No-op short-circuit: nothing about the pipeline fields would change.
  if (
    newStage === lead.pipeline_stage &&
    newSubstatus === lead.pipeline_substatus &&
    newLost === lead.lost_reason
  ) {
    return json({ ok: true, changed: false })
  }

  const stageChanged = newStage !== lead.pipeline_stage

  const patch: Record<string, unknown> = {
    pipeline_stage: newStage,
    pipeline_substatus: newSubstatus,
    lost_reason: newLost,
  }
  // Time-in-stage only resets when the stage itself moves. A substatus-only edit
  // keeps the original changed_at. Leaving the pipeline clears it.
  if (newStage === null) patch.pipeline_stage_changed_at = null
  else if (stageChanged) patch.pipeline_stage_changed_at = nowIso()

  const { error: upErr } = await supa.from('leads').update(patch).eq('id', leadId)
  if (upErr) return json({ error: upErr.message }, 500)

  const { error: evErr } = await supa.from('pipeline_events').insert({
    lead_id: leadId,
    kind: 'stage',
    actor,
    from_stage: lead.pipeline_stage,
    to_stage: newStage,
    from_substatus: lead.pipeline_substatus,
    to_substatus: newSubstatus,
    lost_reason: newLost,
  })

  return json({
    ok: true,
    changed: true,
    pipeline_stage: newStage,
    pipeline_substatus: newSubstatus,
    lost_reason: newLost,
    // Reflect the persisted changed_at: fresh time only if the stage moved,
    // null if the lead left the pipeline, unchanged otherwise (not returned).
    ...(newStage === null
      ? { pipeline_stage_changed_at: null }
      : stageChanged
        ? { pipeline_stage_changed_at: patch.pipeline_stage_changed_at }
        : {}),
    ...(evErr ? { event_error: evErr.message } : {}),
  })
}

// --- assign ----------------------------------------------------------------

async function assign(
  supa: ReturnType<typeof db>,
  p: Record<string, unknown>,
  actor: string,
) {
  const leadId = p.lead_id
  if (typeof leadId !== 'string' || !leadId) {
    return json({ error: 'lead_id (string) is required' }, 400)
  }

  const memberId = p.member_id
  if (memberId !== null && (typeof memberId !== 'number' || !Number.isInteger(memberId))) {
    return json({ error: 'member_id must be an integer or null' }, 400)
  }
  // Resolve the new assignee (name for the event) and reject unknown/inactive.
  let newName: string | null = null
  if (memberId !== null) {
    const { data: member, error: mErr } = await supa
      .from('team_members')
      .select('id,name,active')
      .eq('id', memberId)
      .maybeSingle()
    if (mErr) return json({ error: mErr.message }, 500)
    if (!member) return json({ error: 'unknown member_id' }, 400)
    if (!member.active) return json({ error: 'member is inactive' }, 400)
    newName = member.name
  }

  const { data: lead, error: leadErr } = await supa
    .from('leads')
    .select('id,assigned_to')
    .eq('id', leadId)
    .maybeSingle()
  if (leadErr) return json({ error: leadErr.message }, 500)
  if (!lead) return json({ error: 'unknown lead_id' }, 404)

  // Resolve the previous assignee's name for the event (best-effort).
  let oldName: string | null = null
  if (lead.assigned_to !== null && lead.assigned_to !== undefined) {
    const { data: prev } = await supa
      .from('team_members')
      .select('name')
      .eq('id', lead.assigned_to)
      .maybeSingle()
    oldName = prev?.name ?? null
  }

  const { error: upErr } = await supa
    .from('leads')
    .update({ assigned_to: memberId })
    .eq('id', leadId)
  if (upErr) return json({ error: upErr.message }, 500)

  const { error: evErr } = await supa.from('pipeline_events').insert({
    lead_id: leadId,
    kind: 'assignment',
    actor,
    from_assignee: oldName,
    to_assignee: newName,
  })

  return json({
    ok: true,
    assigned_to: memberId,
    ...(evErr ? { event_error: evErr.message } : {}),
  })
}

// --- add_note / delete_note ------------------------------------------------

async function addNote(
  supa: ReturnType<typeof db>,
  p: Record<string, unknown>,
  author: string,
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
  if (deploymentWritePath() === 'neon') {
    return neonAddNote(req, { leadId, body })
  }

  const { data: lead, error: leadErr } = await supa
    .from('leads')
    .select('id')
    .eq('id', leadId)
    .maybeSingle()
  if (leadErr) return json({ error: leadErr.message }, 500)
  if (!lead) return json({ error: 'unknown lead_id' }, 404)

  const { data, error } = await supa
    .from('lead_notes')
    .insert({ lead_id: leadId, author, body })
    .select()
    .single()
  if (error) return json({ error: error.message }, 500)

  return json({ ok: true, note: data })
}

async function deleteNote(
  supa: ReturnType<typeof db>,
  p: Record<string, unknown>,
  req: Request,
) {
  const noteId = p.note_id
  if (typeof noteId !== 'number' || !Number.isInteger(noteId) || noteId <= 0) {
    return json({ error: 'note_id must be a positive integer' }, 400)
  }
  if (deploymentWritePath() === 'neon') {
    return neonDeleteNote(req, { noteId })
  }
  const { data, error } = await supa.from('lead_notes').delete().eq('id', noteId).select('id')
  if (error) return json({ error: error.message }, 500)
  if (!data?.length) return json({ error: 'no note with that id' }, 404)

  return json({ ok: true, deleted: noteId })
}

// --- team members ----------------------------------------------------------

async function addMember(supa: ReturnType<typeof db>, p: Record<string, unknown>) {
  const name = typeof p.name === 'string' ? p.name.trim() : ''
  if (!name || name.length > MAX_MEMBER_NAME) {
    return json({ error: `name must be a non-empty string (max ${MAX_MEMBER_NAME} chars)` }, 400)
  }
  // Assignment-only teammate. Login access is created explicitly by invite_member.
  const { data: existing, error: lookupError } = await supa
    .from('team_members')
    .select('*')
    .eq('name', name)
    .maybeSingle()
  if (lookupError) return json({ error: lookupError.message }, 500)
  if (existing?.auth_user_id) {
    return json({ error: 'that teammate has a login; manage access from the Team page' }, 409)
  }

  const result = existing
    ? await supa
        .from('team_members')
        .update({ active: true })
        .eq('id', existing.id)
        .select()
        .single()
    : await supa
        .from('team_members')
        .insert({ name, active: true, role: 'member' })
        .select()
        .single()
  if (result.error) return json({ error: result.error.message }, 409)

  return json({ ok: true, member: result.data })
}

async function setMemberActive(supa: ReturnType<typeof db>, p: Record<string, unknown>) {
  const memberId = p.member_id
  if (typeof memberId !== 'number' || !Number.isInteger(memberId)) {
    return json({ error: 'member_id must be an integer' }, 400)
  }
  if (typeof p.active !== 'boolean') {
    return json({ error: 'active must be a boolean' }, 400)
  }
  const { data: current, error: currentError } = await supa
    .from('team_members')
    .select('id,name,active,role,auth_user_id,email')
    .eq('id', memberId)
    .maybeSingle()
  if (currentError) return json({ error: currentError.message }, 500)
  if (!current) return json({ error: 'unknown member_id' }, 404)

  return updateMember(supa, {
    member_id: memberId,
    name: current.name,
    role: current.role,
    active: p.active,
  })
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizedEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

async function findAuthUserByEmail(supa: ReturnType<typeof db>, email: string) {
  let page = 1
  while (page <= 10) {
    const { data, error } = await supa.auth.admin.listUsers({ page, perPage: 100 })
    if (error) return { user: null, error }
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email)
    if (user) return { user, error: null }
    if (data.users.length < 100) break
    page += 1
  }
  return { user: null, error: null }
}

async function inviteMember(
  supa: ReturnType<typeof db>,
  p: Record<string, unknown>,
  redirectTo: string,
) {
  const name = typeof p.name === 'string' ? p.name.trim() : ''
  const email = normalizedEmail(p.email)
  const role = p.role === 'admin' ? 'admin' : p.role === 'member' ? 'member' : null
  const existingId = p.member_id

  if (!name || name.length > MAX_MEMBER_NAME) {
    return json({ error: `name must be a non-empty string (max ${MAX_MEMBER_NAME} chars)` }, 400)
  }
  if (!EMAIL.test(email)) return json({ error: 'a valid email is required' }, 400)
  if (!role) return json({ error: 'role must be member or admin' }, 400)
  if (
    existingId !== undefined &&
    (typeof existingId !== 'number' || !Number.isInteger(existingId) || existingId <= 0)
  ) {
    return json({ error: 'member_id must be a positive integer' }, 400)
  }

  let member: Record<string, unknown> | null = null
  if (typeof existingId === 'number') {
    const { data, error } = await supa
      .from('team_members')
      .select('*')
      .eq('id', existingId)
      .maybeSingle()
    if (error) return json({ error: error.message }, 500)
    if (!data) return json({ error: 'unknown member_id' }, 404)
    if (data.auth_user_id) {
      return json({ error: 'that teammate already has a login; use Edit instead' }, 409)
    }
    const { data: updated, error: updateError } = await supa
      .from('team_members')
      .update({ name, email, role, active: true })
      .eq('id', existingId)
      .select()
      .single()
    if (updateError) return json({ error: updateError.message }, 409)
    member = updated as Record<string, unknown>
  } else {
    const { data: existingByEmail, error: lookupError } = await supa
      .from('team_members')
      .select('*')
      .ilike('email', email)
      .maybeSingle()
    if (lookupError) return json({ error: lookupError.message }, 500)
    if (existingByEmail) {
      if (existingByEmail.auth_user_id) {
        return json({ error: 'that email is already linked to a teammate' }, 409)
      }
      const { data: updated, error: updateError } = await supa
        .from('team_members')
        .update({ name, role, active: true, email })
        .eq('id', existingByEmail.id)
        .select()
        .single()
      if (updateError) return json({ error: updateError.message }, 409)
      member = updated as Record<string, unknown>
    } else {
      const { data: created, error: createError } = await supa
        .from('team_members')
        .insert({ name, email, role, active: true })
        .select()
        .single()
      if (createError) return json({ error: createError.message }, 409)
      member = created as Record<string, unknown>
    }
  }

  const authLookup = await findAuthUserByEmail(supa, email)
  if (authLookup.error) {
    return json(
      { error: `Team row saved, but Auth lookup failed: ${authLookup.error.message}`, member },
      502,
    )
  }

  let authUser = authLookup.user
  let invited = false
  if (!authUser) {
    const { data, error } = await supa.auth.admin.inviteUserByEmail(email, {
      data: { name },
      redirectTo,
    })
    if (error || !data.user) {
      return json(
        {
          error: `Team row saved, but invitation failed: ${error?.message ?? 'unknown error'}`,
          member,
        },
        502,
      )
    }
    authUser = data.user
    invited = true
  }

  const { data: linked, error: linkError } = await supa
    .from('team_members')
    .update({ auth_user_id: authUser.id, email })
    .eq('id', Number(member.id))
    .select()
    .single()
  if (linkError) {
    return json(
      { error: `Auth user exists, but linking failed: ${linkError.message}`, member },
      409,
    )
  }

  return json({ ok: true, invited, member: linked })
}

async function updateMember(
  supa: ReturnType<typeof db>,
  p: Record<string, unknown>,
) {
  const memberId = p.member_id
  const name = typeof p.name === 'string' ? p.name.trim() : ''
  const role = p.role
  const active = p.active
  if (typeof memberId !== 'number' || !Number.isInteger(memberId) || memberId <= 0) {
    return json({ error: 'member_id must be a positive integer' }, 400)
  }
  if (!name || name.length > MAX_MEMBER_NAME) {
    return json({ error: `name must be a non-empty string (max ${MAX_MEMBER_NAME} chars)` }, 400)
  }
  if (role !== 'member' && role !== 'admin') {
    return json({ error: 'role must be member or admin' }, 400)
  }
  if (typeof active !== 'boolean') {
    return json({ error: 'active must be a boolean' }, 400)
  }

  const { data: current, error: currentError } = await supa
    .from('team_members')
    .select('id,name,email,role,active,auth_user_id')
    .eq('id', memberId)
    .maybeSingle()
  if (currentError) return json({ error: currentError.message }, 500)
  if (!current) return json({ error: 'unknown member_id' }, 404)

  // Unban before reopening database access.
  if (active && !current.active && current.auth_user_id) {
    const { error } = await supa.auth.admin.updateUserById(current.auth_user_id, {
      ban_duration: 'none',
    })
    if (error) return json({ error: `Could not reactivate Auth user: ${error.message}` }, 502)
  }

  const { data: rpcData, error: rpcError } = await supa.rpc('admin_update_team_member', {
    p_member_id: memberId,
    p_name: name,
    p_role: role,
    p_active: active,
  })
  if (rpcError) {
    const status = rpcError.code === 'P0002' ? 404 : rpcError.code === '23514' ? 409 : 400
    return json({ error: rpcError.message }, status)
  }

  // Close live membership first; even if banning fails, RLS/API guards deny it.
  if (!active && current.active && current.auth_user_id) {
    const { error } = await supa.auth.admin.updateUserById(current.auth_user_id, {
      ban_duration: '876000h',
    })
    if (error) {
      return json(
        {
          error: `Dashboard access was disabled, but Auth banning failed: ${error.message}`,
          member: rpcData,
        },
        502,
      )
    }
  }

  return json({ ok: true, member: rpcData })
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
  supa: ReturnType<typeof db>,
  p: Record<string, unknown>,
  reviewer: string,
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

  if (deploymentWritePath() === 'neon') {
    return neonSetGender(req, { leadId, gender: gender as string | null })
  }

  const { data: lead, error: leadErr } = await supa
    .from('leads')
    .select(
      'id,instance_id,profile_url,gender,gender_confidence,demo_model,gender_model_version'
    )
    .eq('id', leadId)
    .maybeSingle()
  if (leadErr) return json({ error: leadErr.message }, 500)
  if (!lead) return json({ error: 'unknown lead_id' }, 404)

  // Legacy fields remain populated for clients deployed before migration 048.
  const legacyPatch: Record<string, unknown> =
    gender === null
      ? {
          gender: null,
          gender_confidence: null,
          demo_inferred_at: null,
          demo_model: null,
        }
      : {
          gender,
          gender_confidence: 1,
          demo_model: 'manual',
          demo_inferred_at: nowIso(),
        }

  const lifecyclePatch: Record<string, unknown> =
    gender === null
      ? { gender_inferred_at: null, gender_model_version: null }
      : { gender_inferred_at: nowIso(), gender_model_version: null }

  const v2Result = await supa
    .from('leads')
    .update({ ...legacyPatch, ...lifecyclePatch })
    .eq('instance_id', lead.instance_id)
    .eq('profile_url', lead.profile_url)
    .select(
      'id,gender,gender_confidence,gender_inferred_at,gender_model_version,' +
        'demo_model,demo_inferred_at,birth_year_min,birth_year_max'
    )
  let data = ((v2Result.data ?? []) as unknown as Array<Record<string, unknown>>)
    .find((row) => row.id === leadId) ?? null
  let error = v2Result.error

  // Rolling-deploy fallback: migration 041 supports the override but lacks the
  // split lifecycle columns. The first UPDATE fails atomically, so retrying the
  // legacy patch cannot double-write.
  if (error && (error.code === '42703' || /column\s+.*\s+does not exist/i.test(error.message))) {
    const legacyResult = await supa
      .from('leads')
      .update(legacyPatch)
      .eq('instance_id', lead.instance_id)
      .eq('profile_url', lead.profile_url)
      .select(
        'id,gender,gender_confidence,demo_model,demo_inferred_at,' +
          'birth_year_min,birth_year_max'
      )
    data = ((legacyResult.data ?? []) as unknown as Array<Record<string, unknown>>)
      .find((row) => row.id === leadId) ?? null
    error = legacyResult.error
  }
  if (error) return json({ error: error.message }, 500)

  // Best-effort audit: preserve the model output that the human just reviewed so
  // precision/coverage/calibration can be measured later. A rolling deployment
  // without migration 048 still completes the override and reports review_error.
  const { error: reviewErr } = await supa.from('lead_gender_reviews').insert({
    lead_id: lead.id,
    instance_id: lead.instance_id,
    profile_url: lead.profile_url,
    action: gender === null ? 'clear' : 'set',
    predicted_gender: lead.demo_model === 'manual' ? null : lead.gender,
    predicted_confidence: lead.demo_model === 'manual' ? null : lead.gender_confidence,
    predicted_model: lead.demo_model === 'manual' ? null : lead.demo_model,
    predicted_version: lead.demo_model === 'manual' ? null : lead.gender_model_version,
    reviewed_gender: gender,
    reviewer: reviewer.slice(0, 120),
  })

  return json({
    ok: true,
    ...(data ?? {}),
    ...(reviewErr ? { review_error: reviewErr.message } : {}),
  })
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
  supa: ReturnType<typeof db>,
  p: Record<string, unknown>,
  action: keyof typeof FOLLOW_UP_ACTIONS,
  actor: string,
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

  const { data, error } = await supa.rpc('apply_follow_up_action', {
    p_action: dbAction,
    p_instance_id: instanceId,
    p_profile_url: profileUrl,
    p_actor: actor,
    p_expected_revision: expectedRevision,
    p_mutation_id: mutationId,
    p_owner_id: ownerId ?? null,
    p_next_follow_up_date: nextDate ?? null,
    p_reason: reason ?? null,
  })

  if (error) {
    const code = (error as { code?: string }).code
    if (code === 'P0002') return json({ error: 'unknown conversation' }, 404)
    if (code === '40001' || /FOLLOW_UP_CONFLICT/i.test(error.message)) {
      const { data: state } = await supa
        .from('conversation_follow_up_state')
        .select('*')
        .eq('instance_id', instanceId)
        .eq('profile_url', profileUrl)
        .maybeSingle()
      return json({ error: error.message.replace(/^FOLLOW_UP_CONFLICT:\s*/i, ''), state }, 409)
    }
    if (code === '22023') return json({ error: error.message }, 400)
    if (code === 'PGRST202' || /apply_follow_up_action/i.test(error.message)) {
      return json({ error: 'Follow-ups database migration is not available yet.' }, 503)
    }
    return json({ error: error.message }, 500)
  }

  return json({ ok: true, ...(data as Record<string, unknown>) })
}

async function handle(req: Request): Promise<Response> {
  const neon = deploymentWritePath() === 'neon'
  let role: 'member' | 'admin'
  let actorNameForLegacy = ''
  if (neon) {
    try {
      const resolvedRole = (await neonWriter(req)).actor.role
      if (resolvedRole !== 'member' && resolvedRole !== 'admin') {
        return json({ error: 'Your account is not an active team member' }, 403)
      }
      role = resolvedRole
    } catch (error) {
      const denial = authorizationResponse(error)
      if (denial) return denial
      console.error(
        'Pipeline authorization failed:',
        error instanceof Error ? error.name : 'UnknownError',
      )
      return json({ error: 'Could not verify team access' }, 500)
    }
  } else {
    const auth = await guardMember(req)
    if (auth.response) return auth.response
    role = auth.principal.member.role
    actorNameForLegacy = auth.principal.member.name
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
  ])
  if (
    typeof payload.action === 'string' &&
    adminActions.has(payload.action) &&
    role !== 'admin'
  ) {
    return json({ error: 'Admin access required' }, 403)
  }

  // These actions do not yet have a reviewed application-store operation.
  // Refuse them before constructing a Supabase client: a Neon deployment must
  // never reinterpret a Neon roster id in the legacy provider's id space.
  if (
    neon &&
    typeof payload.action === 'string' &&
    new Set([
      'assign',
      'add_member',
      'set_member_active',
      'invite_member',
      'update_member',
      ...Object.keys(FOLLOW_UP_ACTIONS),
    ]).has(payload.action)
  ) {
    return json({ error: 'This action is not available on the Neon application path' }, 503)
  }

  // The five reviewed Neon branches below return before dereferencing this
  // argument. Keeping the sentinel local avoids constructing a legacy client
  // (and therefore avoids any Supabase-shaped deployment requirement).
  const supa = neon ? (null as unknown as ReturnType<typeof db>) : db()
  switch (payload.action) {
    case 'set_stage':
      return setStage(supa, payload, actorNameForLegacy, req)
    case 'assign':
      return assign(supa, payload, actorNameForLegacy)
    case 'add_note':
      return addNote(supa, payload, actorNameForLegacy, req)
    case 'delete_note':
      return deleteNote(supa, payload, req)
    case 'add_member':
      return addMember(supa, payload)
    case 'set_member_active':
      return setMemberActive(supa, payload)
    case 'invite_member': {
      const redirectTo = process.env.DASHBOARD_URL || `${new URL(req.url).origin}/`
      return inviteMember(supa, payload, redirectTo)
    }
    case 'update_member':
      return updateMember(supa, payload)
    case 'set_gender':
      return setGender(supa, payload, actorNameForLegacy, req)
    case 'set_instance_config':
      return setInstanceConfig(supa, payload, req)
    case 'schedule_follow_up':
    case 'reschedule_follow_up':
    case 'reassign_follow_up':
    case 'complete_follow_up':
    case 'skip_follow_up':
    case 'cancel_follow_up':
      return followUp(supa, payload, payload.action, actorNameForLegacy)
    default:
      return json({ error: 'unknown action' }, 400)
  }
}

export const POST = (req: Request) => handle(req)
