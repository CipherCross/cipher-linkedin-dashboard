// Conversation coach. Reads one whole conversation and helps the SDR with the
// next message: a short read of the state of play, feedback on the messages the
// SDR wrote BY HAND (sequence messages are reviewed separately, on the Sequences
// side, and are never critiqued here), and 10–15 ready-to-send options for the
// next message to choose from. Results are cached per conversation in
// `conversation_coaching` and rolled up per account into `coaching_digest`.
//
// The prompt, the thread rendering and the model call live in
// `_lib/coachCore.ts`, shared with the trainer. The coach runs the PUBLISHED
// prompt version (ledger step 027), or the built-in prompt when none is
// published. The cache marker carries the version, so a publish makes every
// cached take stale; it regenerates the next time the coach is asked for.
//
// POST body:
//   { instance_id, profile_url }          → coach one conversation (Mode A)
//   { instance_id, profile_url, force }   → ignore the cache and recompute
//   { instance_id, mode: 'digest' }       → roll up recurring patterns (Mode B)
//   { mode: 'training.<op>', ... }        → the Coach training page (`_lib/coachTraining.ts`)
//
// Training lives here rather than in its own function because the deployment
// is at its function limit.
//
// Requires an active dashboard member. Every caller is a signed-in human, so the
// handler runs on the shared Neon runtime store under the caller's resolved actor.
import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { AuthorizationError, authorizationResponse } from './_lib/auth.js'
import { unavailableResponse } from './_lib/data/availability.js'
import {
  DataStoreContractError,
  type ActorContext,
  type DataStore,
} from './_lib/data/contracts.js'
import { AI_WRITE_OPERATIONS, type CoachingRow } from './_lib/data/operations/index.js'
import { neonWriter, type NeonWriteDeps } from './_lib/neonWrites.js'
import {
  CONV_MODEL,
  DEFAULT_COACH_PROMPT,
  coachingMarkerOf,
  composeCoachSystem,
  ideasFrom,
  runCoach,
  scopeOf,
  type CoachIdea,
  type CoachScope,
  type Msg,
} from './_lib/coachCore.js'
import {
  allPages,
  firstRow,
  loadCoachThread,
  loadIcpForCampaign,
  loadPlaybook,
  loadPromptState,
} from './_lib/coachData.js'
import { handleTraining, isTrainingMode } from './_lib/coachTraining.js'

// Re-exported for the tests that pin the coach's scope rules.
export { issuesOnHandWritten, originOf, renderThread } from './_lib/coachCore.js'

export const maxDuration = 300

const DIGEST_MODEL = 'claude-opus-5-5' // cross-conversation self-correction digest
const DIGEST_BATCH = 25 // actionable threads back-filled before a digest

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

// ---------------------------------------------------------------------------
// The data seam: the reads and writes the coaching flows need, and their Neon
// implementation.
// ---------------------------------------------------------------------------

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
  prompt_version_id: number | null
}

/** The prompt the live coach runs: the published version, else the built-in. */
interface LivePrompt {
  readonly id: number | null
  readonly n: number | null
  readonly prompt: string
}

interface CoachData {
  loadThread(instance_id: string, profile_url: string): Promise<Msg[]>
  loadExisting(instance_id: string, profile_url: string): Promise<CoachingRow | null>
  saveCoaching(row: CoachingWrite): Promise<void>
  loadPlaybook(): Promise<string>
  loadIcpForCampaign(campaign_id: string | null | undefined): Promise<string>
  loadLivePrompt(): Promise<LivePrompt>
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

/** The Neon implementation: the shared runtime store under the caller's
 *  resolved actor. Reads and writes both run actor-scoped — the coach has a
 *  human, so it needs none of the blocked system path. */
function neonCoachData(store: DataStore, actor: ActorContext): CoachData {
  return {
    loadThread: (instance_id, profile_url) => loadCoachThread(store, actor, instance_id, profile_url),
    loadExisting: (instance_id, profile_url) =>
      firstRow<CoachingRow>(store, actor, AI_WRITE_OPERATIONS.coachExisting, {
        instanceId: instance_id,
        profileUrl: profile_url,
      }),
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
            promptVersionId: row.prompt_version_id,
          },
        })
      })
    },
    loadPlaybook: () => loadPlaybook(store, actor),
    loadIcpForCampaign: (campaign_id) => loadIcpForCampaign(store, actor, campaign_id),
    async loadLivePrompt() {
      const state = await loadPromptState(store, actor)
      if (state?.published_version_id && state.published_prompt) {
        return { id: state.published_version_id, n: state.published_n, prompt: state.published_prompt }
      }
      return { id: null, n: null, prompt: DEFAULT_COACH_PROMPT }
    },
    async actionableProfiles(instance_id) {
      // Newest-first walk, keep each profile's first (newest) direction, keep
      // the inbound ones.
      const rows = await allPages<{ profile_url: string; direction: string }>(
        store, actor, AI_WRITE_OPERATIONS.coachActionableProfiles, { instanceId: instance_id },
      )
      const latestDir = new Map<string, string>()
      for (const m of rows) {
        if (!latestDir.has(m.profile_url)) latestDir.set(m.profile_url, m.direction)
      }
      return [...latestDir.entries()].filter(([, d]) => d === 'in').map(([p]) => p)
    },
    loadIssues: (instance_id) =>
      allPages<{ issues: unknown[] }>(store, actor, AI_WRITE_OPERATIONS.coachIssuesByInstance, {
        instanceId: instance_id,
      }),
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
  /** The prompt version that produced this take; null id = the built-in prompt. */
  prompt_version: { id: number | null; n: number | null }
}

