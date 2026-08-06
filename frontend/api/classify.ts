// Reply classifier. Reads unclassified inbound replies, sends
// each one (with its conversation thread for context) to Claude, and writes
// back independent sentiment + commercial-intent labels. Reuses the same Anthropic key and
// service-role Supabase client as /api/chat — nothing runs on the notebooks.
//
// Triggers:
//   GET  — the daily Vercel cron (guarded by CRON_SECRET).
//   POST — the admin-only "Classify replies" button on the Leads page.
//
// AI-path split, by actor — and since ledger step 007 was applied, both halves
// move with `NEON_AI_PATH_DEFAULT=neon`:
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
// The two share one body (`runClassifyOnNeon`) because the difference between
// them is the principal and nothing else — same batch sizes, same prompts, same
// ref-validation, same response shape.
//
// ONE exception, and it is a real one: pipeline auto-advance. `app_system` holds
// no EXECUTE on `public.pipeline_auto_advance()`; ledger step 008 grants it and
// is written but NOT applied. The guard is not a way around that — it is
// SELECT-only and `app_ai_runner` holds no EXECUTE either — so the cron reports
// `auto_advance_blocked` in its response instead of quietly answering as though
// it had done the work. A cron run that labelled replies but could not advance
// the pipeline is a PARTIAL run and says so.
import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { db } from './_lib/core.js'
import { guardAdmin, guardMachine, authorizationResponse } from './_lib/auth.js'
import { deploymentAiPath } from './_lib/data/aiPath.js'
import { getAiDataStore, SYSTEM_ACTOR } from './_lib/data/aiStore.js'
import {
  DataStoreContractError,
  MAX_PAGE_SIZE,
  type ActorContext,
  type DataStore,
  type Page,
} from './_lib/data/contracts.js'
import {
  AI_WRITE_OPERATIONS,
  type GenderBatchRow,
  type PendingReplyRow,
  type ThreadContextRow,
} from './_lib/data/operations/index.js'
import { neonWriter, type NeonWriteDeps } from './_lib/neonWrites.js'

export const maxDuration = 300

const MODEL = 'claude-haiku-4-5'
const SENTIMENTS = [
  'positive',
  'neutral',
  'negative',
  'objection',
  'referral',
  'auto',
] as const
const INTENTS = ['p1', 'p2', 'p3'] as const
const INTENT_TAXONOMY_VERSION = 'p123-v1'

type Sentiment = (typeof SENTIMENTS)[number]
type ReplyIntent = (typeof INTENTS)[number]

const BATCH = 60 // max replies classified per invocation
const GROUP = 10 // replies per model call
const CTX_MSGS = 8 // thread messages of context per reply
const BODY_CAP = 600 // chars per message shown to the model

const SYSTEM = `You classify the latest inbound reply in a LinkedIn outreach
conversation on TWO INDEPENDENT dimensions: sentiment and commercial intent.
We sent the OUT messages; the lead sent the IN messages. Judge only the reply
marked ">>> REPLY TO CLASSIFY", using the thread for context.

SENTIMENT:
- positive: genuinely interested — wants to talk, asks for a call/info, says yes.
- neutral: polite acknowledgement or soft defer ("thanks", "not right now,
  maybe later", "circle back in Q3") with no clear yes or no.
- negative: not interested, declines, asks to stop/unsubscribe, annoyed.
- objection: engaged but pushing back or asking a qualifying question that needs
  a real answer ("how is this different from X?", "what does it cost?", "who are
  you?"). Use this over positive/negative when the next step is to handle a
  concern.
- referral: not the right person — points you to a colleague or another contact.
- auto: an automated message (out-of-office, autoresponder, "I'm on leave"),
  not a deliberate human reply.

COMMERCIAL INTENT (independent of sentiment):
- p1: polite positive acknowledgement or encouragement, but no substantive
  exploration and no concrete commercial next step ("great ideas, thanks").
- p2: discusses the relevant problem, context, constraints, or asks a substantive
  qualifying question, but does not request/accept a concrete buying step.
- p3: requests or accepts a call, scheduling, proposal, pricing/process/timeline
  needed to proceed, or is ready for a concrete commercial next step.
- null: no positive commercial signal (negative, auto, irrelevant, or purely neutral).

Use the HIGHEST supported intent: p3 > p2 > p1. Sentiment stays independent:
"too expensive, but let's book a call" is objection + p3. A pricing/process
question that is needed to proceed is p3; generic pushback with no next-step
readiness is objection + p2. "Send details" is p3 only when it is a concrete
next step, not a dismissive brush-off. A referral stays referral and may carry
intent only when the sender also expresses their own commercial interest.

BOUNDARY EXAMPLES:
- "Great ideas, thanks" => neutral + p1.
- "We have this problem too; how do you handle legacy integrations?" => objection + p2.
- "What does it cost?" with no readiness/context => objection + p2.
- "Send pricing and your earliest start date so we can choose" => positive + p3.
- "Interesting, let's find 20 minutes next week" => positive + p3.
- "Too expensive, but book a call and walk me through options" => objection + p3.
- "Not now, circle back in Q4" => neutral + null.
- "Talk to our CTO instead" => referral + null.

Give terse reasons (max ~12 words each). Return exactly one result per reply, with
"ref" set to that reply's [reply N] number.`

