// Compatibility handler for the retired reply classifier and the still-supported
// demographics gender phase. Reply sentiment/intent is manual-only after cutover.
//
// Triggers:
//   GET  — the daily Vercel cron (guarded by CRON_SECRET).
//   POST — the admin-only "Classify replies" button on the Leads page.
//
// AI-path split, by actor. Only demographics retains a model/write path:
//
//   POST (batch, ?mode=demographics, ?mode=reclassify) — has a human. The actor
//     resolves against Neon and the admin role is re-checked there, so the
//     database being written decides membership; the store is the shared one and
//     the principal is `app_runtime`.
//   GET (the daily cron) — has no human and never will. It runs on the AI store
//     as `app_system` under `SYSTEM_ACTOR`, the nil uuid step 007's policies
//     gate on. No human actor is invented: there is none, and a synthetic member
//     id would be a lie the audit trail would carry forever.
//
// The old GET/POST admission remains for scheduler/UI compatibility but returns
// an explicit disabled/manual-only result. It performs no reply reads, model
// calls, label writes, or sentiment-driven CRM transitions.
import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { db } from './_lib/core.js'
import { guardAdmin, guardMachine, authorizationResponse } from './_lib/auth.js'
import { unavailableResponse } from './_lib/data/availability.js'
import { deploymentAiPath } from './_lib/data/aiPath.js'
import { getAiDataStore, SYSTEM_ACTOR } from './_lib/data/aiStore.js'
import {
  DataStoreContractError,
  type ActorContext,
  type DataStore,
} from './_lib/data/contracts.js'
import {
  AI_WRITE_OPERATIONS,
  type GenderBatchRow,
} from './_lib/data/operations/index.js'
import { neonWriter, type NeonWriteDeps } from './_lib/neonWrites.js'
import {
  replyReviewWriter,
  saveReplyReview,
} from './_lib/neonReplyReviewWrites.js'
import { REPLY_REVIEW_OPERATIONS } from './_lib/data/operations/replyReviews.js'
import {
  REPLY_INTENT_LEVELS,
  REPLY_SENTIMENTS,
  type ReplyReviewDto,
  type ReplyReviewInput,
  type ReplyIntentLevel,
  type ReplySentiment,
  ReplyReviewConflictError,
  ReplyReviewUnavailableError,
  ReplyReviewValidationError,
} from './_lib/replyReview.js'

export const maxDuration = 300

const MODEL = 'claude-haiku-4-5'

const BODY_CAP = 600 // chars per message shown to the model

// --- demographics phase (Feature 2) ---------------------------------------
// Migration 048 derives age synchronously when notebook year signals change;
// this phase owns only name/headline gender inference.
const GENDERS = ['male', 'female', 'unknown'] as const
const DEMO_BATCH = 100 // leads processed per invocation
const DEMO_GROUP = 25 // leads per gender model call
const GENDER_VERSION = 'name-headline-v1'

const GENDER_SYSTEM = `You infer the likely GENDER of a person from their name and
professional headline, for internal outreach analytics only. For each person return
one of: "male", "female", or "unknown", plus a confidence 0..1.

Rules:
- Return "unknown" (with low confidence) whenever the name is ambiguous, initials-only,
  a company/handle rather than a personal name, or from a naming culture you cannot
  call reliably (many East-Asian romanizations, unisex names, etc.). "unknown" is a
  valid, expected answer — never guess just to avoid it.
- confidence reflects how sure you are of the chosen label (a confident "unknown" is
  fine when a name is genuinely unattributable).
- Use the headline only as a weak tiebreaker; never infer gender from job title alone.
- Return exactly one result per person, with "ref" set to that person's [person N] number.`

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

const REPLY_CLASSIFICATION_DISABLED = {
  classified: 0,
  remaining: null,
  reply_classification: 'disabled',
  manual_only: true,
  reason: 'manual_review_required',
} as const


