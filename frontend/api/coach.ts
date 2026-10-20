// Conversation coach. Reads one whole conversation and helps the SDR with the
// next message: a short read of the state of play, feedback on the messages the
// SDR wrote BY HAND (sequence messages are reviewed separately, on the Sequences
// side, and are never critiqued here), and 10–15 ready-to-send options for the
// next message to choose from. Results are cached per conversation in
// `conversation_coaching` and rolled up per account into `coaching_digest`.
//
// What produced each outbound message comes from the step attribution (ledger
// step 024): a body that matches a campaign step template was sent by the
// sequence. Issues are filtered server-side to quotes from hand-written
// messages, so a model that critiques a template anyway is overruled.
//
// Storage: the drafts live in the `tips` jsonb column (it held the old
// free-text "how to respond" pointers) — no schema change. Markers carry a
// `v2|` prefix, so a row cached in the old shape never matches and is
// regenerated on the next request.
//
// POST body:
//   { instance_id, profile_url }          → coach one conversation (Mode A)
//   { instance_id, profile_url, force }   → ignore the cache and recompute
//   { instance_id, mode: 'digest' }       → roll up recurring patterns (Mode B)
//
// Requires an active dashboard member. Mode A short-circuits on an unchanged
// thread (last_msg_marker); Mode B is bounded and manual.
//
// Every caller is a signed-in human, so the handler runs on the shared Neon
// runtime store under the caller's resolved actor. Data access sits behind the
// `CoachData` seam; the prompts, the model calls, the marker math and the
// response bodies live above it.
import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { AuthorizationError, authorizationResponse } from './_lib/auth.js'
import { unavailableResponse } from './_lib/data/availability.js'
import {
  DataStoreContractError,
  DataStoreSchemaError,
  MAX_PAGE_SIZE,
  type ActorContext,
  type DataStore,
  type DataStoreParams,
  type Page,
} from './_lib/data/contracts.js'
import {
  AI_WRITE_OPERATIONS,
  MESSAGES_OPERATIONS,
  type CoachIcpPersonaRow,
  type CoachThreadRow,
  type CoachingRow,
  type IcpDetailRow,
  type ThreadMessageRow,
} from './_lib/data/operations/index.js'
import { neonWriter, type NeonWriteDeps } from './_lib/neonWrites.js'

export const maxDuration = 300

const CONV_MODEL = 'claude-sonnet-5-5' // per-conversation coaching
const DIGEST_MODEL = 'claude-opus-5-5' // cross-conversation self-correction digest

const MAX_MSGS = 30 // most recent thread messages shown to the model
const BODY_CAP = 800 // chars per message
const DIGEST_BATCH = 25 // actionable threads back-filled before a digest
const MAX_IDEAS = 15
const MARKER_VERSION = 'v2'

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
  summary: z.string(),
  issues: z
    .array(
      z.object({
        kind: z.enum(ISSUE_KINDS),
        severity: z.enum(['low', 'med', 'high']),
        quote: z.string(), // exact snippet from a HAND-WRITTEN SDR message
        fix: z.string(), // how to do it better
      })
    )
    .max(4),
  ideas: z
    .array(
      z.object({
        angle: z.string(), // 2–5 word label for the approach
        message: z.string(), // the ready-to-send next message
        why: z.string(), // one line on when this option is the right pick
      })
    )
    .max(MAX_IDEAS),
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
You read one full conversation between the SDR and a prospect. PROSPECT lines are the prospect's;
SDR lines are the SDR's. The ONLY goal is to earn the next genuine reply and move toward a call —
never to close a sale in a single message.

Every SDR line is tagged with what produced it:
- [SEQUENCE …] — sent automatically by a campaign sequence step (a template). Sequences are reviewed
  and rewritten separately by the team. NEVER critique, quote or "fix" a SEQUENCE message. Use them only
  as context for what the prospect has already been told.
- [TEMPLATE] — the same text was sent in many other conversations (a sequence variant or a saved
  snippet). Treat it exactly like a SEQUENCE message.
- [HAND-WRITTEN] — typed by the SDR by hand. These, and only these, are what you give feedback on.
- [UNVERIFIED] — not yet matched against the templates. Treat it as hand-written only if it clearly
  reads like a personal reply to this prospect; if it reads like a template, leave it alone.