// --- demographics phase (Feature 2) ---------------------------------------
// A SECOND phase that runs after sentiment (both GET and POST, and even when the
// sentiment batch was empty). Migration 048 derives age synchronously when notebook
// year signals change; this phase now owns only name/headline gender inference.
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

interface Reply {
  id: number
  instance_id: string
  profile_url: string
  body: string | null
  sent_at: string
  sentiment: (typeof SENTIMENTS)[number] | null
  classified_model: string | null
}

interface Msg {
  instance_id: string
  profile_url: string
  direction: string
  body: string | null
  sent_at: string
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const key = (instance_id: string, profile_url: string) =>
  `${instance_id}|${profile_url}`

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

/** Render a numbered reply with its preceding conversation for the model. */
function renderReply(
  ref: number,
  reply: Pick<Reply, 'body' | 'sent_at'>,
  thread: Msg[]
): string {
  const prior = thread
    .filter((m) => m.sent_at <= reply.sent_at)
    .slice(-CTX_MSGS)
  const lines = prior.map((m) => {
    const who = m.direction === 'in' ? 'IN ' : 'OUT'
    const last = m.direction === 'in' && m.sent_at === reply.sent_at
    const tag = last ? '>>> REPLY TO CLASSIFY (IN)' : who
    return `${tag}: ${(m.body ?? '').slice(0, BODY_CAP)}`
  })
  // Safety net if the reply somehow isn't in the fetched thread.
  if (!prior.some((m) => m.sent_at === reply.sent_at && m.direction === 'in')) {
    lines.push(`>>> REPLY TO CLASSIFY (IN): ${(reply.body ?? '').slice(0, BODY_CAP)}`)
  }
  return `[reply ${ref}]\n${lines.join('\n')}`
}

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
    // The cron half. Step 007 gave the server-owned principal its own write
    // path, so this no longer has to stay behind: it runs on the AI store as
    // `app_system`, with auto-advance declared blocked rather than attempted.
    if (deploymentAiPath() === 'neon') return classifyCronOnNeon(mode)
  } else if (deploymentAiPath() === 'neon') {
    return classifyOnNeon(req, mode, deps)
  } else {
    const auth = await guardAdmin(req)
    if (auth.response) return auth.response
  }

  const sb = db()

  // Dedicated mode lets an operator drain the gender backlog without first spending
  // the invocation budget on reply classification. It stays on this endpoint to
  // preserve the Vercel function-count constraint.
  if (mode === 'demographics') {
    return json({
      classified: 0,
      remaining: 0,
      demographics: await runDemographics(sb),
    })
  }

  const { data: replies, error } = await sb
    .from('messages')
    .select('id,instance_id,profile_url,body,sent_at,sentiment,classified_model')
    .eq('direction', 'in')
    .or('sentiment.is.null,sentiment.neq.auto')
    .or(`intent_taxonomy_version.is.null,intent_taxonomy_version.neq.${INTENT_TAXONOMY_VERSION}`)
    .not('body', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(BATCH)
  if (error) return json({ error: error.message }, 500)
  if (!replies?.length) {
    // No backlog to classify, but auto-advance still runs: migration 028's RPC
    // doubles as the launch backfill, so already-classified-but-untriaged leads
    // must get advanced even when the cron has no new replies to label.
    const auto_advanced = await autoAdvancePipeline(sb)
    // Demographics still run on an empty sentiment batch (same slot as auto-advance):
    // there is a separate backlog of leads awaiting demographic inference.
    const demographics = await runDemographics(sb)
    return json({
      classified: 0,
      remaining: 0,
      ...(auto_advanced !== undefined ? { auto_advanced } : {}),
      demographics,
    })
  }

  // Pull conversation context for every lead in the batch in one query, then
  // group by (instance_id, profile_url). profile_url is near-unique, so the
  // .in() over-fetch is small and we filter to the exact pair client-side.
  const profiles = [...new Set(replies.map((r) => r.profile_url))]
  const instances = [...new Set(replies.map((r) => r.instance_id))]
  // Scope by instance too (profile_url isn't globally unique across accounts), and
  // fetch newest-first so PostgREST's 1000-row cap drops the OLDEST context rather
  // than the recent messages we actually need around each reply.
  const { data: ctxRows } = await sb
    .from('messages')
    .select('instance_id,profile_url,direction,body,sent_at')
    .in('instance_id', instances)
    .in('profile_url', profiles)
    .order('sent_at', { ascending: false })
    .limit(5000)
  const threads = new Map<string, Msg[]>()
  for (const m of (ctxRows ?? []) as Msg[]) {
    const k = key(m.instance_id, m.profile_url)
    let arr = threads.get(k)
    if (!arr) threads.set(k, (arr = []))
    arr.push(m)
  }
  // renderReply expects each thread oldest-first; we fetched newest-first.
  for (const arr of threads.values()) arr.reverse()

  const now = new Date().toISOString()
  let classified = 0

  for (const group of chunk(replies as Reply[], GROUP)) {
    const prompt = group
      .map((r, i) => renderReply(i, r, threads.get(key(r.instance_id, r.profile_url)) ?? []))
      .join('\n\n')

    const { object } = await generateObject({
      model: anthropic(MODEL),
      schema: z.object({
        results: z.array(
          z.object({
            ref: z.number().int(),
            sentiment: z.enum(SENTIMENTS),
            sentiment_reason: z.string(),
            intent_level: z.enum(INTENTS).nullable(),
            intent_reason: z.string(),
          })
        ),
      }),
      system: SYSTEM,
      prompt,
    })

    // The model returns a `ref` per reply; trust it only as a valid, in-range,
    // not-yet-used index into THIS group, so a hallucinated/duplicate ref can't
    // write a sentiment onto the wrong message.
    const usedRefs = new Set<number>()
    await Promise.all(
      object.results.map(async (r) => {
        if (!Number.isInteger(r.ref) || r.ref < 0 || r.ref >= group.length) return
        if (usedRefs.has(r.ref)) return
        usedRefs.add(r.ref)
        const reply = group[r.ref]
        if (!reply) return
        // Human sentiment corrections are ground truth. Historical manual rows
        // still receive an AI intent level, but their sentiment is never overwritten.
        const sentimentPatch =
          reply.classified_model === 'manual'
            ? {}
            : {
                sentiment: r.sentiment,
                reason: r.sentiment_reason.slice(0, 300),
                classified_at: now,
                classified_model: MODEL,
              }
        const { error: upErr } = await sb
          .from('messages')
          .update({
            ...sentimentPatch,
            intent_level: r.intent_level,
            intent_reason: r.intent_reason.slice(0, 300),
            intent_classified_at: now,
            intent_classified_model: MODEL,
            intent_taxonomy_version: INTENT_TAXONOMY_VERSION,
          })
          .eq('id', reply.id)
        if (!upErr) classified++
      })
    )
  }

  const { count } = await sb
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'in')
    .or('sentiment.is.null,sentiment.neq.auto')
    .or(`intent_taxonomy_version.is.null,intent_taxonomy_version.neq.${INTENT_TAXONOMY_VERSION}`)
    .not('body', 'is', null)

  // Freshly-classified replies may unblock automatic pipeline advancement.
  // Non-fatal and tolerant of migration 028 not being pushed yet: supabase-js
  // returns {error} (e.g. SQLSTATE 42883, function does not exist) rather than
  // throwing, but guard both. A missing/failed RPC just omits auto_advanced.
  const auto_advanced = await autoAdvancePipeline(sb)

  // Second phase: inferred demographics for leads not yet processed.
  const demographics = await runDemographics(sb)

  return json({
    classified,
    remaining: count ?? 0,
    ...(auto_advanced !== undefined ? { auto_advanced } : {}),
    demographics,
  })
}