async function handle(req: Request, deps: NeonWriteDeps = {}): Promise<Response> {
  const mode = new URL(req.url).searchParams.get('mode')

  // Manual reclassification used to be its own function file. It was folded in
  // here to free the one Vercel slot S17's identity endpoint needs, under the
  // same `?mode=` dispatch the demographics branch below already uses. It keeps
  // its own method check and its own admin guard rather than inheriting the
  // GET/cron branch below — a cron caller must never reach it. `vercel.json`
  // rewrites `/api/reclassify` here, so the client-visible URL is unchanged.
  if (mode === 'reclassify') return handleReclassify(req, deps)

  if (req.method === 'GET') {
    const denied = await guardMachine(req, 'CRON_SECRET')
    if (denied) return denied
    if (mode === 'demographics') {
      if (deploymentAiPath() === 'neon') return classifyDemographicsOnNeon()
      return json({ classified: 0, remaining: 0, demographics: await runDemographics(db()) })
    }
    // The old scheduled handler also drained demographics after reply
    // classification. Preserve that supported gender work while retiring only
    // the reply AI phase.
    if (deploymentAiPath() === 'neon') {
      try {
        return json({
          ...REPLY_CLASSIFICATION_DISABLED,
          demographics: await runDemographicsOnNeon(getAiDataStore(), SYSTEM_ACTOR),
        })
      } catch (error) {
        console.error('Neon demographics failed:', safeErrorLabel(error))
        return json({ ...REPLY_CLASSIFICATION_DISABLED, demographics: { processed: 0, failed: 1, remaining: null, lifecycle: 'unavailable' } })
      }
    }
    return json({
      ...REPLY_CLASSIFICATION_DISABLED,
      demographics: await runDemographics(db()),
    })
  }

  if (mode === 'demographics') {
    if (deploymentAiPath() === 'neon') return classifyOnNeon(req, mode, deps)
    const auth = await guardAdmin(req)
    if (auth.response) return auth.response
    return json({
      classified: 0,
      remaining: 0,
      demographics: await runDemographics(db()),
    })
  }

  if (deploymentAiPath() === 'neon') return classifyOnNeon(req, mode, deps)
  const auth = await guardAdmin(req)
  if (auth.response) return auth.response
  // Manual review is the only supported reply classification path. The legacy
  // Supabase provider has no review schema and must fail closed without writes.
  return json({ ...REPLY_CLASSIFICATION_DISABLED, provider: 'supabase', code: 'REPLY_REVIEW_UNAVAILABLE' }, 503)
}

interface DemoLead {
  id: string
  instance_id: string
  profile_url: string
  full_name: string | null
  headline: string | null
}

interface DemographicsRun {
  processed: number
  failed: number
  remaining: number | null
  lifecycle: 'v2' | 'legacy' | 'unavailable'
}

/**
 * Select a fair gender batch from the split lifecycle introduced by migration 048.
 * Every account contributes candidates before round-robin selection, so one older
 * notebook cannot monopolize the global oldest-first window.
 *
 * Returns null only when the v2 columns are absent, allowing a rolling deployment
 * to fall back to migration 041's legacy combined stamp.
 */
async function selectGenderBatchV2(
  sb: ReturnType<typeof db>
): Promise<DemoLead[] | null> {
  const { data: instances, error: instanceError } = await sb
    .from('instances')
    .select('id')
    .order('id')
  if (instanceError) throw instanceError

  const buckets: DemoLead[][] = []
  for (const instance of (instances ?? []) as Array<{ id: string }>) {
    const { data, error } = await sb
      .from('leads')
      .select('id,instance_id,profile_url,full_name,headline')
      .eq('instance_id', instance.id)
      .or('demo_model.is.null,demo_model.neq.manual')
      .or(
        `gender_inferred_at.is.null,gender_model_version.is.null,` +
          `gender_model_version.neq.${GENDER_VERSION}`
      )
      .order('added_at', { ascending: true })
      .limit(DEMO_BATCH)
    if (error) {
      if (error.code === '42703' || /column\s+.*\s+does not exist/i.test(error.message)) {
        return null
      }
      throw error
    }
    buckets.push((data ?? []) as DemoLead[])
  }

  const selected: DemoLead[] = []
  const seenPeople = new Set<string>()
  for (let offset = 0; selected.length < DEMO_BATCH; offset++) {
    let found = false
    for (const bucket of buckets) {
      const lead = bucket[offset]
      if (!lead) continue
      found = true
      const personKey = `${lead.instance_id}|${lead.profile_url}`
      if (seenPeople.has(personKey)) continue
      seenPeople.add(personKey)
      selected.push(lead)
      if (selected.length === DEMO_BATCH) break
    }
    if (!found) break
  }
  return selected
}