Return:
- summary: one or two sentences on the state of play and the path to a reply.
- next_action: the single best next move — reply, wait, book_call, refer, close, or none. Use "close"
  when the thread is dead or hostile and it makes sense to end it gracefully; "wait" when the ball is in
  the prospect's court and chasing now would hurt.
- issues: up to 4 concrete mistakes in the SDR's HAND-WRITTEN messages, each with the exact "quote" copied
  verbatim from a HAND-WRITTEN message and a short, specific "fix". Judge tone, length, relevance, whether
  a direct question was ignored, generic copy-paste, too many asks at once, pushiness, a missing/weak call
  to action, and slow follow-up. With no hand-written messages, or nothing genuinely wrong in them, return
  an empty array — never invent problems.
- ideas: ${MAX_IDEAS - 3} to ${MAX_IDEAS} distinct, ready-to-send options for the SDR's NEXT message, so they
  have a real choice. Each has a short "angle" label (2-5 words, e.g. "Answer + propose a slot",
  "Clarifying question", "Relevant case study", "Low-friction resource", "Graceful close"), the full
  "message", and a one-line "why" saying when this option is the right pick. Make them genuinely
  different — vary the approach (direct answer, question, insight, proof, call to action, soft nudge,
  rapport, graceful exit where it fits), the length (most under 300 characters, a few one-liners, at most
  two longer ones) and the ask. Order them best first. Every message must:
  * answer anything the prospect asked that is still open, before asking for anything;
  * be written in the language the prospect writes in (the conversation's language if the prospect
    has not written), in a natural first-person LinkedIn tone — no subject line, no signature;
  * never repeat what a sequence message already said;
  * never invent facts, prices, names or results: where a specific the SDR must supply is needed, mark
    it in square brackets, e.g. [price range], [case study client];
  * stay consistent with the playbook and the ICP below.
  When next_action is "wait", write the options as the follow-up to send later, and say so in "why".

Be specific to THIS thread.`

/** Who wrote an outbound message, as far as the step attribution knows.
 *  `template`: matched no synced step, but opens like messages sent in many
 *  other conversations — an unsynced template variant or a reused snippet. */
type OutboundOrigin = 'sequence' | 'template' | 'manual' | 'unverified'

/** Conversations an unmatched opening must recur in to count as a template. */
const TEMPLATE_REUSE_THREADS = 5

interface Msg {
  direction: string
  body: string | null
  sent_at: string
  source: string | null
  /** Read from LH2's chat store, which captures hand-typed messages too. */
  chat_store: boolean
  /** Outbound only. */
  origin: OutboundOrigin | null
  step_type: string | null
  message_ordinal: number | null
}

export function originOf(
  row: Pick<CoachThreadRow, 'direction' | 'step_method'> & Partial<Pick<CoachThreadRow, 'reused_threads'>>,
): OutboundOrigin | null {
  if (row.direction !== 'out') return null
  if (row.step_method === null) return 'unverified'
  if (row.step_method !== 'none') return 'sequence'
  return (row.reused_threads ?? 0) >= TEMPLATE_REUSE_THREADS ? 'template' : 'manual'
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Inject the global playbook (Markdown) + this conversation's ICP (if its campaign
 *  is assigned to a hypothesis) into the system prompt. Either piece is optional —
 *  the coach stays generic where one or both are unconfigured. */
function systemFor(playbook: string, icpText: string): string {
  let sys = SYSTEM_BASE
  sys += playbook
    ? `\n\nPLAYBOOK — ground every suggestion in this:\n${playbook}`
    : `\n\nNo playbook is configured — keep product claims generic and note in "summary" that ` +
      `writing a playbook (the dashboard's Playbook page) will sharpen the coaching.`
  if (icpText) sys += `\n\nICP — this conversation's target profile:\n${icpText}`
  return sys
}

function sdrTag(m: Msg): string {
  if (m.origin === 'sequence') {
    const step = m.step_type === 'InvitePerson'
      ? 'connection note'
      : m.message_ordinal ? `message ${m.message_ordinal}` : 'step'
    return `[SEQUENCE ${step}]`
  }
  if (m.origin === 'template') return '[TEMPLATE]'
  return m.origin === 'manual' ? '[HAND-WRITTEN]' : '[UNVERIFIED]'
}