/** Run pipeline_auto_advance() (migration 028); returns its count or undefined
 *  if the RPC is missing / errors. Never throws. */
async function autoAdvancePipeline(sb: ReturnType<typeof db>): Promise<number | undefined> {
  try {
    const { data, error } = await sb.rpc('pipeline_auto_advance')
    if (error) {
      console.warn('pipeline_auto_advance skipped:', error.message)
      return undefined
    }
    return typeof data === 'number' ? data : undefined
  } catch (e) {
    console.warn('pipeline_auto_advance threw:', e)
    return undefined
  }
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

/** Run pipeline_auto_advance() through the store; undefined on any failure,
 *  mirroring `autoAdvancePipeline`'s never-throw contract. */
async function autoAdvanceNeon(
  store: DataStore,
  actor: ActorContext
): Promise<number | undefined> {
  try {
    const result = await store.transaction(actor, async (transaction) =>
      transaction.execute<{ advanced: number }>({
        operation: AI_WRITE_OPERATIONS.classifyAutoAdvance,
      })
    )
    return result.advanced
  } catch (e) {
    console.warn('pipeline_auto_advance skipped:', safeErrorLabel(e))
    return undefined
  }
}

/**
 * Whether the caller's principal may run `public.pipeline_auto_advance()`.
 *
 * A capability rather than a boolean because a blocked run must be able to SAY
 * why. `app_runtime` (the admin POST) holds the EXECUTE and advances the
 * pipeline as it always has; `app_system` (the cron) does not, and the reason
 * is a ledger step that exists and has not been applied. Reporting that in the
 * response body is the difference between a partial run and a run that looks
 * complete — nothing else in this file distinguishes the two, because
 * `auto_advanced` is simply omitted when the RPC is unavailable.
 *
 * The blocked branch does NOT reach for the guard. The guard is SELECT-only,
 * `app_ai_runner` holds no EXECUTE on the function either, and giving
 * `ai_execute_sql` a write path to work around a missing grant would trade the
 * one property that makes arbitrary SQL safe for a pipeline column.
 */
type AutoAdvanceCapability =
  | { readonly kind: 'available' }
  | { readonly kind: 'blocked'; readonly reason: string }

const AUTO_ADVANCE_BLOCKED: AutoAdvanceCapability = {
  kind: 'blocked',
  reason:
    'app_system holds no EXECUTE on pipeline_auto_advance(); ledger step 008 is written and not applied',
}

/**
 * The auto-advance fragment of a response body. Exactly one of three shapes:
 * `auto_advanced` when it ran, `auto_advance_blocked` when the principal may
 * not run it, and nothing at all when it was attempted and failed — which is
 * the pre-existing contract for a missing migration 028 and is left alone.
 */
async function autoAdvanceReport(
  capability: AutoAdvanceCapability,
  store: DataStore,
  actor: ActorContext
): Promise<Record<string, unknown>> {
  if (capability.kind === 'blocked') {
    return { auto_advance_blocked: capability.reason }
  }
  const advanced = await autoAdvanceNeon(store, actor)
  return advanced !== undefined ? { auto_advanced: advanced } : {}
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

/** The admin batch + demographics on Neon. Admin is re-checked from the Neon
 *  actor resolution — the database being written decides. */
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
    console.error('Neon classify failed (verify team access):', safeErrorLabel(error))
    return json({ error: 'Could not verify team access' }, 500)
  }
  if (writer.actor.role !== 'admin') {
    return json({ error: 'Admin access required' }, 403)
  }
  return runClassifyOnNeon(writer.store, writer.actor, mode, { kind: 'available' })
}

