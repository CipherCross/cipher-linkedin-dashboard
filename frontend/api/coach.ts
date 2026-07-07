// Conversation coach. A layer on top of the reply classifier (/api/classify):
// instead of labelling the latest inbound reply, it reads the whole negotiation
// and coaches the SDR — flags what they did wrong in their OWN messages, how to
// respond now (guidance, never a ghost-written message), and the best next action.
// Results are cached per conversation in `conversation_coaching` and rolled up per
// account into `coaching_digest`. Reuses the same Anthropic key + service-role
// Supabase client as /api/classify and /api/chat; nothing runs on the notebooks.
//
// POST body:
//   { instance_id, profile_url }          → coach one conversation (Mode A)
//   { instance_id, profile_url, force }   → ignore the cache and recompute
//   { instance_id, mode: 'digest' }       → roll up recurring patterns (Mode B)
//
// No secret: the work is self-limiting — Mode A short-circuits on an unchanged
// thread (last_msg_marker), Mode B is bounded and manual — so it's safe to leave
// open like /api/classify.
import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { db } from './_lib/core.js'

export const maxDuration = 300

const CONV_MODEL = 'claude-sonnet-4-6' // per-conversation coaching
const DIGEST_MODEL = 'claude-opus-4-8' // cross-conversation self-correction digest

const MAX_MSGS = 30 // most recent thread messages shown to the model
const BODY_CAP = 800 // chars per message
const DIGEST_BATCH = 25 // actionable threads back-filled before a digest

const NEXT_ACTIONS = ['reply', 'wait', 'book_call', 'refer', 'close', 'none'] as const
const ISSUE_KINDS = [
  'ignored_question',
  'too_long',
  'too_salesy',
  'generic',
  'slow_followup',
  'no_cta',
  'multiple_asks',
  'pushy',
  'other',
] as const

const convSchema = z.object({
  next_action: z.enum(NEXT_ACTIONS),
  issues: z
    .array(
      z.object({
        kind: z.enum(ISSUE_KINDS),
        severity: z.enum(['low', 'med', 'high']),
        quote: z.string(), // the SDR's own outbound snippet that was the problem
        fix: z.string(), // how to do it better
      })
    )
    .max(4),
  tips: z.array(z.string()).max(4), // how to respond *now* — direction, not the message
  summary: z.string(),
})

const digestSchema = z.object({
  summary: z.string(),
  patterns: z
    .array(
      z.object({
        issue: z.string(),
        count: z.number().int(),
        advice: z.string(),
      })
    )
    .max(6),
})

const SYSTEM_BASE = `You are an elite LinkedIn outreach coach for an SDR (sales development rep).
You read one full conversation between the SDR and a prospect. The SDR sent the SDR messages;
the prospect sent the PROSPECT messages. The ONLY goal is to earn the next genuine reply and move
toward a call — never to close a sale in a single message.

Coach the SDR; do NOT write their message for them. Return:
- issues: up to 4 concrete mistakes in the SDR's OWN messages, each with the exact "quote" from an
  SDR message and a short, specific "fix". Judge tone, length, relevance, whether a direct question
  was ignored, generic copy-paste, too many asks at once, pushiness, a missing/weak call to action,
  and slow follow-up. If there is genuinely nothing to flag, return an empty array — do not invent
  problems.
- tips: up to 4 short, imperative pointers on how to respond RIGHT NOW to earn a reply. Give
  direction, NOT the literal message (e.g. "Answer the pricing question in one line, then ask for
  15 minutes Thursday" — never a full drafted message).
- next_action: the single best next move — reply, wait, book_call, refer, close, or none. Use
  "close" when the thread is dead or hostile and it makes sense to end it gracefully; "wait" when
  the ball is in the prospect's court and chasing now would hurt.
- summary: one or two sentences on the state of play and the path to a reply.

Be specific to THIS thread.

MANUAL-REPLY BLIND SPOT: the auto-sync captures only the scripted funnel (invite → first templated
message → the inbound reply). Outbound messages the SDR types by HAND after a reply are captured ONLY
once the thread is manually imported (tagged [imported] above). So on a SYNC-ONLY thread, later SDR
follow-ups may be missing from what you see — NEVER scold the SDR for "not replying", "going slow", or
"ignoring" a prospect, and never make slow_followup the issue, when the thread has no imported messages.
In that case the only safe next step is to import the thread's full history so the real exchange becomes
visible; say so in tips/summary instead of assuming a lapse.`

