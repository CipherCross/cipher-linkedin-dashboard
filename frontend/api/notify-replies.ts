// New-reply Slack alerts. Finds inbound sync messages not yet announced
// (notified_at IS NULL), claims them, and posts one Block Kit message to Slack
// so SDRs can jump on warm leads without watching the dashboard.
//
// Triggers:
//   POST — the sync-agent pings after every successful push (see agent.py's
//          notify_new_replies) with its per-notebook machine bearer token.
//          The old NOTIFY_SECRET remains a server-side compatibility path for
//          pre-S23 agents only.
//   GET  — a daily Vercel cron sweep (guarded by CRON_SECRET) that catches
//          backlog left by pings lost to Slack/Vercel outages.
//
// ## The provider split
//
// This endpoint has no human actor and never will: both triggers are machine
// callers holding a shared secret. That is why it was declared blocked on the
// Neon path for a whole session — every business policy in baseline step 002
// opens only for an active *human*. Ledger step 007 is now applied and gives
// the server-owned principal `app_system` its own write path, so when
// `NEON_AI_PATH_DEFAULT=neon` this runs on the AI store as `SYSTEM_ACTOR`.
// No human actor is invented anywhere: there is none to invent, and a
// synthetic member id would be a lie the audit trail would carry forever.
//
// The two implementations share everything above data access — the staleness
// rule, the grouping, the snippets, the Slack payload and every response body —
// through the `NotifyData` seam, because the callers cannot tell which provider
// answered and must never need to.
//
// Concurrency: several notebooks sync on ~30-min crons that drift into
// alignment, so overlapping invocations are the COMMON case. The claim is one
// atomic UPDATE … WHERE notified_at IS NULL RETURNING …: Postgres re-checks
// the predicate under the row lock, so two runs can never announce the same
// row. On a failed Slack post the fresh rows are un-claimed (best effort) so
// the next ping retries; any ping drains ALL instances' backlog, so a lost
// ping heals within one sync cycle.
//
// If no webhook is configured, claimed rows STAY marked: leaving them pending
// would grow an unbounded backlog that floods the channel the moment someone
// sets the webhook — notifications are about now, old replies live on the
// dashboard.
import { db } from './_lib/core.js'
import { postNewRepliesToSlack, type NewReplyForSlack } from './_lib/slack.js'
import { guardMachine } from './_lib/auth.js'
import { authenticateMachine, presentsMachineToken } from './_lib/agent/machineAuth.js'
import { readDeploymentTenantId } from './_lib/agent/tenant.js'
import { getMachineDataStore } from './_lib/data/machineStore.js'
import { machineStoreConfigured } from './_lib/data/neonConfig.js'
import type { DataStore } from './_lib/data/contracts.js'
import { deploymentAiPath } from './_lib/data/aiPath.js'
import { getAiDataStore, SYSTEM_ACTOR } from './_lib/data/aiStore.js'
import {
  DataStoreContractError,
  MAX_PAGE_SIZE,
  type Page,
} from './_lib/data/contracts.js'
import {
  SYSTEM_OPERATIONS,
  firstGuardResult,
  type ClaimedMessageRow,
  type NotifyCandidateRow,
  type NotifyLeadRow,
} from './_lib/data/operations/aiSystem.js'

export const maxDuration = 30

let machineStore: DataStore | null | undefined
let machineTenant: string | null | undefined

function notifyMachineDeps(): { readonly store: DataStore | null; readonly tenantId: string | null } {
  if (machineStore === undefined) {
    machineStore = machineStoreConfigured() ? getMachineDataStore() : null
    machineTenant = readDeploymentTenantId()
  }
  return { store: machineStore, tenantId: machineTenant ?? null }
}

const BATCH = 20 // max messages claimed per invocation
const WINDOW_DAYS = 14 // sent_at older than this: mark, never post (history dumps)
const SNIPPET = 300 // chars per rendered snippet
const MAX_SNIPPETS_PER_LEAD = 2