/**
 * The cron on Neon. No actor is resolved and no admin is checked, because there
 * is no human on either side of the call: `guardMachine` already verified the
 * shared `CRON_SECRET`, and the principal is the server's own.
 *
 * `getAiDataStore()` is read here rather than passed in, exactly as
 * `notify-replies.ts` does it — the AI store is process-wide and lazy, so the
 * credential is required only when a flagged deployment actually runs the cron.
 */
function classifyCronOnNeon(mode: string | null): Promise<Response> {
  return runClassifyOnNeon(
    getAiDataStore(),
    SYSTEM_ACTOR,
    mode,
    AUTO_ADVANCE_BLOCKED
  )
}

/**
 * Everything both Neon halves do, once.
 *
 * The store and the actor are the ONLY things the two callers disagree about —
 * plus what each of them may do about auto-advance. Batch sizes, the context
 * fetch, the prompts, the ref-validation, the manual-sentiment protection and
 * the response bodies are all shared by construction, so a change to any of
 * them cannot land on one principal and miss the other.
 */
async function runClassifyOnNeon(
  store: DataStore,
  actor: ActorContext,
  mode: string | null,
  autoAdvance: AutoAdvanceCapability
): Promise<Response> {
  try {
    // Dedicated mode: drain the gender backlog without spending the invocation
    // budget on reply classification — same shape as the Supabase branch.
    if (mode === 'demographics') {
      return json({
        classified: 0,
        remaining: 0,
        demographics: await runDemographicsOnNeon(store, actor),
      })
    }

    const repliesPage = await store.query<PendingReplyRow>(actor, {
      operation: AI_WRITE_OPERATIONS.classifyPendingReplies,
      params: { taxonomyVersion: INTENT_TAXONOMY_VERSION },
      page: { limit: BATCH },
    })
    const replies = [...repliesPage.items]
    if (!replies.length) {
      // No backlog, but auto-advance and demographics still run — same contract
      // as the Supabase path's empty-batch branch.
      const advance = await autoAdvanceReport(autoAdvance, store, actor)
      const demographics = await runDemographicsOnNeon(store, actor)
      return json({
        classified: 0,
        remaining: 0,
        ...advance,
        demographics,
      })
    }

    // One context fetch for the whole batch, scoped by instance AND profile and
    // capped at the same 5000 rows PostgREST's `.limit(5000)` gives — newest
    // first, so the cap drops the oldest context.
    const profiles = [...new Set(replies.map((r) => r.profile_url))]
    const instances = [...new Set(replies.map((r) => r.instance_id))]
    const ctxRows: ThreadContextRow[] = []
    let cursor: string | null = null
    while (ctxRows.length < 5000) {
      const page: Page<ThreadContextRow> = await store.query<ThreadContextRow>(actor, {
        operation: AI_WRITE_OPERATIONS.classifyThreadContext,
        params: { instances, profiles },
        page: { limit: MAX_PAGE_SIZE, cursor },
      })
      ctxRows.push(...page.items)
      if (!page.hasMore || page.nextCursor === null) break
      cursor = page.nextCursor
    }
    const threads = new Map<string, Msg[]>()
    for (const m of ctxRows.slice(0, 5000)) {
      const k = key(m.instance_id, m.profile_url)
      let arr = threads.get(k)
      if (!arr) threads.set(k, (arr = []))
      arr.push(m)
    }
    // renderReply expects each thread oldest-first; we fetched newest-first.
    for (const arr of threads.values()) arr.reverse()

    const now = new Date().toISOString()
    let classified = 0

    for (const group of chunk(replies, GROUP)) {
      const prompt = group
        .map((r, i) => renderReply(i, r, threads.get(key(r.instance_id, r.profile_url)) ?? []))
        .join('\n\n')

      const { object } = await generateObject({
        model: anthropic(MODEL),
        schema: z.object({
          results: z.array(
            z.object({
              ref: z.number().int(),
              sentiment: z.enum(SENTIMENTS),
              sentiment_reason: z.string(),
              intent_level: z.enum(INTENTS).nullable(),
              intent_reason: z.string(),
            })
          ),
        }),
        system: SYSTEM,
        prompt,
      })

      // Same ref-validation as the Supabase path, and the same manual-sentiment
      // protection: the operation's CASE keeps a manual row's sentiment.
      const usedRefs = new Set<number>()
      await Promise.all(
        object.results.map(async (r) => {
          if (!Number.isInteger(r.ref) || r.ref < 0 || r.ref >= group.length) return
          if (usedRefs.has(r.ref)) return
          usedRefs.add(r.ref)
          const reply = group[r.ref]
          if (!reply) return
          try {
            await store.transaction(actor, async (transaction) =>
              transaction.execute<{ updated: number }>({
                operation: AI_WRITE_OPERATIONS.classifyWriteLabels,
                params: {
                  messageId: reply.id,
                  applySentiment: reply.classified_model !== 'manual',
                  sentiment: r.sentiment,
                  reason: r.sentiment_reason.slice(0, 300),
                  intentLevel: r.intent_level,
                  intentReason: r.intent_reason.slice(0, 300),
                  now,
                  model: MODEL,
                  taxonomyVersion: INTENT_TAXONOMY_VERSION,
                },
              })
            )
            classified++
          } catch {
            // A failed single label must not abort the batch — the Supabase path
            // tolerates the same per-row failure.
          }
        })
      )
    }

    const remainingPage = await store.query<{ remaining: number }>(actor, {
      operation: AI_WRITE_OPERATIONS.classifyRemainingCount,
      params: { taxonomyVersion: INTENT_TAXONOMY_VERSION },
      page: { limit: 1 },
    })

    const advance = await autoAdvanceReport(autoAdvance, store, actor)
    const demographics = await runDemographicsOnNeon(store, actor)

    return json({
      classified,
      remaining: remainingPage.items[0]?.remaining ?? 0,
      ...advance,
      demographics,
    })
  } catch (error) {
    const denial = authorizationResponse(error)
    if (denial) return denial
    console.error('Neon classify failed:', safeErrorLabel(error))
    return json({ error: 'Could not classify replies' }, 500)
  }
}