async function selectGenderBatchLegacy(sb: ReturnType<typeof db>): Promise<DemoLead[]> {
  const { data, error } = await sb
    .from('leads')
    .select('id,instance_id,profile_url,full_name,headline')
    .is('demo_inferred_at', null)
    .order('added_at', { ascending: true })
    .limit(DEMO_BATCH)
  if (error) throw error
  return (data ?? []) as DemoLead[]
}

async function countGenderBacklog(
  sb: ReturnType<typeof db>,
  lifecycle: 'v2' | 'legacy'
): Promise<number | null> {
  let query = sb.from('leads').select('id', { count: 'exact', head: true })
  if (lifecycle === 'v2') {
    query = query
      .or('demo_model.is.null,demo_model.neq.manual')
      .or(
        `gender_inferred_at.is.null,gender_model_version.is.null,` +
          `gender_model_version.neq.${GENDER_VERSION}`
      )
  } else {
    query = query.is('demo_inferred_at', null)
  }
  const { count, error } = await query
  if (error) {
    console.warn('gender backlog count failed:', error.message)
    return null
  }
  return count ?? 0
}

/**
 * Gender inference phase, capped at DEMO_BATCH and grouped by DEMO_GROUP.
 *
 * Idempotent + versioned: manual rows are excluded; completed rows are selected again
 * only after their name/headline changes (the migration resets their stamp) or this
 * code intentionally bumps GENDER_VERSION.
 *
 * Best-effort: failures never break reply classification. The response makes partial
 * progress and the remaining backlog visible instead of silently returning a number.
 *
 * HARD NO-PHOTOS RULE: the select list is explicit TEXT columns only — never
 * photo_path, never `select *` — because photo data must not reach any model.
 */
async function runDemographics(sb: ReturnType<typeof db>): Promise<DemographicsRun> {
  let processed = 0
  let failed = 0
  let lifecycle: 'v2' | 'legacy' = 'v2'
  try {
    let leads = await selectGenderBatchV2(sb)
    if (leads === null) {
      lifecycle = 'legacy'
      leads = await selectGenderBatchLegacy(sb)
    }
    if (!leads.length) {
      return {
        processed: 0,
        failed: 0,
        remaining: await countGenderBacklog(sb, lifecycle),
        lifecycle,
      }
    }

    const now = new Date().toISOString()

    const writeDemo = async (
      lead: DemoLead,
      gender: (typeof GENDERS)[number],
      confidence: number
    ) => {
      const lifecyclePatch =
        lifecycle === 'v2'
          ? {
              gender_inferred_at: now,
              gender_model_version: GENDER_VERSION,
            }
          : {}
      const { error: upErr } = await sb
        .from('leads')
        .update({
          gender,
          gender_confidence: confidence,
          ...lifecyclePatch,
          // Legacy compatibility for clients deployed before migration 048.
          demo_inferred_at: now,
          demo_model: MODEL,
        })
        // A person may exist in several campaigns on the same account. Persist one
        // evaluation across every row so charts and manual review cannot diverge.
        .eq('instance_id', lead.instance_id)
        .eq('profile_url', lead.profile_url)
      if (upErr) failed++
      else processed++
    }

    // Leads with no usable name skip the model entirely — stamp 'unknown' directly.
    const named: DemoLead[] = []
    const nameless: DemoLead[] = []
    for (const l of leads) {
      if (l.full_name && l.full_name.trim()) named.push(l)
      else nameless.push(l)
    }
    await Promise.all(nameless.map((l) => writeDemo(l, 'unknown', 0)))

    for (const group of chunk(named, DEMO_GROUP)) {
      const prompt = group
        .map(
          (l, i) =>
            `[person ${i}] name: ${l.full_name?.trim() ?? ''}` +
            (l.headline?.trim() ? `\nheadline: ${l.headline.trim().slice(0, BODY_CAP)}` : '')
        )
        .join('\n\n')

      let results: Array<{ ref: number; gender: (typeof GENDERS)[number]; confidence: number }>
      try {
        const { object } = await generateObject({
          model: anthropic(MODEL),
          schema: z.object({
            results: z
              .array(
                z.object({
                  ref: z.number().int(),
                  gender: z.enum(GENDERS),
                  confidence: z.number().min(0).max(1),
                })
              )
              .length(group.length),
          }),
          system: GENDER_SYSTEM,
          prompt,
        })
        results = object.results
      } catch (e) {
        console.warn('gender inference failed for a group:', e)
        failed += group.length
        continue
      }

      // Same ref-validation as sentiment: valid, in-range, not-yet-used index into
      // THIS group, so a hallucinated/duplicate ref can't write onto the wrong lead.
      const usedRefs = new Set<number>()
      await Promise.all(
        results.map(async (r) => {
          if (!Number.isInteger(r.ref) || r.ref < 0 || r.ref >= group.length) return
          if (usedRefs.has(r.ref)) return
          usedRefs.add(r.ref)
          const lead = group[r.ref]
          if (!lead) return
          const confidence = Math.min(1, Math.max(0, r.confidence))
          await writeDemo(lead, r.gender, confidence)
        })
      )
    }

    return {
      processed,
      failed,
      remaining: await countGenderBacklog(sb, lifecycle),
      lifecycle,
    }
  } catch (e) {
    console.warn('demographics phase threw:', e)
    return {
      processed,
      failed,
      remaining: null,
      lifecycle: 'unavailable',
    }
  }
}