interface Msg {
  direction: string
  body: string | null
  sent_at: string
  source: string | null
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

type Sb = ReturnType<typeof db>

/** Inject the global playbook (Markdown) into the system prompt, or note its
 *  absence so the coach stays generic until one is written. */
function systemFor(playbook: string): string {
  if (!playbook) {
    return (
      SYSTEM_BASE +
      `\n\nNo playbook is configured — keep product claims generic and note in "summary" that ` +
      `writing a playbook (the dashboard's Playbook page) will sharpen the coaching.`
    )
  }
  return SYSTEM_BASE + `\n\nPLAYBOOK — ground every suggestion in this:\n` + playbook
}

function renderThread(thread: Msg[]): string {
  const recent = thread.slice(-MAX_MSGS)
  const lines = recent.map((m) => {
    const who = m.direction === 'in' ? 'PROSPECT' : 'SDR'
    const tag = m.source === 'manual' ? ' [imported]' : ''
    return `${who}${tag}: ${(m.body ?? '').slice(0, BODY_CAP)}`
  })
  // The LH2 agent can't see hand-typed SDR follow-ups; those only appear once a
  // thread is manually imported (source='manual'). A sync-only thread may be
  // MISSING later SDR messages that were actually sent — so "who is waiting" can't
  // be trusted on it. Only trust the last-message direction when at least one
  // message was manually imported.
  const hasManual = recent.some((m) => m.source === 'manual')
  const last = recent[recent.length - 1]
  let waiting: string
  if (last?.direction === 'in' && !hasManual) {
    waiting =
      'This thread is SYNC-ONLY (no manually imported messages), so any hand-typed SDR follow-up ' +
      'after the prospect replied is NOT captured here. The latest message being from the PROSPECT ' +
      'may simply mean the SDR replied by hand and the thread has not been re-imported — do NOT assume ' +
      'the SDR ignored them. If the thread genuinely stops at the prospect, the right move is to import ' +
      'its full history (dashboard "Import history") so the real state is visible.'
  } else if (last?.direction === 'in') {
    waiting = 'The latest message is from the PROSPECT — they are waiting on the SDR to respond.'
  } else {
    waiting = 'The latest message is from the SDR — we are waiting on the prospect to reply.'
  }
  return `${waiting}\n\nCONVERSATION (oldest first; [imported] = manually imported, others are auto-synced):\n${lines.join('\n')}`
}

async function loadThread(sb: Sb, instance_id: string, profile_url: string): Promise<Msg[]> {
  const { data } = await sb
    .from('messages')
    .select('direction,body,sent_at,source')
    .eq('instance_id', instance_id)
    .eq('profile_url', profile_url)
    .order('sent_at', { ascending: true })
  return (data ?? []) as Msg[]
}

/** The single global playbook (Markdown), trimmed; '' when unwritten. Shared by
 *  every account's coaching — see migration 022_playbook. */
async function loadPlaybook(sb: Sb): Promise<string> {
  const { data } = await sb.from('playbook').select('content').maybeSingle()
  return ((data?.content as string | undefined) ?? '').trim()
}

/** djb2 hash of a string → short hex, so the staleness marker also changes when the
 *  last message's BODY changes (not just its timestamp/count). */
function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const markerOf = (thread: Msg[]) => {
  const last = thread[thread.length - 1]
  return `${last?.sent_at ?? ''}|${thread.length}|${last?.body ? hashStr(last.body) : '0'}`
}

interface CoachingOut {
  next_action: string
  issues: unknown[]
  tips: unknown[]
  summary: string | null
  last_msg_marker: string | null
  coached_at: string | null
  model: string | null
  cached: boolean
}

/** Coach one conversation. Serves a cached row when the thread is unchanged
 *  (unless force), otherwise calls the model and upserts. Returns null for an
 *  empty thread. */
async function coachConversation(
  sb: Sb,
  instance_id: string,
  profile_url: string,
  playbook: string,
  force: boolean
): Promise<CoachingOut | null> {
  const thread = await loadThread(sb, instance_id, profile_url)
  if (!thread.length) return null
  const marker = markerOf(thread)

  if (!force) {
    const { data: existing } = await sb
      .from('conversation_coaching')
      .select('next_action,issues,tips,summary,last_msg_marker,coached_at,model')
      .eq('instance_id', instance_id)
      .eq('profile_url', profile_url)
      .maybeSingle()
    if (existing && existing.last_msg_marker === marker) {
      return { ...(existing as Omit<CoachingOut, 'cached'>), cached: true }
    }
  }

  const { object } = await generateObject({
    model: anthropic(CONV_MODEL),
    schema: convSchema,
    system: systemFor(playbook),
    prompt: renderThread(thread),
  })

  const now = new Date().toISOString()
  const row = {
    instance_id,
    profile_url,
    next_action: object.next_action,
    issues: object.issues,
    tips: object.tips,
    summary: object.summary.slice(0, 1000),
    last_msg_marker: marker,
    coached_at: now,
    model: CONV_MODEL,
  }
  await sb.from('conversation_coaching').upsert(row, { onConflict: 'instance_id,profile_url' })
  return { ...row, cached: false }
}

/** Profiles whose newest message is inbound — the prospect is waiting on us.
 *  Paginated so a busy account beyond ~5000 messages isn't silently truncated
 *  (which would drop actionable threads from the digest). */
async function actionableProfiles(sb: Sb, instance_id: string): Promise<string[]> {
  const PAGE = 1000
  const latestDir = new Map<string, string>()
  for (let from = 0; ; from += PAGE) {
    const { data } = await sb
      .from('messages')
      .select('profile_url,direction,sent_at')
      .eq('instance_id', instance_id)
      .order('sent_at', { ascending: false })
      .range(from, from + PAGE - 1)
    const rows = (data ?? []) as { profile_url: string; direction: string }[]
    for (const m of rows) {
      if (!latestDir.has(m.profile_url)) latestDir.set(m.profile_url, m.direction)
    }
    if (rows.length < PAGE) break
  }
  return [...latestDir.entries()].filter(([, d]) => d === 'in').map(([p]) => p)
}

async function digest(sb: Sb, instance_id: string): Promise<Response> {
  const playbook = await loadPlaybook(sb)

  // Back-fill coaching for actionable threads so the first digest has coverage.
  const profiles = (await actionableProfiles(sb, instance_id)).slice(0, DIGEST_BATCH)
  for (const profile_url of profiles) {
    try {
      await coachConversation(sb, instance_id, profile_url, playbook, false)
    } catch {
      // One bad thread shouldn't sink the digest — skip and continue.
    }
  }

  // Aggregate every issue we've stored for this account.
  const { data: rows } = await sb
    .from('conversation_coaching')
    .select('issues')
    .eq('instance_id', instance_id)
  const kindCounts = new Map<string, number>()
  const fixes: string[] = []
  let convCount = 0
  for (const r of (rows ?? []) as { issues: { kind?: string; fix?: string }[] }[]) {
    const issues = Array.isArray(r.issues) ? r.issues : []
    if (issues.length) convCount++
    for (const i of issues) {
      if (i.kind) kindCounts.set(i.kind, (kindCounts.get(i.kind) ?? 0) + 1)
      if (i.fix && fixes.length < 12) fixes.push(i.fix)
    }
  }

  const now = new Date().toISOString()
  if (kindCounts.size === 0) {
    const empty = {
      summary:
        'No coaching issues yet. Open a few replied conversations (or click Refresh again) to ' +
        'build up enough data for a self-correction digest.',
      patterns: [] as unknown[],
    }
    await sb
      .from('coaching_digest')
      .upsert(
        { instance_id, ...empty, computed_at: now, model: DIGEST_MODEL },
        { onConflict: 'instance_id' }
      )
    return json({ ...empty, computed_at: now, coached_threads: profiles.length })
  }

  const freqLines = [...kindCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, c]) => `${k} × ${c}`)
    .join('\n')

  const { object } = await generateObject({
    model: anthropic(DIGEST_MODEL),
    schema: digestSchema,
    system:
      `You are a sales coach producing a self-correction digest for ONE SDR, built from issues ` +
      `found across many of their LinkedIn conversations. Identify the RECURRING patterns that most ` +
      `hurt their reply rate. For each pattern give a plain-language "issue" name, the "count" of ` +
      `conversations it appeared in (use the provided frequencies — never inflate), and concrete ` +
      `"advice" on what to do instead. Order by impact. Write a 1-3 sentence "summary" that ` +
      `prioritizes the top fix. Be specific; avoid generic platitudes.`,
    prompt:
      `This SDR has ${convCount} coached conversations with issues.\n\n` +
      `Issue frequencies (kind × number of conversations):\n${freqLines}\n\n` +
      `Representative fixes already suggested per conversation:\n- ${fixes.join('\n- ')}`,
  })

  await sb
    .from('coaching_digest')
    .upsert(
      { instance_id, summary: object.summary, patterns: object.patterns, computed_at: now, model: DIGEST_MODEL },
      { onConflict: 'instance_id' }
    )
  return json({ ...object, computed_at: now, coached_threads: profiles.length })
}

async function handle(req: Request): Promise<Response> {
  let body: { instance_id?: unknown; profile_url?: unknown; mode?: unknown; force?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const instance_id = body.instance_id
  if (typeof instance_id !== 'string' || !instance_id) {
    return json({ error: 'instance_id (string) is required' }, 400)
  }

  const sb = db()

  if (body.mode === 'digest') {
    return digest(sb, instance_id)
  }

  const profile_url = body.profile_url
  if (typeof profile_url !== 'string' || !profile_url) {
    return json({ error: 'profile_url (string) is required' }, 400)
  }

  const playbook = await loadPlaybook(sb)
  const out = await coachConversation(sb, instance_id, profile_url, playbook, body.force === true)
  if (!out) return json({ error: 'no messages in this conversation' }, 404)
  return json(out)
}

export const POST = (req: Request) => handle(req)