type Claimed = ClaimedMessageRow

type LeadRow = NotifyLeadRow

interface CampaignNameRow {
  readonly id: string
  readonly name: string | null
}

interface InstanceNameRow {
  readonly id: string
  readonly account_name: string | null
  readonly label: string | null
}

/**
 * What one attempt to claim a batch produced.
 *
 * Four outcomes rather than "rows or nothing", because the endpoint answers
 * differently for each and always has: an empty backlog reports `remaining: 0`,
 * while a batch another invocation took first reports the concurrent-run note.
 * Collapsing them would make the two indistinguishable to the sync agent's log.
 */
type ClaimOutcome =
  | { readonly kind: 'claimed'; readonly messages: readonly Claimed[] }
  | { readonly kind: 'no-candidates' }
  | { readonly kind: 'concurrent' }
  /** The text of the 500 body. Composed by the implementation, because only it
   *  knows what may safely be said about its own failure. */
  | { readonly kind: 'failed'; readonly message: string }

/**
 * The data access this endpoint needs, and nothing else.
 *
 * Everything except `claim` is best effort by contract: an enrichment read that
 * fails degrades to the slug display and an un-claim that fails is retried by
 * the next ping, so none of these may throw. Losing a name is better than
 * losing — or double-posting — the notification.
 */
