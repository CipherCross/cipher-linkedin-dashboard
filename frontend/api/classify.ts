// Reply classifier. Reads unclassified inbound replies from Supabase, sends
// each one (with its conversation thread for context) to Claude, and writes
// back a sentiment label + one-line reason. Reuses the same Anthropic key and
// service-role Supabase client as /api/chat — nothing runs on the notebooks.
//
// Triggers:
//   GET  — the daily Vercel cron (guarded by CRON_SECRET).
//   POST — the "Classify new replies" button on the Replies page. No secret:
//          the work is self-limiting (only sentiment IS NULL, capped batch,
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

const BATCH = 60 // max replies classified per invocation
const GROUP = 10 // replies per model call
const CTX_MSGS = 8 // thread messages of context per reply
const BODY_CAP = 600 // chars per message shown to the model

const SYSTEM = `You classify the latest inbound reply in a LinkedIn outreach
conversation into exactly one label. We sent the OUT messages; the lead sent the
IN messages. Judge only the reply marked ">>> REPLY TO CLASSIFY", using the
thread for context.

LABELS:
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

Give a terse reason (max ~12 words). Return exactly one result per reply, with
"ref" set to that reply's [reply N] number.`

interface Reply {
  id: number
  instance_id: string
  profile_url: string
  body: string | null
  sent_at: string
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
    .select('id,instance_id,profile_url,body,sent_at')
    .eq('direction', 'in')
    .is('sentiment', null)
    .not('body', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(BATCH)
  if (error) return json({ error: error.message }, 500)
  if (!replies?.length) return json({ classified: 0, remaining: 0 })

  // Pull conversation context for every lead in the batch in one query, then
  // group by (instance_id, profile_url). profile_url is near-unique, so the
  // .in() over-fetch is small and we filter to the exact pair client-side.
  const profiles = [...new Set(replies.map((r) => r.profile_url))]
  const { data: ctxRows } = await sb
    .from('messages')
    .select('instance_id,profile_url,direction,body,sent_at')
    .in('profile_url', profiles)
    .order('sent_at', { ascending: true })
  const threads = new Map<string, Msg[]>()
  for (const m of (ctxRows ?? []) as Msg[]) {
    const k = key(m.instance_id, m.profile_url)
    let arr = threads.get(k)
    if (!arr) threads.set(k, (arr = []))
    arr.push(m)
  }

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
            reason: z.string(),
          })
        ),
      }),
      system: SYSTEM,
      prompt,
    })

    await Promise.all(
      object.results.map(async (r) => {
        const reply = group[r.ref]
        if (!reply) return
        const { error: upErr } = await sb
          .from('messages')
          .update({
            sentiment: r.sentiment,
            reason: r.reason.slice(0, 300),
            classified_at: now,
            classified_model: MODEL,
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
    .is('sentiment', null)
    .not('body', 'is', null)

  return json({ classified, remaining: count ?? 0 })
}

export const GET = (req: Request) => handle(req)
export const POST = (req: Request) => handle(req)