// ---------------------------------------------------------------------------
// The Neon branches: the POST paths (batch, demographics, reclassify) under a
// human actor, and the GET cron under the system one.
//
// Same authorization argument as `neonWrites.ts` for the POST paths: the actor
// resolves against the database being written, and the admin role is re-checked
// from that resolution — the Supabase guardAdmin answer is not carried over.
// Same response bodies as the Supabase path, because the client cannot tell
// which provider answered.
//
// The cron has no actor to resolve and resolves none. Its principal is
// `app_system` and its published actor is the nil uuid, which is a value that
// belongs to nobody and unlocks exactly the five relations step 007 named.
// ---------------------------------------------------------------------------

/** Log a failure by class, never by message — the driver composes connection
 *  failures with the database hostname, and no driver text may reach a log.
 *  Same duplication note as the copies in `neonWrites.ts` and `coach.ts`. */
function safeErrorLabel(error: unknown): string {
  if (error instanceof DataStoreContractError) return `${error.name}(${error.code})`
  if (error instanceof Error) return error.name
  return 'UnknownError'
}

/** The demographics phase on Neon. The baseline carries migration 048's v2
 *  columns by construction, so there is no legacy ladder here — one fair-batch
 *  statement replaces the per-instance walk `selectGenderBatchV2` does. */
