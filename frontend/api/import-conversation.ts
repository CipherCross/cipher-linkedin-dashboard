// Manual conversation import. LH2 stops capturing a thread once the SDR takes
// it over by hand, so the ConversationDrawer's "Import history" flow lets her
// paste the LinkedIn thread; the parsed blocks land here. Writes need the
// service-role key (messages has no RLS write policy), reused from _lib/core.
//
// Dedup: synced rows carry the LH2 action-RUN time as sent_at while pasted rows
// carry the real message time, so the messages identity key never merges the
// two copies of one logical message. We dedupe by direction + normalized body
// within the thread instead; a block the client explicitly re-checked in the
// preview arrives with force=true and skips that check (e.g. a legitimately
// repeated "Thanks!"). The identity-key upsert with ignoreDuplicates backstops
// exact re-imports.
//
// Milestone backfill: imported messages prove milestones LH2 never saw (an
// inbound message = a reply happened). Only NULL milestone columns are filled —
// idempotent, and LH2 stays ground truth for anything it did record. Migration
// 026's leads_keep_milestones trigger keeps the agent's next sync from
// clobbering these back to NULL.
//
// Guard: same as /api/config — if ADMIN_SECRET is set on the Vercel project,
// callers must send it as an `x-admin-secret` header.
import { createHash } from 'node:crypto'
import { db } from './_lib/core.js'

export const maxDuration = 10

const MAX_MESSAGES = 500
const MAX_BODY_CHARS = 5000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

// Keep in sync with src/lib/parseLinkedInThread.ts (api/ and src/ are separate
// TS roots — no cross-imports).
const normalizeForDedup = (body: string) =>
  body.replace(/\r/g, '').trim().replace(/\s+/g, ' ').toLowerCase()

// Matches Postgres md5(coalesce(body,'')) and the agent's content_hash().
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')

interface ImportMessage {
  direction: 'in' | 'out'
  body: string
  sent_at: string // ISO UTC
  force?: boolean
}

const minIso = (msgs: ImportMessage[], direction: 'in' | 'out'): string | null => {
  const times = msgs.filter((m) => m.direction === direction).map((m) => m.sent_at)
  return times.length ? times.reduce((a, b) => (a < b ? a : b)) : null
}

async function handle(req: Request): Promise<Response> {
  const secret = process.env.ADMIN_SECRET
  if (secret && req.headers.get('x-admin-secret') !== secret) {
    return json({ error: 'unauthorized' }, 401)
  }

  let payload: {
    instance_id?: unknown
    campaign_id?: unknown
    profile_url?: unknown
    messages?: unknown
  }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const { instance_id, campaign_id, profile_url } = payload
  if (typeof instance_id !== 'string' || !instance_id) {
    return json({ error: 'instance_id (string) is required' }, 400)
  }
  if (typeof campaign_id !== 'string' || !campaign_id) {
    return json({ error: 'campaign_id (string) is required' }, 400)
  }
  if (typeof profile_url !== 'string' || !profile_url) {
    return json({ error: 'profile_url (string) is required' }, 400)
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return json({ error: 'messages (non-empty array) is required' }, 400)
  }
  if (payload.messages.length > MAX_MESSAGES) {
    return json({ error: `too many messages (max ${MAX_MESSAGES})` }, 400)
  }
  const msgs: ImportMessage[] = []
  for (const [i, m] of (payload.messages as unknown[]).entries()) {
    const msg = m as Partial<ImportMessage>
    if (msg?.direction !== 'in' && msg?.direction !== 'out') {
      return json({ error: `messages[${i}].direction must be 'in' or 'out'` }, 400)
    }
    if (typeof msg.body !== 'string' || !msg.body.trim() || msg.body.length > MAX_BODY_CHARS) {
      return json({ error: `messages[${i}].body must be a non-empty string (max ${MAX_BODY_CHARS} chars)` }, 400)
    }
    if (typeof msg.sent_at !== 'string' || !Number.isFinite(Date.parse(msg.sent_at))) {
      return json({ error: `messages[${i}].sent_at must be an ISO timestamp` }, 400)
    }
    msgs.push({
      direction: msg.direction,
      body: msg.body,
      sent_at: new Date(msg.sent_at).toISOString(),
      force: msg.force === true,
    })
  }

  const supa = db()

  // The lead must exist: it anchors the messages->campaigns FK (enforced on new
  // writes) and is the milestone-backfill target.
  const { data: lead, error: leadErr } = await supa
    .from('leads')
    .select('id,instance_id,connected_at,first_message_at,replied_at')
    .eq('campaign_id', campaign_id)
    .eq('profile_url', profile_url)
    .maybeSingle()
  if (leadErr) return json({ error: leadErr.message }, 500)
  if (!lead) return json({ error: 'unknown lead (campaign_id + profile_url)' }, 404)
  if (lead.instance_id !== instance_id) {
    return json({ error: 'instance_id does not match the lead' }, 400)
  }

  const { data: existing, error: exErr } = await supa
    .from('messages')
    .select('direction,body')
    .eq('instance_id', instance_id)
    .eq('profile_url', profile_url)
  if (exErr) return json({ error: exErr.message }, 500)

  const seen = new Set(
    (existing ?? []).map((r) => `${r.direction}|${normalizeForDedup(r.body ?? '')}`),
  )
  const rows: Record<string, string>[] = []
  let skipped = 0
  for (const m of msgs) {
    const key = `${m.direction}|${normalizeForDedup(m.body)}`
    if (!m.force && seen.has(key)) {
      skipped++
      continue
    }
    seen.add(key) // a double-pasted block dedupes against itself within one request
    rows.push({
      instance_id,
      campaign_id,
      profile_url,
      direction: m.direction,
      body: m.body,
      sent_at: m.sent_at,
      content_hash: md5(m.body),
      source: 'manual',
    })
  }

  let inserted = 0
  if (rows.length) {
    const { data, error } = await supa
      .from('messages')
      .upsert(rows, {
        onConflict: 'instance_id,profile_url,direction,sent_at,content_hash',
        ignoreDuplicates: true, // forced exact re-import = silent skip, not a 409
      })
      .select('id')
    if (error) return json({ error: error.message }, 500)
    inserted = data?.length ?? 0
    skipped += rows.length - inserted
  }

  // Backfill from the FULL validated payload, not just inserted rows — patching
  // only NULL columns is what makes this idempotent, and a fully-deduped
  // re-import should still fill a milestone a previous partial import missed.
  const minIn = minIso(msgs, 'in')
  const minOut = minIso(msgs, 'out')
  const patch: Record<string, string> = {}
  if (!lead.replied_at && minIn) patch.replied_at = minIn
  if (!lead.first_message_at && minOut) patch.first_message_at = minOut
  if (!lead.connected_at) {
    const earliest = [minIn, minOut].filter((t): t is string => !!t).sort()[0]
    if (earliest) patch.connected_at = earliest
  }

  let milestone_error: string | undefined
  if (Object.keys(patch).length) {
    const { error } = await supa.from('leads').update(patch).eq('id', lead.id)
    // Messages are already committed at this point — report, don't fail the call.
    if (error) milestone_error = error.message
  }

  return json({
    ok: true,
    inserted,
    skipped,
    ...(Object.keys(patch).length && !milestone_error ? { milestones: patch } : {}),
    ...(milestone_error ? { milestone_error } : {}),
  })
}

export const POST = (req: Request) => handle(req)
