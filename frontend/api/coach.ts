// Conversation coach. A layer on top of the reply classifier (/api/classify):
// instead of labelling the latest inbound reply, it reads the whole negotiation
// and coaches the SDR — flags what they did wrong in their OWN messages, how to
// respond now (guidance, never a ghost-written message), and the best next action.
// Results are cached per conversation in `conversation_coaching` and rolled up per
// account into `coaching_digest`. Reuses the same Anthropic key as /api/classify
// and /api/chat; nothing runs on the notebooks.
//
// POST body:
//   { instance_id, profile_url }          → coach one conversation (Mode A)
//   { instance_id, profile_url, force }   → ignore the cache and recompute
//   { instance_id, mode: 'digest' }       → roll up recurring patterns (Mode B)
//
// Requires an active dashboard member. Mode A short-circuits on an unchanged
// thread (last_msg_marker); Mode B is bounded and manual.
//
// ## The provider split
//
// Every caller is a signed-in human, so this whole handler is portable — the
// AI path's blocked half is cron, and the coach has none. `deploymentAiPath()`
// chooses the data layer once per request: the Supabase service-role client,
// or the shared Neon runtime store under the caller's resolved actor. The two
// implementations share everything above data access — the prompts, the model
// calls, the marker math, the response bodies — through the `CoachData` seam.
import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { db } from './_lib/core.js'
import { guardMember, AuthorizationError, authorizationResponse } from './_lib/auth.js'
import { deploymentAiPath } from './_lib/data/aiPath.js'
import {
  DataStoreContractError,
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
  type CoachingRow,
  type IcpDetailRow,
  type ThreadMessageRow,
} from './_lib/data/operations/index.js'
import { neonWriter, type NeonWriteDeps } from './_lib/neonWrites.js'

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

// ---------------------------------------------------------------------------
// The data seam. Everything above is provider-neutral; everything below it is
// one of two implementations of the same reads and writes.
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

/** This conversation's ICP text, from rows both providers return in the same
 *  shape. Shared by both implementations. */
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

/** The Supabase implementation: the service-role client, exactly as before the
 *  provider split. */