async function runDemographicsOnNeon(
  store: DataStore,
  actor: ActorContext
): Promise<DemographicsRun> {
  let processed = 0
  let failed = 0
  try {
    const batchPage = await store.query<GenderBatchRow>(actor, {
      operation: AI_WRITE_OPERATIONS.classifyGenderBatch,
      params: {
        genderVersion: GENDER_VERSION,
        bucketLimit: DEMO_BATCH,
        batchLimit: DEMO_BATCH,
      },
      page: { limit: DEMO_BATCH },
    })
    const leads = [...batchPage.items]

    const countBacklog = async (): Promise<number | null> => {
      try {
        const page = await store.query<{ remaining: number }>(actor, {
          operation: AI_WRITE_OPERATIONS.classifyGenderBacklog,
          params: { genderVersion: GENDER_VERSION },
          page: { limit: 1 },
        })
        return page.items[0]?.remaining ?? 0
      } catch (e) {
        console.warn('gender backlog count failed:', safeErrorLabel(e))
        return null
      }
    }

    if (!leads.length) {
      return {
        processed: 0,
        failed: 0,
        remaining: await countBacklog(),
        lifecycle: 'v2',
      }
    }

    const now = new Date().toISOString()

    const writeDemo = async (
      lead: GenderBatchRow,
      gender: (typeof GENDERS)[number],
      confidence: number
    ) => {
      try {
        await store.transaction(actor, async (transaction) =>
          transaction.execute<{ updated: number }>({
            operation: AI_WRITE_OPERATIONS.classifyWriteGender,
            params: {
              instanceId: lead.instance_id,
              profileUrl: lead.profile_url,
              gender,
              confidence,
              now,
              model: MODEL,
              genderVersion: GENDER_VERSION,
            },
          })
        )
        processed++
      } catch {
        failed++
      }
    }

    // Leads with no usable name skip the model entirely — stamp 'unknown' directly.
    const named: GenderBatchRow[] = []
    const nameless: GenderBatchRow[] = []
    for (const l of leads) {
      if (l.full_name && l.full_name.trim()) named.push(l)
      else nameless.push(l)
    }
    await Promise.all(nameless.map((l) => writeDemo(l, 'unknown', 0)))

    for (const group of chunk(named, DEMO_GROUP)) {
      const prompt = group
        .map(
          (l, i) =>
            `[person ${i}] name: ${l.full_name?.trim() ?? ''}` +
            (l.headline?.trim() ? `\nheadline: ${l.headline.trim().slice(0, BODY_CAP)}` : '')
        )
        .join('\n\n')

      let results: Array<{ ref: number; gender: (typeof GENDERS)[number]; confidence: number }>
      try {
        const { object } = await generateObject({
          model: anthropic(MODEL),
          schema: z.object({
            results: z
              .array(
                z.object({
                  ref: z.number().int(),
                  gender: z.enum(GENDERS),
                  confidence: z.number().min(0).max(1),
                })
              )
              .length(group.length),
          }),
          system: GENDER_SYSTEM,
          prompt,
        })
        results = object.results
      } catch (e) {
        console.warn('gender inference failed for a group:', e)
        failed += group.length
        continue
      }

      // Same ref-validation as sentiment: valid, in-range, not-yet-used index
      // into THIS group.
      const usedRefs = new Set<number>()
      await Promise.all(
        results.map(async (r) => {
          if (!Number.isInteger(r.ref) || r.ref < 0 || r.ref >= group.length) return
          if (usedRefs.has(r.ref)) return
          usedRefs.add(r.ref)
          const lead = group[r.ref]
          if (!lead) return
          const confidence = Math.min(1, Math.max(0, r.confidence))
          await writeDemo(lead, r.gender, confidence)
        })
      )
    }

    return {
      processed,
      failed,
      remaining: await countBacklog(),
      lifecycle: 'v2',
    }
  } catch (e) {
    console.warn('demographics phase threw:', safeErrorLabel(e))
    return {
      processed,
      failed,
      remaining: null,
      lifecycle: 'unavailable',
    }
  }
}

/** The Neon demographics branch and retired admin reply-classification branch. */
async function classifyOnNeon(
  req: Request,
  mode: string | null,
  deps: NeonWriteDeps = {}
): Promise<Response> {
  let writer
  try {
    writer = await neonWriter(req, deps)
  } catch (error) {
    const denial = authorizationResponse(error)
    if (denial) return denial
    // The database was not reached, so no membership decision was taken and
    // the answer below would be a claim about one. Named cause, honest status.
    const unavailable = unavailableResponse(error)
    if (unavailable) return unavailable
    console.error('Neon classify failed (verify team access):', safeErrorLabel(error))
    return json({ error: 'Could not verify team access' }, 500)
  }
  if (writer.actor.role !== 'admin') {
    return json({ error: 'Admin access required' }, 403)
  }
  if (mode === 'demographics') {
    return json({
      classified: 0,
      remaining: 0,
      demographics: await runDemographicsOnNeon(writer.store, writer.actor),
    })
  }
  return json(REPLY_CLASSIFICATION_DISABLED)
}

function classifyDemographicsOnNeon(): Promise<Response> {
  return (async () => {
    try {
      return json({
        classified: 0,
        remaining: 0,
        demographics: await runDemographicsOnNeon(getAiDataStore(), SYSTEM_ACTOR),
      })
    } catch (error) {
      console.error('Neon demographics failed:', safeErrorLabel(error))
      return json({ error: 'Could not classify demographics' }, 500)
    }
  })()
}