export function renderThread(thread: Msg[]): string {
  const recent = thread.slice(-MAX_MSGS)
  const lines = recent.map((m) => {
    const who = m.direction === 'in' ? 'PROSPECT' : `SDR ${sdrTag(m)}`
    return `${who}: ${(m.body ?? '').slice(0, BODY_CAP)}`
  })
  // Agents before the chat-store sync could not see hand-typed SDR follow-ups;
  // those only appear once a thread is manually imported (source='manual').
  // On such a thread "who is waiting" can't be trusted. A chat-store row, or an
  // import, means hand-typed messages are captured.
  const complete = recent.some((m) => m.source === 'manual' || m.chat_store)
  const last = recent[recent.length - 1]
  let waiting: string
  if (last?.direction === 'in' && !complete) {
    waiting =
      'This thread may be INCOMPLETE: it was synced before hand-typed messages were captured, and has no ' +
      'imported history. The latest message being from the PROSPECT may simply mean the SDR replied by ' +
      'hand and it is not visible here — do NOT scold the SDR for "not replying" or "going slow", and never ' +
      'flag slow_followup. Mention in the summary that importing the thread history would confirm the state.'
  } else if (last?.direction === 'in') {
    waiting = 'The latest message is from the PROSPECT — they are waiting on the SDR to respond.'
  } else {
    waiting = 'The latest message is from the SDR — we are waiting on the prospect to reply.'
  }
  const handWritten = recent.filter((m) => m.origin === 'manual' || m.origin === 'unverified').length
  const scope = handWritten
    ? ''
    : '\nThe SDR has sent no hand-written messages in this thread, so "issues" must be empty.'
  return `${waiting}${scope}\n\nCONVERSATION (oldest first):\n${lines.join('\n')}`
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

/** Keep only issues that quote a hand-written (or not yet attributed) SDR
 *  message. The prompt already says so; this is what makes it true. */
export function issuesOnHandWritten<T extends { quote: string }>(issues: readonly T[], thread: readonly Msg[]): T[] {
  const bodies = thread
    .filter((m) => m.origin === 'manual' || m.origin === 'unverified')
    .map((m) => normalize(m.body ?? ''))
    .filter(Boolean)
  return issues.filter((issue) => {
    const quote = normalize(issue.quote.replace(/^["“'«]+|["”'»]+$/g, ''))
    return quote.length > 0 && bodies.some((body) => body.includes(quote))
  })
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
  return `${MARKER_VERSION}|${last?.sent_at ?? ''}|${thread.length}|${last?.body ? hashStr(last.body) : '0'}`
}

interface CoachScope {
  /** Outbound messages the coach reviewed (hand-written or not yet attributed). */
  readonly hand_written: number
  /** Outbound messages a sequence step or a reused template sent, which the coach skips. */
  readonly sequence: number
  /** The thread the take was generated against, for the client's staleness check. */
  readonly message_count: number
  readonly last_sent_at: string | null
}

function scopeOf(thread: readonly Msg[]): CoachScope {
  return {
    hand_written: thread.filter((m) => m.origin === 'manual' || m.origin === 'unverified').length,
    sequence: thread.filter((m) => m.origin === 'sequence' || m.origin === 'template').length,
    message_count: thread.length,
    last_sent_at: thread[thread.length - 1]?.sent_at ?? null,
  }
}

interface CoachIdea {
  angle: string
  message: string
  why: string
}

/** The drafts stored in `tips`; anything not in the v2 shape is dropped. */
function ideasFrom(value: readonly unknown[]): CoachIdea[] {
  return value.flatMap((item) => {
    const idea = item as Partial<CoachIdea> | null
    if (!idea || typeof idea !== 'object' || typeof idea.message !== 'string' || !idea.message.trim()) return []
    return [{
      angle: typeof idea.angle === 'string' ? idea.angle : '',
      message: idea.message,
      why: typeof idea.why === 'string' ? idea.why : '',
    }]
  })
}

// ---------------------------------------------------------------------------
// The data seam: the reads and writes the coaching flows need, and their Neon
// implementation.
// ---------------------------------------------------------------------------

interface ExistingCoaching {
  next_action: string | null
  issues: unknown[]
  tips: unknown[]
  summary: string | null
  last_msg_marker: string | null
  coached_at: string | null
  model: string | null
}

interface CoachingWrite {
  instance_id: string
  profile_url: string
  next_action: string
  issues: unknown[]
  tips: unknown[]
  summary: string
  last_msg_marker: string
  coached_at: string
  model: string
}

interface CoachData {
  loadThread(instance_id: string, profile_url: string): Promise<Msg[]>
  loadExisting(instance_id: string, profile_url: string): Promise<ExistingCoaching | null>
  saveCoaching(row: CoachingWrite): Promise<void>
  loadPlaybook(): Promise<string>
  loadIcpForCampaign(campaign_id: string | null | undefined): Promise<string>
  actionableProfiles(instance_id: string): Promise<string[]>
  loadIssues(instance_id: string): Promise<{ issues: unknown[] }[]>
  saveDigest(row: {
    instance_id: string
    summary: string
    patterns: unknown[]
    computed_at: string
    model: string
  }): Promise<void>
}

/** This conversation's ICP text. */
function renderIcpText(
  hypothesisName: string,
  icp: IcpDetailRow,
  personas: readonly CoachIcpPersonaRow[],
): string {
  const lines = [`ICP "${icp.name}" (hypothesis "${hypothesisName}")`]
  const context = [icp.main_product, icp.core_sphere, icp.secondary_sphere].filter(Boolean)
  if (context.length) lines.push(`Product/sphere: ${context.join(' — ')}`)
  if (icp.purchase_triggers?.length) lines.push(`Why they buy: ${icp.purchase_triggers.join('; ')}`)
  for (const p of personas) {
    const titles = p.job_titles?.length ? p.job_titles.slice(0, 6).join(', ') : ''
    lines.push(`Buyer persona (${p.kind}): ${titles}${p.background ? ` — ${p.background}` : ''}`)
  }
  return lines.join('\n')
}

/** The Neon implementation: the shared runtime store under the caller's
 *  resolved actor. Reads and writes both run actor-scoped — the coach has a
 *  human, so it needs none of the blocked system path. */
function neonCoachData(store: DataStore, actor: ActorContext): CoachData {
  async function allPages<TRow>(operation: string, params: DataStoreParams): Promise<TRow[]> {
    const rows: TRow[] = []
    let cursor: string | null = null
    for (;;) {
      const page: Page<TRow> = await store.query<TRow>(actor, {
        operation,
        params,
        page: { limit: MAX_PAGE_SIZE, cursor },
      })
      rows.push(...page.items)
      if (!page.hasMore || page.nextCursor === null) break
      cursor = page.nextCursor
    }
    return rows
  }

  return {
    async loadThread(instance_id, profile_url) {
      const params = { instanceId: instance_id, profileUrl: profile_url }
      try {
        const rows = await allPages<CoachThreadRow>(AI_WRITE_OPERATIONS.coachThread, params)
        return rows.map((m) => ({
          direction: m.direction,
          body: m.body,
          sent_at: m.sent_at,
          source: m.source,
          chat_store: m.chat_store,
          origin: originOf(m),
          step_type: m.step_type,
          message_ordinal: m.message_ordinal,
        }))
      } catch (error) {
        // A tenant that predates ledger step 024 has no attribution table:
        // coach it with every outbound message unverified rather than not at all.
        if (!(error instanceof DataStoreSchemaError)) throw error
      }
      const rows = await allPages<ThreadMessageRow>(MESSAGES_OPERATIONS.thread, params)
      return rows.map((m) => ({
        direction: m.direction,
        body: m.body,
        sent_at: m.sent_at,
        source: m.source,
        chat_store: false,
        origin: m.direction === 'out' ? 'unverified' as const : null,
        step_type: null,
        message_ordinal: null,
      }))
    },
    async loadExisting(instance_id, profile_url) {
      const page = await store.query<CoachingRow>(actor, {
        operation: AI_WRITE_OPERATIONS.coachExisting,
        params: { instanceId: instance_id, profileUrl: profile_url },
        page: { limit: 1 },
      })
      return page.items[0] ?? null
    },
    async saveCoaching(row) {
      await store.transaction(actor, async (transaction) => {
        await transaction.execute({
          operation: AI_WRITE_OPERATIONS.coachUpsert,
          params: {
            instanceId: row.instance_id,
            profileUrl: row.profile_url,
            nextAction: row.next_action,
            issues: JSON.stringify(row.issues),
            tips: JSON.stringify(row.tips),
            summary: row.summary,
            lastMsgMarker: row.last_msg_marker,
            coachedAt: row.coached_at,
            model: row.model,
          },
        })
      })
    },
    async loadPlaybook() {
      const page = await store.query<{ content: string }>(actor, {
        operation: AI_WRITE_OPERATIONS.coachPlaybook,
        page: { limit: 1 },
      })
      return (page.items[0]?.content ?? '').trim()
    },
    async loadIcpForCampaign(campaign_id) {
      if (!campaign_id) return ''
      const assignment = await store.query<{ hypothesis_id: number }>(actor, {
        operation: AI_WRITE_OPERATIONS.coachHypothesisAssignment,
        params: { campaignId: campaign_id },
        page: { limit: 1 },
      })
      const hypothesisId = assignment.items[0]?.hypothesis_id
      if (hypothesisId === undefined) return ''

      const hypPage = await store.query<{ name: string; icp_id: number | null }>(actor, {
        operation: AI_WRITE_OPERATIONS.coachHypothesisIcp,
        params: { hypothesisId },
        page: { limit: 1 },
      })
      const hyp = hypPage.items[0]
      if (!hyp?.icp_id) return ''

      const [icpPage, personasPage] = await Promise.all([
        store.query<IcpDetailRow>(actor, {
          operation: AI_WRITE_OPERATIONS.coachIcpDetail,
          params: { icpId: hyp.icp_id },
          page: { limit: 1 },
        }),
        store.query<CoachIcpPersonaRow>(actor, {
          operation: AI_WRITE_OPERATIONS.coachIcpPersonas,
          params: { icpId: hyp.icp_id },
          page: { limit: MAX_PAGE_SIZE },
        }),
      ])
      const icp = icpPage.items[0]
      if (!icp) return ''
      return renderIcpText(hyp.name, icp, personasPage.items)
    },
    async actionableProfiles(instance_id) {
      // Newest-first walk, keep each profile's first (newest) direction, keep
      // the inbound ones.
      const rows = await allPages<{ profile_url: string; direction: string }>(
        AI_WRITE_OPERATIONS.coachActionableProfiles,
        { instanceId: instance_id },
      )
      const latestDir = new Map<string, string>()
      for (const m of rows) {
        if (!latestDir.has(m.profile_url)) latestDir.set(m.profile_url, m.direction)
      }
      return [...latestDir.entries()].filter(([, d]) => d === 'in').map(([p]) => p)
    },
    async loadIssues(instance_id) {
      return allPages<{ issues: unknown[] }>(AI_WRITE_OPERATIONS.coachIssuesByInstance, {
        instanceId: instance_id,
      })
    },
    async saveDigest(row) {
      await store.transaction(actor, async (transaction) => {
        await transaction.execute({
          operation: AI_WRITE_OPERATIONS.coachDigestUpsert,
          params: {
            instanceId: row.instance_id,
            summary: row.summary,
            patterns: JSON.stringify(row.patterns),
            computedAt: row.computed_at,
            model: row.model,
          },
        })
      })
    },
  }
}

// ---------------------------------------------------------------------------
// The coaching flows, over the seam.
// ---------------------------------------------------------------------------

interface CoachingOut {
  next_action: string
  issues: unknown[]
  ideas: CoachIdea[]
  summary: string | null
  last_msg_marker: string | null
  coached_at: string | null
  model: string | null
  cached: boolean
  scope: CoachScope
}

/** Coach one conversation. Serves a cached row when the thread is unchanged
 *  (unless force), otherwise calls the model and upserts. Returns null for an
 *  empty thread. */
async function coachConversation(
  data: CoachData,
  instance_id: string,
  profile_url: string,
  playbook: string,
  force: boolean,
  campaign_id?: string | null,
): Promise<CoachingOut | null> {
  const thread = await data.loadThread(instance_id, profile_url)
  if (!thread.length) return null
  const marker = markerOf(thread)
  const scope = scopeOf(thread)

  if (!force) {
    const existing = await data.loadExisting(instance_id, profile_url)
    if (existing && existing.last_msg_marker === marker) {
      return {
        next_action: existing.next_action ?? 'none',
        issues: existing.issues,
        ideas: ideasFrom(existing.tips),
        summary: existing.summary,
        last_msg_marker: existing.last_msg_marker,
        coached_at: existing.coached_at,
        model: existing.model,
        cached: true,
        scope,
      }
    }
  }

  const icpText = await data.loadIcpForCampaign(campaign_id)
  const { object } = await generateObject({
    model: anthropic(CONV_MODEL),
    schema: convSchema,
    system: systemFor(playbook, icpText),
    prompt: renderThread(thread),
    providerOptions: { anthropic: { effort: 'low' } },
  })

  const ideas = ideasFrom(object.ideas).slice(0, MAX_IDEAS)
  const issues = issuesOnHandWritten(object.issues, thread)
  const now = new Date().toISOString()
  const row = {
    instance_id,
    profile_url,
    next_action: object.next_action,
    issues,
    tips: ideas,
    summary: object.summary.slice(0, 1000),
    last_msg_marker: marker,
    coached_at: now,
    model: CONV_MODEL,
  }
  await data.saveCoaching(row)
  return {
    next_action: row.next_action,
    issues,
    ideas,
    summary: row.summary,
    last_msg_marker: marker,
    coached_at: now,
    model: CONV_MODEL,
    cached: false,
    scope,
  }
}

async function digest(data: CoachData, instance_id: string): Promise<Response> {
  const playbook = await data.loadPlaybook()

  // Back-fill coaching for actionable threads so the first digest has coverage.
  const profiles = (await data.actionableProfiles(instance_id)).slice(0, DIGEST_BATCH)
  for (const profile_url of profiles) {
    try {
      await coachConversation(data, instance_id, profile_url, playbook, false)
    } catch {
      // One bad thread shouldn't sink the digest — skip and continue.
    }
  }

  // Aggregate every issue we've stored for this account.
  const rows = await data.loadIssues(instance_id)
  const kindCounts = new Map<string, number>()
  const fixes: string[] = []
  let convCount = 0
  for (const r of rows) {
    const issues = Array.isArray(r.issues) ? r.issues : []
    if (issues.length) convCount++
    for (const i of issues as { kind?: string; fix?: string }[]) {
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
    await data.saveDigest({ instance_id, ...empty, computed_at: now, model: DIGEST_MODEL })
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

  await data.saveDigest({
    instance_id,
    summary: object.summary,
    patterns: object.patterns,
    computed_at: now,
    model: DIGEST_MODEL,
  })
  return json({ ...object, computed_at: now, coached_threads: profiles.length })
}

/** Log a failure by class, never by message — the driver composes connection
 *  failures with the database hostname, and no driver text may reach a log. */
function safeErrorLabel(error: unknown): string {
  if (error instanceof DataStoreContractError) return `${error.name}(${error.code})`
  if (error instanceof Error) return error.name
  return 'UnknownError'
}

/** Resolve the actor against the database being written — the only place the
 *  membership can be checked without a race, the same argument `neonWrites.ts`
 *  makes — then coach. */
async function coachOnNeon(
  req: Request,
  body: {
    instance_id: string
    profile_url?: unknown
    mode?: unknown
    force?: unknown
    campaign_id?: unknown
  },
  deps: NeonWriteDeps = {},
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
    console.error('Neon coach failed (verify team access):', safeErrorLabel(error))
    return json({ error: 'Could not verify team access' }, 500)
  }

  const data = neonCoachData(writer.store, writer.actor)
  try {
    if (body.mode === 'digest') {
      return await digest(data, body.instance_id)
    }
    const profile_url = body.profile_url
    if (typeof profile_url !== 'string' || !profile_url) {
      return json({ error: 'profile_url (string) is required' }, 400)
    }
    const campaign_id = typeof body.campaign_id === 'string' ? body.campaign_id : null
    const playbook = await data.loadPlaybook()
    const out = await coachConversation(
      data,
      body.instance_id,
      profile_url,
      playbook,
      body.force === true,
      campaign_id,
    )
    if (!out) return json({ error: 'no messages in this conversation' }, 404)
    return json(out)
  } catch (error) {
    const denial = authorizationResponse(error)
    if (denial) return denial
    if (error instanceof AuthorizationError) return authorizationResponse(error) ?? json({ error: 'Unauthorized' }, error.status)
    console.error('Neon coach failed:', safeErrorLabel(error))
    return json({ error: 'Coaching failed — check server logs.' }, 500)
  }
}

async function handle(req: Request, deps: NeonWriteDeps = {}): Promise<Response> {
  let body: {
    instance_id?: unknown
    profile_url?: unknown
    mode?: unknown
    force?: unknown
    campaign_id?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const instance_id = body.instance_id
  if (typeof instance_id !== 'string' || !instance_id) {
    return json({ error: 'instance_id (string) is required' }, 400)
  }

  return coachOnNeon(req, { ...body, instance_id }, deps)
}

export const POST = (req: Request) => handle(req)