// ---------------------------------------------------------------------------
// Manual reclassification — formerly `frontend/api/reclassify.ts`.
//
// The conversation drawer posts a single inbound message id plus the sentiment
// and/or intent a human picked after reading the whole thread, and we write it
// back with `classified_model='manual'` so corrections stay distinguishable
// from this file's AI batch output. Same service-role client, same taxonomy
// constants — which is part of why this is the right file to fold it into: the
// two paths write the same columns under the same taxonomy version, and a copy
// of `INTENT_TAXONOMY_VERSION` in a second file could drift from this one.
//
// POST only and admin-guarded. The write is a single row scoped to one inbound
// message and is idempotent.
// ---------------------------------------------------------------------------

interface ReclassifyInput {
  readonly id: number
  readonly hasSentiment: boolean
  readonly sentiment: Sentiment | undefined
  readonly hasIntent: boolean
  readonly intent: ReplyIntent | null | undefined
  readonly reason: string
  readonly intentReason: string
}

/** The one definition of a legal reclassify body, shared by both providers so
 *  they cannot drift on what a manual correction may contain. */
function parseReclassifyPayload(payload: {
  id?: unknown
  sentiment?: unknown
  intent_level?: unknown
  reason?: unknown
  intent_reason?: unknown
}): { error: string; status: number } | { input: ReclassifyInput } {
  const id = Number(payload.id)
  if (!Number.isInteger(id) || id <= 0) {
    return { error: 'id must be a positive integer', status: 400 }
  }
  const hasSentiment = payload.sentiment !== undefined
  const hasIntent = payload.intent_level !== undefined
  if (!hasSentiment && !hasIntent) {
    return { error: 'sentiment or intent_level is required', status: 400 }
  }
  if (hasSentiment && !SENTIMENTS.includes(payload.sentiment as Sentiment)) {
    return { error: `sentiment must be one of ${SENTIMENTS.join(', ')}`, status: 400 }
  }
  if (
    hasIntent &&
    payload.intent_level !== null &&
    !INTENTS.includes(payload.intent_level as ReplyIntent)
  ) {
    return { error: `intent_level must be null or one of ${INTENTS.join(', ')}`, status: 400 }
  }
  return {
    input: {
      id,
      hasSentiment,
      sentiment: payload.sentiment as Sentiment | undefined,
      hasIntent,
      intent: payload.intent_level as ReplyIntent | null | undefined,
      reason:
        typeof payload.reason === 'string' && payload.reason.trim()
          ? payload.reason.trim().slice(0, 300)
          : 'manual override',
      intentReason:
        typeof payload.intent_reason === 'string' && payload.intent_reason.trim()
          ? payload.intent_reason.trim().slice(0, 300)
          : 'manual override',
    },
  }
}