// ---------------------------------------------------------------------------
// Manual reclassification compatibility — formerly `frontend/api/reclassify.ts`.
// The legacy route is retained for old drawer callers, but delegates to the
// transactional manual-review service. It never has an independent message
// UPDATE path and it cannot operate on the Supabase fallback.
// ---------------------------------------------------------------------------

interface ReclassifyInput {
  readonly id: number
  readonly hasSentiment: boolean
  readonly sentiment: ReplySentiment | undefined
  readonly hasIntent: boolean
  readonly intent: ReplyIntentLevel | null | undefined
  readonly reason: string
  readonly intentReason: string
  readonly instanceId: string
  readonly profileUrl: string
  readonly mutationId: string
  readonly expectedReviewRevision: number
}

type ReclassifyPayload = {
  id?: unknown
  sentiment?: unknown
  intent_level?: unknown
  reason?: unknown
  intent_reason?: unknown
  instance_id?: unknown
  profile_url?: unknown
  mutation_id?: unknown
  expected_review_revision?: unknown
  review_revision?: unknown
  revision?: unknown
}

/** The one definition of a legal reclassify body, shared by both providers so
 *  they cannot drift on what a manual correction may contain. */
function parseReclassifyPayload(payload: ReclassifyPayload):
  | { error: string; status: number; code?: string }
  | { input: ReclassifyInput } {
  const id = Number(payload.id)
  if (!Number.isInteger(id) || id <= 0) {
    return { error: 'id must be a positive integer', status: 400 }
  }
  const hasSentiment = payload.sentiment !== undefined
  const hasIntent = payload.intent_level !== undefined
  if (!hasSentiment && !hasIntent) {
    return { error: 'sentiment or intent_level is required', status: 400 }
  }
  if (hasSentiment && !REPLY_SENTIMENTS.includes(payload.sentiment as ReplySentiment)) {
    return { error: `sentiment must be one of ${REPLY_SENTIMENTS.join(', ')}`, status: 400 }
  }
  if (
    hasIntent &&
    payload.intent_level !== null &&
    !REPLY_INTENT_LEVELS.includes(payload.intent_level as ReplyIntentLevel)
  ) {
    return { error: `intent_level must be null or one of ${REPLY_INTENT_LEVELS.join(', ')}`, status: 400 }
  }

  // The old endpoint had only an id and was safe only while direct message
  // updates were the canonical projection. After activation, a caller must
  // identify the thread and participate in optimistic revision/replay checks.
  const instanceId = typeof payload.instance_id === 'string' ? payload.instance_id.trim() : ''
  const profileUrl = typeof payload.profile_url === 'string' ? payload.profile_url.trim() : ''
  const mutationId = typeof payload.mutation_id === 'string' ? payload.mutation_id.trim() : ''
  const revisionValue = payload.expected_review_revision ?? payload.review_revision ?? payload.revision
  if (!instanceId || !profileUrl || !mutationId || revisionValue === undefined || revisionValue === null || revisionValue === '') {
    return {
      error: 'manual review must be refreshed before reclassifying',
      code: 'review_refresh_required',
      status: 409,
    }
  }
  const expectedReviewRevision = Number(revisionValue)
  if (!Number.isSafeInteger(expectedReviewRevision) || expectedReviewRevision < 0) {
    return { error: 'expected_review_revision must be a non-negative integer', status: 400 }
  }
  return {
    input: {
      id,
      hasSentiment,
      sentiment: payload.sentiment as ReplySentiment | undefined,
      hasIntent,
      intent: payload.intent_level as ReplyIntentLevel | null | undefined,
      reason:
        typeof payload.reason === 'string' && payload.reason.trim()
          ? payload.reason.trim().slice(0, 300)
          : 'manual override',
      intentReason:
        typeof payload.intent_reason === 'string' && payload.intent_reason.trim()
          ? payload.intent_reason.trim().slice(0, 300)
          : 'manual override',
      instanceId,
      profileUrl,
      mutationId,
      expectedReviewRevision,
    },
  }
}

