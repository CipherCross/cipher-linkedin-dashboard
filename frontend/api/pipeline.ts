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
// with a 200 (mirrors milestone_error in /api/import-conversation).
//
// Guard: same as /api/config — if ADMIN_SECRET is set on the Vercel project, callers
// must send it as an `x-admin-secret` header; if unset, the endpoint is open.
import { db } from './_lib/core.js'
import { PIPELINE_STAGE_IDS, stageAllowsSubstatus } from './_lib/pipeline.js'

export const maxDuration = 10

const MAX_LOST_REASON = 500
const MAX_NOTE = 4000
const MAX_MEMBER_NAME = 100
const GENDERS = ['male', 'female', 'unknown'] as const

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const nowIso = () => new Date().toISOString()

// --- set_stage -------------------------------------------------------------

async function setStage(supa: ReturnType<typeof db>, p: Record<string, unknown>) {
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
    if (stage === null || !stageAllowsSubstatus(stage, substatus)) {
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

  const actor = typeof p.actor === 'string' && p.actor.trim() ? p.actor.trim() : 'unknown'

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

async function assign(supa: ReturnType<typeof db>, p: Record<string, unknown>) {
  const leadId = p.lead_id
  if (typeof leadId !== 'string' || !leadId) {
    return json({ error: 'lead_id (string) is required' }, 400)
  }

  const memberId = p.member_id
  if (memberId !== null && (typeof memberId !== 'number' || !Number.isInteger(memberId))) {
    return json({ error: 'member_id must be an integer or null' }, 400)
  }
  const actor = typeof p.actor === 'string' && p.actor.trim() ? p.actor.trim() : 'unknown'

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

async function addNote(supa: ReturnType<typeof db>, p: Record<string, unknown>) {
  const leadId = p.lead_id
  if (typeof leadId !== 'string' || !leadId) {
    return json({ error: 'lead_id (string) is required' }, 400)
  }
  const body = typeof p.body === 'string' ? p.body.trim() : ''
  if (!body || body.length > MAX_NOTE) {
    return json({ error: `body must be a non-empty string (max ${MAX_NOTE} chars)` }, 400)
  }
  const author = typeof p.author === 'string' && p.author.trim() ? p.author.trim() : null

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

async function deleteNote(supa: ReturnType<typeof db>, p: Record<string, unknown>) {
  const noteId = p.note_id
  if (typeof noteId !== 'number' || !Number.isInteger(noteId) || noteId <= 0) {
    return json({ error: 'note_id must be a positive integer' }, 400)
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
  // Re-adding an existing name reactivates that member (name is unique).
  const { data, error } = await supa
    .from('team_members')
    .upsert({ name, active: true }, { onConflict: 'name' })
    .select()
    .single()
  if (error) return json({ error: error.message }, 500)

  return json({ ok: true, member: data })
}

async function setMemberActive(supa: ReturnType<typeof db>, p: Record<string, unknown>) {
  const memberId = p.member_id
  if (typeof memberId !== 'number' || !Number.isInteger(memberId)) {
    return json({ error: 'member_id must be an integer' }, 400)
  }
  if (typeof p.active !== 'boolean') {
    return json({ error: 'active must be a boolean' }, 400)
  }
  const { data, error } = await supa
    .from('team_members')
    .update({ active: p.active })
    .eq('id', memberId)
    .select('id,name,active')
    .single()
  // .single() errors (PGRST116) when no row matched — surface as a 404.
  if (error) {
    if ((error as { code?: string }).code === 'PGRST116') {
      return json({ error: 'unknown member_id' }, 404)
    }
    return json({ error: error.message }, 500)
  }

  return json({ ok: true, member: data })
}

// --- set_gender ------------------------------------------------------------
// SDR override for the inferred lead demographics (Feature 2). Unlike the other
// actions this touches the DEMOGRAPHICS layer, not the CRM pipeline, so it writes NO
// pipeline_events row. A concrete gender is treated as ground truth (demo_model='manual',
// confidence 1) that the classify job never re-infers; null is UNDO — it clears every
// demographic inference field so the next classify run re-derives them from scratch.

async function setGender(supa: ReturnType<typeof db>, p: Record<string, unknown>) {
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

  const { data: lead, error: leadErr } = await supa
    .from('leads')
    .select('id')
    .eq('id', leadId)
    .maybeSingle()
  if (leadErr) return json({ error: leadErr.message }, 500)
  if (!lead) return json({ error: 'unknown lead_id' }, 404)

  // null => clear ALL inference fields (undo -> next classify run re-infers).
  // concrete gender => SDR-confirmed override; leave the birth-year range as inferred.
  const patch: Record<string, unknown> =
    gender === null
      ? {
          birth_year_min: null,
          birth_year_max: null,
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

  const { data, error } = await supa
    .from('leads')
    .update(patch)
    .eq('id', leadId)
    .select('gender,gender_confidence,demo_model,demo_inferred_at,birth_year_min,birth_year_max')
    .single()
  if (error) return json({ error: error.message }, 500)

  return json({ ok: true, ...data })
}

async function handle(req: Request): Promise<Response> {
  const secret = process.env.ADMIN_SECRET
  if (secret && req.headers.get('x-admin-secret') !== secret) {
    return json({ error: 'unauthorized' }, 401)
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

  const supa = db()
  switch (payload.action) {
    case 'set_stage':
      return setStage(supa, payload)
    case 'assign':
      return assign(supa, payload)
    case 'add_note':
      return addNote(supa, payload)
    case 'delete_note':
      return deleteNote(supa, payload)
    case 'add_member':
      return addMember(supa, payload)
    case 'set_member_active':
      return setMemberActive(supa, payload)
    case 'set_gender':
      return setGender(supa, payload)
    default:
      return json({ error: 'unknown action' }, 400)
  }
}

export const POST = (req: Request) => handle(req)