/** The Neon branch of manual reclassification: resolve the actor against the
 *  database being written, re-check admin there, then the single-row update. */
async function reclassifyOnNeon(req: Request, deps: NeonWriteDeps = {}): Promise<Response> {
  let writer
  try {
    writer = await neonWriter(req, deps)
  } catch (error) {
    const denial = authorizationResponse(error)
    if (denial) return denial
    console.error('Neon reclassify failed (verify team access):', safeErrorLabel(error))
    return json({ error: 'Could not verify team access' }, 500)
  }
  if (writer.actor.role !== 'admin') {
    return json({ error: 'Admin access required' }, 403)
  }
  const { store, actor } = writer

  let payload: {
    id?: unknown
    sentiment?: unknown
    intent_level?: unknown
    reason?: unknown
    intent_reason?: unknown
  }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const parsed = parseReclassifyPayload(payload)
  if ('error' in parsed) return json({ error: parsed.error }, parsed.status)
  const { input } = parsed

  try {
    const result = await store.transaction(actor, async (transaction) =>
      transaction.execute<{
        id: number | null
        sentiment: string | null
        intent_level: string | null
      }>({
        operation: AI_WRITE_OPERATIONS.classifyReclassify,
        params: {
          messageId: input.id,
          hasSentiment: input.hasSentiment,
          sentiment: input.sentiment ?? null,
          reason: input.reason,
          hasIntent: input.hasIntent,
          intentLevel: input.intent ?? null,
          intentReason: input.intentReason,
          now: new Date().toISOString(),
          taxonomyVersion: INTENT_TAXONOMY_VERSION,
        },
      })
    )
    if (result.id === null) return json({ error: 'no inbound message with that id' }, 404)

    const auto_advanced = await autoAdvanceNeon(store, actor)

    return json({
      ok: true,
      id: result.id,
      sentiment: result.sentiment,
      intent_level: result.intent_level,
      ...(auto_advanced !== undefined ? { auto_advanced } : {}),
    })
  } catch (error) {
    const denial = authorizationResponse(error)
    if (denial) return denial
    console.error('Neon reclassify failed:', safeErrorLabel(error))
    return json({ error: 'Could not reclassify message' }, 500)
  }
}

