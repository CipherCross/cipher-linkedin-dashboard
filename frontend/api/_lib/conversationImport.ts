// Manual conversation import. LH2 stops capturing a thread once the SDR takes
// it over by hand, so the ConversationDrawer's "Import history" flow lets her
// paste the LinkedIn thread; the parsed blocks land here. This file validates;
// the Neon writes in _lib/neonWrites.ts read, write and commit.
//
// Dedup: synced rows carry the LH2 action-RUN time as sent_at while pasted rows
// carry the real message time, so the messages identity key never merges the
// two copies of one logical message. We dedupe by direction + normalized body
// within the thread instead; a block the client explicitly re-checked in the
// preview arrives with force=true and skips that check (e.g. a legitimately
// repeated "Thanks!"). The identity key backstops exact re-imports.
//
// Milestone backfill: imported messages prove milestones LH2 never saw (an
// inbound message = a reply happened). Only NULL milestone columns are filled —
// idempotent, and LH2 stays ground truth for anything it did record. Migration
// 026's leads_keep_milestones trigger keeps the agent's next sync from
// clobbering these back to NULL.
//
// Guard: applied by the shared /api/import dispatcher before this helper runs.
//
// Extra actions (Vercel Hobby caps this project at its current 12 function
// files, so editing/deletion share the import dispatcher): edit_message updates
// the body of ONE manually-imported message; { action: 'delete_message', id }
// deletes one and repairs lead milestones the import backfilled from that row.
// Sync rows are not deletable — the delete refuses them and we 404.
import { createHash } from 'node:crypto'
import {
  neonDeleteMessage,
  neonEditMessage,
  neonImportConversation,
} from './neonWrites.js'

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

export async function handleConversationImport(
  payload: {
    action?: unknown
    id?: unknown
    body?: unknown
    instance_id?: unknown
    campaign_id?: unknown
    profile_url?: unknown
    messages?: unknown
  },
  req: Request,
): Promise<Response> {
  // Deleting a single imported row intentionally needs only its message id.
  // Dispatch it before validating the full conversation-import payload.
  if (payload.action === 'delete_message') {
    return deleteMessage(payload.id, req)
  }
  if (payload.action === 'edit_message') {
    return editMessage(payload.id, payload.body, req)
  }

  const { instance_id, campaign_id, profile_url } = payload
  if (typeof instance_id !== 'string' || !instance_id) {
    return json({ error: 'instance_id (string) is required' }, 400)
  }
  // Optional: a conversation whose person has no lead (an existing connection,
  // someone outside every campaign) imports its messages with no campaign and
  // has no lead milestones to backfill.
  if (campaign_id !== undefined && campaign_id !== null && (typeof campaign_id !== 'string' || !campaign_id)) {
    return json({ error: 'campaign_id must be a non-empty string when given' }, 400)
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

  // `normalizeForDedup` and `md5` are passed across rather than reimplemented:
  // the dedup rule has one definition per TS root.
  return neonImportConversation(req, {
    instanceId: instance_id,
    campaignId: typeof campaign_id === 'string' ? campaign_id : null,
    profileUrl: profile_url,
    messages: msgs.map((m) => ({
      direction: m.direction,
      body: m.body,
      sent_at: m.sent_at,
      force: m.force === true,
      contentHash: md5(m.body),
    })),
    normalize: normalizeForDedup,
  })
}

async function deleteMessage(id: unknown, req: Request): Promise<Response> {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return json({ error: 'id (positive integer) is required' }, 400)
  }
  return neonDeleteMessage(req, { messageId: id })
}

async function editMessage(
  id: unknown,
  body: unknown,
  req: Request,
): Promise<Response> {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return json({ error: 'id (positive integer) is required' }, 400)
  }
  if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY_CHARS) {
    return json({ error: `body must be a non-empty string (max ${MAX_BODY_CHARS} chars)` }, 400)
  }

  const nextBody = body.trim()
  return neonEditMessage(req, {
    messageId: id,
    body: nextBody,
    contentHash: md5(nextBody),
  })
}
