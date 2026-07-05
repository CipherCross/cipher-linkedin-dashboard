// Weekly manager review digest. The dashboard's review page computes the whole
// cohort digest client-side (rates, deltas, maturity note) — this endpoint does
// no DB work, it just validates the pre-computed payload and relays it to Slack
// via _lib/slack.ts. Kept defensive on shape/size since a malformed body would
// otherwise post garbage straight to the team channel.
//
// Guard: same as /api/config and /api/playbook — if ADMIN_SECRET is set on the
// Vercel project, callers must send it as an `x-admin-secret` header; if unset,
// the endpoint is open (acceptable only because this is an internal tool).
import { postReviewDigestToSlack, type ReviewDigestRow } from './_lib/slack.js'

export const maxDuration = 10

const MAX_BODY_BYTES = 32 * 1024
const MAX_ROWS = 30
const MAX_SCOPE_CHARS = 200
const MAX_NOTE_CHARS = 1000
const MAX_FIELD_CHARS = 200

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const numOrNull = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isFinite(v))

const nonNegInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0

async function handle(req: Request): Promise<Response> {
  const secret = process.env.ADMIN_SECRET
  if (secret && req.headers.get('x-admin-secret') !== secret) {
    return json({ error: 'unauthorized' }, 401)
  }

  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return json({ error: 'body too large (max 32KB)' }, 413)
  }

  let payload: {
    cohort_week?: unknown
    scope?: unknown
    maturity_note?: unknown
    totals?: unknown
    rows?: unknown
  }
  try {
    payload = JSON.parse(raw)
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const { cohort_week, scope, maturity_note, totals } = payload
  if (typeof cohort_week !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(cohort_week)) {
    return json({ error: 'cohort_week must be a YYYY-MM-DD string' }, 400)
  }
  if (typeof scope !== 'string' || !scope.trim() || scope.length > MAX_SCOPE_CHARS) {
    return json({ error: `scope must be a non-empty string (max ${MAX_SCOPE_CHARS} chars)` }, 400)
  }
  if (typeof maturity_note !== 'string' || maturity_note.length > MAX_NOTE_CHARS) {
    return json({ error: `maturity_note must be a string (max ${MAX_NOTE_CHARS} chars)` }, 400)
  }

  if (typeof totals !== 'object' || totals === null) {
    return json({ error: 'totals (object) is required' }, 400)
  }
  const t = totals as Record<string, unknown>
  const totalFields = ['invites', 'accepted', 'replied', 'positive'] as const
  for (const f of totalFields) {
    if (!nonNegInt(t[f])) {
      return json({ error: `totals.${f} must be a non-negative integer` }, 400)
    }
  }
  const totalsOut = {
    invites: t.invites as number,
    accepted: t.accepted as number,
    replied: t.replied as number,
    positive: t.positive as number,
  }

  if (!Array.isArray(payload.rows)) {
    return json({ error: 'rows (array) is required' }, 400)
  }
  if (payload.rows.length > MAX_ROWS) {
    return json({ error: `too many rows (max ${MAX_ROWS})` }, 413)
  }

  const rows: ReviewDigestRow[] = []
  for (const [i, r] of (payload.rows as unknown[]).entries()) {
    const row = r as Record<string, unknown>
    if (typeof row.campaign !== 'string' || !row.campaign.trim() || row.campaign.length > MAX_FIELD_CHARS) {
      return json({ error: `rows[${i}].campaign must be a non-empty string (max ${MAX_FIELD_CHARS} chars)` }, 400)
    }
    if (typeof row.account !== 'string' || !row.account.trim() || row.account.length > MAX_FIELD_CHARS) {
      return json({ error: `rows[${i}].account must be a non-empty string (max ${MAX_FIELD_CHARS} chars)` }, 400)
    }
    if (!nonNegInt(row.invites)) {
      return json({ error: `rows[${i}].invites must be a non-negative integer` }, 400)
    }
    if (!numOrNull(row.accept_rate)) {
      return json({ error: `rows[${i}].accept_rate must be a number or null` }, 400)
    }
    if (!numOrNull(row.reply_rate)) {
      return json({ error: `rows[${i}].reply_rate must be a number or null` }, 400)
    }
    if (!numOrNull(row.positive_share)) {
      return json({ error: `rows[${i}].positive_share must be a number or null` }, 400)
    }
    if (!numOrNull(row.d_accept)) {
      return json({ error: `rows[${i}].d_accept must be a number or null` }, 400)
    }
    if (!numOrNull(row.d_reply)) {
      return json({ error: `rows[${i}].d_reply must be a number or null` }, 400)
    }
    rows.push({
      campaign: row.campaign,
      account: row.account,
      invites: row.invites,
      accept_rate: row.accept_rate,
      reply_rate: row.reply_rate,
      positive_share: row.positive_share,
      d_accept: row.d_accept,
      d_reply: row.d_reply,
    })
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    return json({ error: 'SLACK_WEBHOOK_URL is not configured' }, 500)
  }

  const ok = await postReviewDigestToSlack(webhookUrl, {
    cohort_week,
    scope,
    maturity_note,
    totals: totalsOut,
    rows,
  })
  if (!ok) return json({ error: 'slack delivery failed' }, 502)

  return json({ ok: true })
}

export const POST = (req: Request) => handle(req)