interface NotifyData {
  /** Read a batch of candidates and claim it, atomically. */
  claim(batch: number): Promise<ClaimOutcome>
  /** Lead rows for the claimed batch, as a cross-product of the two lists. */
  leads(
    instances: readonly string[],
    profiles: readonly string[],
  ): Promise<readonly LeadRow[]>
  /** Campaign display names. Empty `ids` means no lookup is needed at all. */
  campaigns(ids: readonly string[]): Promise<readonly CampaignNameRow[]>
  instances(ids: readonly string[]): Promise<readonly InstanceNameRow[]>
  /** Give a claim back after Slack refused it. */
  unclaim(ids: readonly number[]): Promise<void>
  /** How many candidates are still waiting after this invocation. */
  remaining(): Promise<number>
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const threadKey = (instance_id: string, profile_url: string) =>
  `${instance_id}|${profile_url}`

/** Human-ish fallback name from a profile URL: the last path segment. */
const slugOf = (profile_url: string) =>
  profile_url.replace(/\/+$/, '').split('/').pop() || profile_url

/**
 * Log a failure by class, never by message. The driver composes a failure as
 * `` `${what}: ${originalMessage}` ``, and for a connection-level failure the
 * original text embeds the database hostname. The fourth copy of this function
 * — `neonWrites.ts` records why the three before it were not consolidated.
 */
function safeErrorLabel(error: unknown): string {
  if (error instanceof DataStoreContractError) return `${error.name}(${error.code})`
  if (error instanceof Error) return error.name
  return 'UnknownError'
}

// ---------------------------------------------------------------------------
// The Supabase implementation: the service-role client, exactly as before the
// provider split.
// ---------------------------------------------------------------------------

function supabaseNotifyData(): NotifyData {
  const sb = db()
  return {
    async claim(batch) {
      // Candidates, oldest first so backlog drains in order.
      const { data: cand, error } = await sb
        .from('messages')
        .select('id')
        .eq('direction', 'in')
        .eq('source', 'sync')
        .is('notified_at', null)
        .not('body', 'is', null)
        .order('sent_at', { ascending: true })
        .limit(batch)
      if (error) return { kind: 'failed', message: error.message }
      if (!cand?.length) return { kind: 'no-candidates' }

      // Atomic; ids a concurrent run already claimed return zero rows.
      const { data: claimed, error: claimErr } = await sb
        .from('messages')
        .update({ notified_at: new Date().toISOString() })
        .in('id', cand.map((c) => c.id))
        .is('notified_at', null)
        .select('id,instance_id,campaign_id,profile_url,body,sent_at')
      if (claimErr) return { kind: 'failed', message: claimErr.message }
      if (!claimed?.length) return { kind: 'concurrent' }
      return { kind: 'claimed', messages: claimed as Claimed[] }
    },
    async leads(instances, profiles) {
      const { data } = await sb
        .from('leads')
        .select('instance_id,campaign_id,profile_url,full_name,headline,company')
        .in('instance_id', instances as string[])
        .in('profile_url', profiles as string[])
      return (data ?? []) as LeadRow[]
    },
    async campaigns(ids) {
      if (!ids.length) return []
      const { data } = await sb
        .from('campaigns')
        .select('id,name')
        .in('id', ids as string[])
      return (data ?? []) as CampaignNameRow[]
    },
    async instances(ids) {
      const { data } = await sb
        .from('instances')
        .select('id,account_name,label')
        .in('id', ids as string[])
      return (data ?? []) as InstanceNameRow[]
    },
    async unclaim(ids) {
      await sb
        .from('messages')
        .update({ notified_at: null })
        .in('id', ids as number[])
    },
    async remaining() {
      const { count } = await sb
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('direction', 'in')
        .eq('source', 'sync')
        .is('notified_at', null)
        .not('body', 'is', null)
      return count ?? 0
    },
  }
}

// ---------------------------------------------------------------------------
// The Neon implementation: the AI store as `app_system`, under step 007's
// system write path.
// ---------------------------------------------------------------------------

/**
 * `messages` and `leads` are in step 007's grant, so those are direct
 * statements. `campaigns` and `instances` are NOT, and no step gave them to
 * `app_system`; they are read through the SELECT-only guard, which is the only
 * route to them. Both guard reads are whole-relation (the guard takes no
 * parameter but the query text — see `aiSystem.ts`) and are filtered here.
 *
 * The three enrichment reads are issued in parallel by the shared half, as the
 * Supabase path always has, against a pool ceiling of two. The third waits for
 * a connection rather than failing; they are sub-second reads of small
 * relations, and a read that somehow did time out degrades to no rows like any
 * other enrichment failure.
 */
function neonNotifyData(): NotifyData {
  const store = getAiDataStore()
  const actor = SYSTEM_ACTOR

  /** Run a guard-backed context read, degrading to no rows on failure. */
  async function guardRows<TRow>(
    operation: string,
    what: string,
  ): Promise<readonly TRow[]> {
    try {
      const page = await store.query<unknown[]>(actor, {
        operation,
        page: { limit: 1 },
      })
      return firstGuardResult(page) as readonly TRow[]
    } catch (error) {
      console.error(`Neon notify failed (${what}):`, safeErrorLabel(error))
      return []
    }
  }

  return {
    async claim(batch) {
      let candidates: readonly NotifyCandidateRow[]
      try {
        // The batch ceiling is the page limit: the operation itself carries no
        // LIMIT, so the cap lives with the caller that owns the constant.
        const page = await store.query<NotifyCandidateRow>(actor, {
          operation: SYSTEM_OPERATIONS.notifyCandidates,
          page: { limit: batch },
        })
        candidates = page.items
      } catch (error) {
        console.error(
          'Neon notify failed (read the reply backlog):',
          safeErrorLabel(error),
        )
        return { kind: 'failed', message: 'Could not read the reply backlog' }
      }
      if (!candidates.length) return { kind: 'no-candidates' }

      try {
        // Its own transaction, committed before Slack is called. Holding the
        // claim open across an external HTTP call would make concurrent
        // invocations block on the row locks instead of reporting the
        // concurrent-run note, and would keep a pooled connection for the
        // duration of somebody else's outage.
        const claimed = await store.transaction(actor, (transaction) =>
          transaction.execute<readonly ClaimedMessageRow[]>({
            operation: SYSTEM_OPERATIONS.notifyClaim,
            params: {
              notifiedAt: new Date().toISOString(),
              ids: candidates.map((candidate) => candidate.id),
            },
          }),
        )
        if (!claimed.length) return { kind: 'concurrent' }
        return { kind: 'claimed', messages: claimed }
      } catch (error) {
        console.error(
          'Neon notify failed (claim the replies):',
          safeErrorLabel(error),
        )
        return { kind: 'failed', message: 'Could not claim the replies to announce' }
      }
    },

    async leads(instances, profiles) {
      try {
        const rows: LeadRow[] = []
        let cursor: string | null = null
        for (;;) {
          const page: Page<NotifyLeadRow> = await store.query<NotifyLeadRow>(actor, {
            operation: SYSTEM_OPERATIONS.notifyLeadContext,
            params: { instances, profiles },
            page: { limit: MAX_PAGE_SIZE, cursor },
          })
          rows.push(...page.items)
          if (!page.hasMore || page.nextCursor === null) break
          cursor = page.nextCursor
        }
        return rows
      } catch (error) {
        console.error('Neon notify failed (read lead names):', safeErrorLabel(error))
        return []
      }
    },

    async campaigns(ids) {
      if (!ids.length) return []
      const wanted = new Set(ids)
      const rows = await guardRows<CampaignNameRow>(
        SYSTEM_OPERATIONS.campaignNames,
        'read campaign names',
      )
      return rows.filter((row) => wanted.has(row.id))
    },

    async instances(ids) {
      const wanted = new Set(ids)
      const rows = await guardRows<InstanceNameRow>(
        SYSTEM_OPERATIONS.instanceNames,
        'read account names',
      )
      return rows.filter((row) => wanted.has(row.id))
    },

    async unclaim(ids) {
      try {
        await store.transaction(actor, (transaction) =>
          transaction.execute({
            operation: SYSTEM_OPERATIONS.notifyUnclaim,
            params: { ids },
          }),
        )
      } catch (error) {
        // Swallowed, exactly as the Supabase path swallows its error: the rows
        // stay claimed and unannounced, which the daily cron sweep re-reads
        // only if they become un-claimable — a stuck row is a smaller failure
        // than a double post.
        console.error('Neon notify failed (un-claim the batch):', safeErrorLabel(error))
      }
    },

    async remaining() {
      try {
        const page = await store.query<{ readonly remaining: number }>(actor, {
          operation: SYSTEM_OPERATIONS.notifyRemaining,
          page: { limit: 1 },
        })
        return page.items[0]?.remaining ?? 0
      } catch (error) {
        console.error('Neon notify failed (count the backlog):', safeErrorLabel(error))
        return 0
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Everything above data access, shared by both providers.
// ---------------------------------------------------------------------------

async function announce(data: NotifyData): Promise<Response> {
  const claim = await data.claim(BATCH)
  if (claim.kind === 'failed') return json({ error: claim.message }, 500)
  if (claim.kind === 'no-candidates') return json({ posted: 0, remaining: 0 })
  if (claim.kind === 'concurrent') {
    return json({ posted: 0, note: 'claimed by concurrent run' })
  }
  const claimed = claim.messages

  // Stale rows stay claimed without posting — second spam guard against a
  // re-enabled notebook dumping months of history in one sync.
  const cutoff = Date.now() - WINDOW_DAYS * 86_400_000
  const fresh = claimed.filter((m) => Date.parse(m.sent_at) >= cutoff)
  const stale = claimed.length - fresh.length
  if (!fresh.length) return json({ posted: 0, marked_stale: stale })

  const webhook = process.env.SLACK_REPLIES_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL
  if (!webhook) {
    return json({ posted: 0, marked: claimed.length, note: 'no webhook configured' })
  }

  // Enrich for display. Failures here degrade to slug display, never abort —
  // losing a name is better than losing (or double-posting) the notification.
  const instances = [...new Set(fresh.map((m) => m.instance_id))]
  const profiles = [...new Set(fresh.map((m) => m.profile_url))]
  const campaignIds = [...new Set(fresh.map((m) => m.campaign_id).filter(Boolean))] as string[]
  const [leadRows, campRows, instRows] = await Promise.all([
    data.leads(instances, profiles),
    data.campaigns(campaignIds),
    data.instances(instances),
  ])

  // Best-effort: the campaign-less fallback can pick a lead row from another
  // campaign when the same person sits in several (a known pattern) — worst
  // case a stale headline/company, never a wrong person or campaign name.
  const leadFor = (m: Claimed): LeadRow | undefined =>
    leadRows.find(
      (l) =>
        l.instance_id === m.instance_id &&
        l.profile_url === m.profile_url &&
        l.campaign_id === m.campaign_id
    ) ?? leadRows.find((l) => l.instance_id === m.instance_id && l.profile_url === m.profile_url)
  const campName = new Map(campRows.map((c) => [c.id, c.name]))
  const instName = new Map(
    instRows.map((i) => [i.id, i.account_name || i.label || i.id])
  )

  // Group by thread (same person via two accounts = two entries, per the
  // repo's leadKey convention), snippets oldest first.
  const byThread = new Map<string, Claimed[]>()
  for (const m of [...fresh].sort((a, b) => a.sent_at.localeCompare(b.sent_at))) {
    const k = threadKey(m.instance_id, m.profile_url)
    let arr = byThread.get(k)
    if (!arr) byThread.set(k, (arr = []))
    arr.push(m)
  }

  const dashboard = (process.env.DASHBOARD_URL || '').replace(/\/+$/, '')
  const replies: NewReplyForSlack[] = [...byThread.values()].map((msgs) => {
    const first = msgs[0]
    const lead = leadFor(first)
    const name = lead?.full_name || slugOf(first.profile_url)
    return {
      lead_name: name,
      headline: lead?.headline ?? null,
      company: lead?.company ?? null,
      campaign: first.campaign_id ? (campName.get(first.campaign_id) ?? null) : null,
      account: instName.get(first.instance_id) ?? first.instance_id,
      sent_at: first.sent_at,
      snippets: msgs
        .slice(0, MAX_SNIPPETS_PER_LEAD)
        .map((m) => (m.body ?? '').slice(0, SNIPPET)),
      extra_count: Math.max(0, msgs.length - MAX_SNIPPETS_PER_LEAD),
      ...(dashboard && lead?.full_name
        ? { link: `${dashboard}/#/leads?q=${encodeURIComponent(lead.full_name)}` }
        : {}),
    }
  })

  // One Slack post per invocation; on failure un-claim so the next ping retries.
  const ok = await postNewRepliesToSlack(webhook, replies)
  if (!ok) {
    await data.unclaim(fresh.map((m) => m.id))
    return json({ posted: 0, retry_next_sync: fresh.length }, 502)
  }

  return json({
    posted: replies.length,
    messages: fresh.length,
    marked_stale: stale,
    remaining: await data.remaining(),
  })
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const denied = await guardMachine(req, 'CRON_SECRET')
    if (denied) return denied
  } else {
    // New notebooks authenticate with their per-notebook machine credential.
    // Keep the old shared secret for already-installed agents during the dual
    // period; it is no longer emitted in the S23 config and is not the new
    // authorization path.
    if (presentsMachineToken(req.headers.get('authorization'))) {
      try {
        const authenticated = await authenticateMachine(
          req,
          notifyMachineDeps(),
          'notify-replies',
        )
        if (authenticated.response) return authenticated.response
      } catch (error) {
        console.error(
          'machine notify authentication failed',
          error instanceof Error ? error.name : 'unknown',
        )
        return json({ error: 'machine authentication failed' }, 500)
      }
    } else {
      const denied = await guardMachine(req, 'NOTIFY_SECRET')
      if (denied) return denied
    }
  }

  // The provider decision, taken once per invocation. Both triggers are
  // machine callers, so the AI path's flag is the whole decision — there is no
  // actor to resolve and none is invented.
  return announce(
    deploymentAiPath() === 'neon' ? neonNotifyData() : supabaseNotifyData(),
  )
}

export const GET = (req: Request) => handle(req)
export const POST = (req: Request) => handle(req)