async function handleReclassify(req: Request, deps: NeonWriteDeps = {}): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405)
  }

  if (deploymentAiPath() === 'neon') return reclassifyOnNeon(req, deps)

  const auth = await guardAdmin(req)
  if (auth.response) return auth.response

  let payload: {
    id?: unknown
    sentiment?: unknown
    intent_level?: unknown
    reason?: unknown
    intent_reason?: unknown
  }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const parsed = parseReclassifyPayload(payload)
  if ('error' in parsed) return json({ error: parsed.error }, parsed.status)
  const { input } = parsed

  const patch: Record<string, unknown> = {}
  if (input.hasSentiment) {
    Object.assign(patch, {
      sentiment: input.sentiment,
      reason: input.reason,
      classified_at: new Date().toISOString(),
      classified_model: 'manual',
    })
  }
  if (input.hasIntent) {
    Object.assign(patch, {
      intent_level: input.intent,
      intent_reason: input.intentReason,
      intent_classified_at: new Date().toISOString(),
      intent_classified_model: 'manual',
      intent_taxonomy_version: INTENT_TAXONOMY_VERSION,
    })
  }

  const sb = db()
  const { data, error } = await sb
    .from('messages')
    .update(patch)
    .eq('id', input.id)
    .eq('direction', 'in')
    .select('id,sentiment,intent_level')
    .single()

  if (error) return json({ error: error.message }, 500)
  if (!data) return json({ error: 'no inbound message with that id' }, 404)

  // A corrected sentiment may unblock automatic pipeline advancement. Non-fatal
  // and tolerant of migration 028 not being pushed yet: supabase-js returns
  // {error} (e.g. SQLSTATE 42883, function does not exist) rather than throwing,
  // but guard both. A missing/failed RPC just omits auto_advanced.
  //
  // `autoAdvancePipeline` is this file's existing helper, defined once above and
  // shared with the batch path — the duplicate that used to live in
  // reclassify.ts is gone with it.
  const auto_advanced = await autoAdvancePipeline(sb)

  return json({
    ok: true,
    id: data.id,
    sentiment: data.sentiment,
    intent_level: data.intent_level,
    ...(auto_advanced !== undefined ? { auto_advanced } : {}),
  })
}

export const GET = (req: Request) => handle(req)
export const POST = (req: Request) => handle(req)