/** Coach one conversation. Serves a cached row when the thread and the prompt
 *  are unchanged (unless force), otherwise calls the model and upserts.
 *  Returns null for an empty thread. */
async function coachConversation(
  data: CoachData,
  instance_id: string,
  profile_url: string,
  playbook: string,
  force: boolean,
  campaign_id?: string | null,
  live?: LivePrompt,
): Promise<CoachingOut | null> {
  const thread = await data.loadThread(instance_id, profile_url)
  if (!thread.length) return null
  const prompt = live ?? await data.loadLivePrompt()
  const marker = coachingMarkerOf(thread, prompt.id)
  const scope = scopeOf(thread)
  const promptVersion = { id: prompt.id, n: prompt.n }

  if (!force) {
    const existing = await data.loadExisting(instance_id, profile_url)
    // The marker carries the prompt version, so a hit was made with this one.
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
        prompt_version: promptVersion,
      }
    }
  }

  const icpText = await data.loadIcpForCampaign(campaign_id)
  const result = await runCoach(composeCoachSystem(prompt.prompt, playbook, icpText), thread)
  const now = new Date().toISOString()
  await data.saveCoaching({
    instance_id,
    profile_url,
    next_action: result.next_action,
    issues: result.issues,
    tips: result.ideas,
    summary: result.summary,
    last_msg_marker: marker,
    coached_at: now,
    model: CONV_MODEL,
    prompt_version_id: prompt.id,
  })
  return {
    next_action: result.next_action,
    issues: result.issues,
    ideas: result.ideas,
    summary: result.summary,
    last_msg_marker: marker,
    coached_at: now,
    model: CONV_MODEL,
    cached: false,
    scope,
    prompt_version: promptVersion,
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

type ResolvedWriter = Awaited<ReturnType<typeof neonWriter>>

/** Resolve the actor against the database being written — the only place the
 *  membership can be checked without a race, the same argument `neonWrites.ts`
 *  makes. Answers a Response when it cannot. */
async function resolveWriter(req: Request, deps: NeonWriteDeps): Promise<ResolvedWriter | Response> {
  try {
    return await neonWriter(req, deps)
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
}

function failure(error: unknown, label: string): Response {
  const denial = authorizationResponse(error)
  if (denial) return denial
  if (error instanceof AuthorizationError) return json({ error: 'Unauthorized' }, error.status)
  console.error(`${label}:`, safeErrorLabel(error))
  return json({ error: 'Coaching failed — check server logs.' }, 500)
}

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
  const writer = await resolveWriter(req, deps)
  if (writer instanceof Response) return writer

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
    return failure(error, 'Neon coach failed')
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
  if (!body || typeof body !== 'object') return json({ error: 'invalid JSON body' }, 400)

  if (isTrainingMode(body.mode)) {
    const writer = await resolveWriter(req, deps)
    if (writer instanceof Response) return writer
    try {
      return await handleTraining(body.mode, body as Record<string, unknown>, writer.store, writer.actor)
    } catch (error) {
      return failure(error, 'Coach training failed')
    }
  }

  const instance_id = body.instance_id
  if (typeof instance_id !== 'string' || !instance_id) {
    return json({ error: 'instance_id (string) is required' }, 400)
  }

  return coachOnNeon(req, { ...body, instance_id }, deps)
}

/** Exported for tests, which inject the store and identity. */
export const handleCoach = handle

export const POST = (req: Request) => handle(req)