function reclassifyErrorResponse(error: unknown): Response {
  const denial = authorizationResponse(error)
  if (denial) return denial
  const unavailable = unavailableResponse(error)
  if (unavailable) return unavailable
  if (error instanceof ReplyReviewValidationError) return json({ error: error.message, code: error.code }, 400)
  if (error instanceof ReplyReviewConflictError) return json({ error: error.message, code: error.code, current: error.current }, 409)
  if (error instanceof ReplyReviewUnavailableError) return json({ error: 'Manual reply review is unavailable for this tenant', code: 'REPLY_REVIEW_UNAVAILABLE' }, 503)
  console.error('Neon reclassify failed:', safeErrorLabel(error))
  return json({ error: 'Could not reclassify message' }, 500)
}

/** Resolve the current review, merge the legacy partial fields, and delegate to
 * the same internal manual service used by the new pipeline action. */
async function reclassifyOnNeon(req: Request, deps: NeonWriteDeps = {}): Promise<Response> {
  let writer
  try {
    writer = await replyReviewWriter(req, deps)
  } catch (error) {
    return reclassifyErrorResponse(error)
  }
  const { store, actor } = writer

  let payload: ReclassifyPayload
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const parsed = parseReclassifyPayload(payload)
  if ('error' in parsed) return json({ error: parsed.error, ...(parsed.code ? { code: parsed.code } : {}) }, parsed.status)
  const { input } = parsed

  try {
    const priorPage = await store.query<ReplyReviewDto>(actor, {
      operation: REPLY_REVIEW_OPERATIONS.reviewForMessage,
      params: {
        instanceId: input.instanceId,
        profileUrl: input.profileUrl,
        messageId: input.id,
      },
      page: { limit: 1 },
    })
    const prior = priorPage.items[0] ?? null
    const sentiment = input.hasSentiment ? input.sentiment ?? null : prior?.sentiment ?? null
    let intentState = input.hasIntent
      ? input.intent === null ? 'none' as const : 'level' as const
      : prior?.intent_state ?? 'unreviewed' as const
    let intentLevel = input.hasIntent ? input.intent ?? null : prior?.intent_level ?? null
    if (sentiment === 'auto') {
      intentState = 'not_applicable'
      intentLevel = null
    } else if (intentState === 'not_applicable') {
      intentState = 'unreviewed'
      intentLevel = null
    }
    const review: ReplyReviewInput = {
      sentiment,
      intent_state: intentState,
      intent_level: intentLevel,
      reason_ids: input.hasSentiment
        ? sentiment === 'negative' || sentiment === 'objection' ? ['other'] : []
        : prior?.reason_ids ?? [],
      comment: input.hasSentiment
        ? input.reason
        : input.hasIntent
          ? input.intentReason
          : prior?.comment ?? null,
    }
    const result = await saveReplyReview(store, actor, {
      action: 'save_reply_review',
      mutation_id: input.mutationId,
      instance_id: input.instanceId,
      profile_url: input.profileUrl,
      message_id: input.id,
      expected_review_revision: input.expectedReviewRevision,
      review,
    })
    return json({
      ok: true,
      id: result.review?.message_id ?? input.id,
      sentiment: result.review?.sentiment ?? null,
      intent_level: result.review?.intent_level ?? null,
      review: result.review,
      workflow: result.workflow,
      inbound_revision: result.inbound_revision,
      mutation_id: result.mutation_id,
    })
  } catch (error) {
    return reclassifyErrorResponse(error)
  }
}

async function handleReclassify(req: Request, deps: NeonWriteDeps = {}): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405)
  }

  if (deploymentAiPath() === 'neon') return reclassifyOnNeon(req, deps)

  const auth = await guardAdmin(req)
  if (auth.response) return auth.response
  // The fallback has no reply-review schema. Never resurrect the old direct
  // UPDATE, even when a legacy caller still posts this URL.
  return json({ error: 'Manual reply review is unavailable for this tenant', code: 'REPLY_REVIEW_UNAVAILABLE', manual_only: true }, 503)
}

export const GET = (req: Request) => handle(req)
export const POST = (req: Request) => handle(req)