function supabaseCoachData(sb: Sb): CoachData {
  return {
    async loadThread(instance_id, profile_url) {
      const { data } = await sb
        .from('messages')
        .select('direction,body,sent_at,source')
        .eq('instance_id', instance_id)
        .eq('profile_url', profile_url)
        .order('sent_at', { ascending: true })
      return (data ?? []) as Msg[]
    },
    async loadExisting(instance_id, profile_url) {
      const { data } = await sb
        .from('conversation_coaching')
        .select('next_action,issues,tips,summary,last_msg_marker,coached_at,model')
        .eq('instance_id', instance_id)
        .eq('profile_url', profile_url)
        .maybeSingle()
      return (data as ExistingCoaching | null) ?? null
    },
    async saveCoaching(row) {
      await sb.from('conversation_coaching').upsert(row, { onConflict: 'instance_id,profile_url' })
    },
    async loadPlaybook() {
      const { data } = await sb.from('playbook').select('content').maybeSingle()
      return ((data?.content as string | undefined) ?? '').trim()
    },
    /** This conversation's ICP, resolved campaign -> hypothesis -> ICP (migration 043).
     *  Returns '' when the campaign isn't assigned to a hypothesis, the hypothesis has no
     *  ICP, or campaign_id wasn't provided — coaching stays generic in all those cases.
     *  Compact by design (personas + purchase triggers, not the full keyword lists —
     *  those are sourcing-recipe data, not coaching-relevant). */
    async loadIcpForCampaign(campaign_id) {
      if (!campaign_id) return ''
      const { data: hc } = await sb
        .from('hypothesis_campaigns')
        .select('hypothesis_id')
        .eq('campaign_id', campaign_id)
        .maybeSingle()
      if (!hc) return ''

      const { data: hyp } = await sb
        .from('hypotheses')
        .select('name,icp_id')
        .eq('id', (hc as { hypothesis_id: number }).hypothesis_id)
        .maybeSingle()
      const icpId = (hyp as { name: string; icp_id: number | null } | null)?.icp_id
      if (!icpId) return ''

      const [{ data: icp }, { data: personas }] = await Promise.all([
        sb
          .from('icps')
          .select('name,main_product,core_sphere,secondary_sphere,purchase_triggers')
          .eq('id', icpId)
          .maybeSingle(),
        sb
          .from('icp_personas')
          .select('kind,job_titles,background')
          .eq('icp_id', icpId)
          .order('sort'),
      ])
      if (!icp) return ''
      const i = icp as {
        name: string
        main_product: string | null
        core_sphere: string | null
        secondary_sphere: string | null
        purchase_triggers: string[] | null
      }
      return renderIcpText((hyp as { name: string }).name, i, (personas ?? []) as CoachIcpPersonaRow[])
    },
    /** Profiles whose newest message is inbound — the prospect is waiting on us.
     *  Paginated so a busy account beyond ~5000 messages isn't silently truncated
     *  (which would drop actionable threads from the digest). */
    async actionableProfiles(instance_id) {
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
    },
    async loadIssues(instance_id) {
      const { data } = await sb
        .from('conversation_coaching')
        .select('issues')
        .eq('instance_id', instance_id)
      return ((data ?? []) as { issues: unknown[] }[]).map((r) => ({
        issues: Array.isArray(r.issues) ? r.issues : [],
      }))
    },
    async saveDigest(row) {
      await sb
        .from('coaching_digest')
        .upsert(row, { onConflict: 'instance_id' })
    },
  }
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
      const rows = await allPages<ThreadMessageRow>(MESSAGES_OPERATIONS.thread, {
        instanceId: instance_id,
        profileUrl: profile_url,
      })
      return rows.map((m) => ({
        direction: m.direction,
        body: m.body,
        sent_at: m.sent_at,
        source: m.source,
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
      // Same computation as the Supabase path: newest-first walk, keep each
      // profile's first (newest) direction, keep the inbound ones.
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
// The coaching flows, provider-neutral over the seam.
// ---------------------------------------------------------------------------

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

  if (!force) {
    const existing = await data.loadExisting(instance_id, profile_url)
    if (existing && existing.last_msg_marker === marker) {
      return { ...(existing as Omit<CoachingOut, 'cached'>), cached: true }
    }
  }

  const icpText = await data.loadIcpForCampaign(campaign_id)
  const { object } = await generateObject({
    model: anthropic(CONV_MODEL),
    schema: convSchema,
    system: systemFor(playbook, icpText),
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
  await data.saveCoaching(row)
  return { ...row, cached: false }
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

/** The Neon branch of this handler. The endpoint's `guardMember` already
 *  authenticated against Supabase; the actor is resolved AGAINST NEON, because
 *  the database being written is the only place the membership can be checked
 *  without a race — the same argument `neonWrites.ts` makes. */
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
  const auth = await guardMember(req)
  if (auth.response) return auth.response

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

  // The provider decision, taken once per request. The AI path flag moves the
  // whole handler: every call here has a human actor, so none of it is blocked
  // on the system write path.
  if (deploymentAiPath() === 'neon') {
    return coachOnNeon(req, { ...body, instance_id }, deps)
  }

  const sb = db()
  const data = supabaseCoachData(sb)

  if (body.mode === 'digest') {
    return digest(data, instance_id)
  }

  const profile_url = body.profile_url
  if (typeof profile_url !== 'string' || !profile_url) {
    return json({ error: 'profile_url (string) is required' }, 400)
  }
  // Optional: this lead's campaign, so coaching can be grounded in its ICP (if the
  // campaign is assigned to a hypothesis) — see loadIcpForCampaign.
  const campaign_id = typeof body.campaign_id === 'string' ? body.campaign_id : null

  const playbook = await data.loadPlaybook()
  const out = await coachConversation(data, instance_id, profile_url, playbook, body.force === true, campaign_id)
  if (!out) return json({ error: 'no messages in this conversation' }, 404)
  return json(out)
}

export const POST = (req: Request) => handle(req)
