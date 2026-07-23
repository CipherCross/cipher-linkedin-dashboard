// Reply classifier. Reads unclassified inbound replies from Supabase, sends
// each one (with its conversation thread for context) to Claude, and writes
// back independent sentiment + commercial-intent labels. Reuses the same Anthropic key and
// service-role Supabase client as /api/chat — nothing runs on the notebooks.
//
// Triggers:
//   GET  — the daily Vercel cron (guarded by CRON_SECRET).
//   POST — the "Classify replies" button on the Leads page. No secret:
//          the work is self-limiting (only unclassified/current-taxonomy backlog,
//          cheap Haiku), so repeated clicks are safe and converge to a no-op.
import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { db } from './_lib/core.js'

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
// sentiment batch was empty). Fills an inferred birth-year RANGE (pure arithmetic)
// and gender (Haiku) for leads never processed before. Best-effort; see runDemographics.
const GENDERS = ['male', 'female', 'unknown'] as const
const DEMO_BATCH = 100 // leads processed per invocation
const DEMO_GROUP = 25 // leads per gender model call
const BIRTH_YEAR_FLOOR = 1930 // sanity floor for a computed birth year

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
function renderReply(ref: number, reply: Reply, thread: Msg[]): string {
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

async function handle(req: Request): Promise<Response> {
  // Cron path is guarded; the manual POST path is intentionally open (see top).
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET
    if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
      return json({ error: 'unauthorized' }, 401)
    }
  }

  const sb = db()

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
  full_name: string | null
  headline: string | null
  education_start_year: number | null
  first_job_start_year: number | null
}

/** Deterministic birth-year RANGE from the two start-year signals — NO model.
 *  education start -> [start-19, start-18]; else first job -> [start-23, start-21];
 *  any bound outside [1930, currentYear-15] -> both null (garbage / implausible). */
function birthYearRange(
  edu: number | null,
  firstJob: number | null,
  currentYear: number
): { min: number | null; max: number | null } {
  let min: number | null = null
  let max: number | null = null
  if (edu != null) {
    min = edu - 19
    max = edu - 18
  } else if (firstJob != null) {
    min = firstJob - 23
    max = firstJob - 21
  }
  if (min == null || max == null) return { min: null, max: null }
  const ceil = currentYear - 15
  if (min < BIRTH_YEAR_FLOOR || max < BIRTH_YEAR_FLOOR || min > ceil || max > ceil) {
    return { min: null, max: null }
  }
  return { min, max }
}

/**
 * Demographics second phase: fill inferred birth-year range + gender for leads never
 * processed (demo_inferred_at IS NULL), oldest added first, capped at DEMO_BATCH.
 * Age is pure arithmetic; only gender uses the model (Haiku, groups of DEMO_GROUP).
 *
 * Idempotent + convergent: the demo_inferred_at IS NULL filter means re-runs and the
 * daily cron never re-touch processed rows, and manual overrides (demo_model='manual',
 * demo_inferred_at set) are never re-inferred. Leads with no name AND no year signal
 * are still stamped (gender 'unknown', confidence 0) so the job drains to a no-op.
 *
 * Best-effort: every failure is swallowed (returns 0 / the count so far) so a missing
 * migration 041 or a model outage never breaks the classify response. A group whose
 * model call throws still gets its deterministic age written, but its gender +
 * demo_inferred_at stay NULL so only gender retries next run.
 *
 * HARD NO-PHOTOS RULE: the select list is explicit TEXT columns only — never
 * photo_path, never `select *` — because photo data must not reach any model.
 */
async function runDemographics(sb: ReturnType<typeof db>): Promise<number> {
  let stamped = 0
  try {
    const { data, error } = await sb
      .from('leads')
      // Explicit text columns ONLY — no photo_path, no `select *` (no photos to models).
      .select('id,full_name,headline,education_start_year,first_job_start_year')
      .is('demo_inferred_at', null)
      .order('added_at', { ascending: true })
      .limit(DEMO_BATCH)
    if (error) {
      console.warn('demographics phase skipped:', error.message)
      return 0
    }
    const leads = (data ?? []) as DemoLead[]
    if (!leads.length) return 0

    const now = new Date().toISOString()
    const currentYear = new Date().getUTCFullYear()

    // Age range is independent of gender inference — compute it for every lead up front.
    const ages = new Map<string, { min: number | null; max: number | null }>()
    for (const l of leads) {
      ages.set(l.id, birthYearRange(l.education_start_year, l.first_job_start_year, currentYear))
    }

    // Full stamp for a fully-processed lead: age + gender + demo_inferred_at, so the
    // idempotency filter never picks it up again.
    const writeDemo = async (
      id: string,
      gender: (typeof GENDERS)[number],
      confidence: number
    ) => {
      const age = ages.get(id) ?? { min: null, max: null }
      const { error: upErr } = await sb
        .from('leads')
        .update({
          birth_year_min: age.min,
          birth_year_max: age.max,
          gender,
          gender_confidence: confidence,
          demo_inferred_at: now,
          demo_model: MODEL,
        })
        .eq('id', id)
      if (!upErr) stamped++
    }

    // Age-only write used when gender inference fails for a group: age is deterministic
    // and independent of gender (spec: "written regardless of what gender inference does"),
    // so persist it now but DELIBERATELY leave gender/demo_inferred_at NULL so the next
    // run retries gender. Skipped when there's no age signal (nothing to persist yet); a
    // retried lead just re-writes the same age (harmless — touch_updated_at no-ops it).
    const writeAgeOnly = async (id: string) => {
      const age = ages.get(id)
      if (!age || age.min == null) return
      await sb
        .from('leads')
        .update({ birth_year_min: age.min, birth_year_max: age.max })
        .eq('id', id)
    }

    // Leads with no usable name skip the model entirely — stamp 'unknown' directly.
    // NOTE: demo_model is set to MODEL ('claude-haiku-4-5') even though no model ran on
    // these — the convention is only 'manual' vs everything-else (an AI-provenance flag);
    // the frontend/set_gender path distinguishes those two, not the specific model id.
    const named: DemoLead[] = []
    const nameless: DemoLead[] = []
    for (const l of leads) {
      if (l.full_name && l.full_name.trim()) named.push(l)
      else nameless.push(l)
    }
    await Promise.all(nameless.map((l) => writeDemo(l.id, 'unknown', 0)))

    // Oldest-first + DEMO_BATCH cap means a group of 25 whose gender call
    // deterministically fails (e.g. a persistent model/content issue) sits at the front
    // of the window and can re-occupy a run's model budget until it succeeds — the same
    // accepted tradeoff as the sentiment classifier's oldest-first batch. Age is still
    // persisted for those leads each time, so only gender is delayed.
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
            results: z.array(
              z.object({
                ref: z.number().int(),
                gender: z.enum(GENDERS),
                confidence: z.number().min(0).max(1),
              })
            ),
          }),
          system: GENDER_SYSTEM,
          prompt,
        })
        results = object.results
      } catch (e) {
        // Model failure for this group: still persist the deterministic age, but leave
        // gender + demo_inferred_at NULL so gender retries next run.
        console.warn('gender inference failed for a group:', e)
        await Promise.all(group.map((l) => writeAgeOnly(l.id)))
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
          await writeDemo(lead.id, r.gender, confidence)
        })
      )
    }

    return stamped
  } catch (e) {
    console.warn('demographics phase threw:', e)
    return stamped
  }
}

export const GET = (req: Request) => handle(req)
export const POST = (req: Request) => handle(req)
