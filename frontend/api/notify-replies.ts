// New-reply Slack alerts. Finds inbound sync messages not yet announced
// (notified_at IS NULL), claims them, and posts one Block Kit message to Slack
// so SDRs can jump on warm leads without watching the dashboard.
//
// Triggers:
//   POST — the sync-agent pings after every successful push (see agent.py's
//          notify_new_replies). No secret: the work is self-limiting (only
//          unnotified rows, capped batch, race-safe claim), so repeated calls
//          are safe and converge to a no-op — same rationale as /api/classify.
//   GET  — a daily Vercel cron sweep (guarded by CRON_SECRET) that catches
//          backlog left by pings lost to Slack/Vercel outages.
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

export const maxDuration = 30

const BATCH = 20 // max messages claimed per invocation
const WINDOW_DAYS = 14 // sent_at older than this: mark, never post (history dumps)
const SNIPPET = 300 // chars per rendered snippet
const MAX_SNIPPETS_PER_LEAD = 2

interface Claimed {
  id: number
  instance_id: string
  campaign_id: string | null
  profile_url: string
  body: string | null
  sent_at: string
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

async function handle(req: Request): Promise<Response> {
  // Cron path is guarded; the agent's POST path is intentionally open (see top).
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET
    if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
      return json({ error: 'unauthorized' }, 401)
    }
  }

  const sb = db()

  // 1. Candidates, oldest first so backlog drains in order.
  const { data: cand, error } = await sb
    .from('messages')
    .select('id')
    .eq('direction', 'in')
    .eq('source', 'sync')
    .is('notified_at', null)
    .not('body', 'is', null)
    .order('sent_at', { ascending: true })
    .limit(BATCH)
  if (error) return json({ error: error.message }, 500)
  if (!cand?.length) return json({ posted: 0, remaining: 0 })

  // 2. Claim — atomic; ids a concurrent run already claimed return zero rows.
  const { data: claimed, error: claimErr } = await sb
    .from('messages')
    .update({ notified_at: new Date().toISOString() })
    .in('id', cand.map((c) => c.id))
    .is('notified_at', null)
    .select('id,instance_id,campaign_id,profile_url,body,sent_at')
  if (claimErr) return json({ error: claimErr.message }, 500)
  if (!claimed?.length) return json({ posted: 0, note: 'claimed by concurrent run' })

  // 3. Stale rows stay claimed without posting — second spam guard against a
  // re-enabled notebook dumping months of history in one sync.
  const cutoff = Date.now() - WINDOW_DAYS * 86_400_000
  const fresh = (claimed as Claimed[]).filter((m) => Date.parse(m.sent_at) >= cutoff)
  const stale = claimed.length - fresh.length
  if (!fresh.length) return json({ posted: 0, marked_stale: stale })

  const webhook = process.env.SLACK_REPLIES_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL
  if (!webhook) {
    return json({ posted: 0, marked: claimed.length, note: 'no webhook configured' })
  }

  // 4. Enrich for display. Failures here degrade to slug display, never abort —
  // losing a name is better than losing (or double-posting) the notification.
  const instances = [...new Set(fresh.map((m) => m.instance_id))]
  const profiles = [...new Set(fresh.map((m) => m.profile_url))]
  const campaignIds = [...new Set(fresh.map((m) => m.campaign_id).filter(Boolean))] as string[]
  const [leadsRes, campsRes, instRes] = await Promise.all([
    sb
      .from('leads')
      .select('instance_id,campaign_id,profile_url,full_name,headline,company')
      .in('instance_id', instances)
      .in('profile_url', profiles),
    campaignIds.length
      ? sb.from('campaigns').select('id,name').in('id', campaignIds)
      : Promise.resolve({ data: [] as { id: string; name: string | null }[] }),
    sb.from('instances').select('id,account_name,label').in('id', instances),
  ])

  interface LeadRow {
    instance_id: string
    campaign_id: string
    profile_url: string
    full_name: string | null
    headline: string | null
    company: string | null
  }
  const leadRows = (leadsRes.data ?? []) as LeadRow[]
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
  const campName = new Map((campsRes.data ?? []).map((c) => [c.id, c.name]))
  const instName = new Map(
    (instRes.data ?? []).map((i) => [i.id, i.account_name || i.label || i.id])
  )

  // 5. Group by thread (same person via two accounts = two entries, per the
  // repo's leadKey convention), snippets oldest first.
  const byThread = new Map<string, Claimed[]>()
  for (const m of fresh.sort((a, b) => a.sent_at.localeCompare(b.sent_at))) {
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

  // 6. One Slack post per invocation; on failure un-claim so the next ping retries.
  const ok = await postNewRepliesToSlack(webhook, replies)
  if (!ok) {
    await sb
      .from('messages')
      .update({ notified_at: null })
      .in('id', fresh.map((m) => m.id))
    return json({ posted: 0, retry_next_sync: fresh.length }, 502)
  }

  const { count } = await sb
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'in')
    .eq('source', 'sync')
    .is('notified_at', null)
    .not('body', 'is', null)

  return json({
    posted: replies.length,
    messages: fresh.length,
    marked_stale: stale,
    remaining: count ?? 0,
  })
}

export const GET = (req: Request) => handle(req)
export const POST = (req: Request) => handle(req)
