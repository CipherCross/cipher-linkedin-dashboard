import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { neonDeleteMessage, neonEditMessage, neonImportConversation } = vi.hoisted(() => ({
  neonDeleteMessage: vi.fn(),
  neonEditMessage: vi.fn(),
  neonImportConversation: vi.fn(),
}))

vi.mock('../api/_lib/neonWrites.js', () => ({
  neonDeleteMessage,
  neonEditMessage,
  neonImportConversation,
}))

import { handleConversationImport } from '../api/_lib/conversationImport'

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('conversation history actions', () => {
  beforeEach(() => {
    neonDeleteMessage.mockReset()
    neonEditMessage.mockReset()
    neonImportConversation.mockReset()
  })

  it('deletes an imported message without requiring a full import payload', async () => {
    neonDeleteMessage.mockResolvedValue(ok({ ok: true, deleted: 42, milestones_recomputed: 1 }))
    const req = new Request('https://example.test/api/import', { method: 'POST' })

    const response = await handleConversationImport({ action: 'delete_message', id: 42 }, req)

    expect(response.status).toBe(200)
    expect(neonDeleteMessage).toHaveBeenCalledWith(req, { messageId: 42 })
    expect(neonImportConversation).not.toHaveBeenCalled()
  })

  it('edits a manual message without requiring conversation identity fields', async () => {
    neonEditMessage.mockResolvedValue(ok({ ok: true, edited: 42, body: 'Corrected message' }))
    const req = new Request('https://example.test/api/import', { method: 'POST' })

    const response = await handleConversationImport(
      { action: 'edit_message', id: 42, body: '  Corrected message  ' },
      req,
    )

    expect(response.status).toBe(200)
    expect(neonEditMessage).toHaveBeenCalledWith(req, {
      messageId: 42,
      body: 'Corrected message',
      contentHash: createHash('md5').update('Corrected message', 'utf8').digest('hex'),
    })
  })

  it('imports without a campaign when the conversation has no lead', async () => {
    neonImportConversation.mockResolvedValue(ok({ ok: true, inserted: 1, skipped: 0 }))
    const req = new Request('https://example.test/api/import', { method: 'POST' })
    const messages = [{ direction: 'in', body: 'Hi', sent_at: '2026-09-01T10:00:00Z' }]
    const response = await handleConversationImport({ instance_id: 'n1', profile_url: 'https://www.linkedin.com/in/x', messages }, req)
    expect(response.status).toBe(200)
    expect(neonImportConversation.mock.calls[0][1]).toMatchObject({ instanceId: 'n1', campaignId: null })
    // A campaign that is given must still be a real string.
    const bad = await handleConversationImport({ instance_id: 'n1', campaign_id: '', profile_url: 'p', messages }, req)
    expect(bad.status).toBe(400)
  })

  it('refuses a malformed id before touching the store', async () => {
    const req = new Request('https://example.test/api/import', { method: 'POST' })
    for (const id of [0, -1, 1.5, '42', null]) {
      const response = await handleConversationImport({ action: 'delete_message', id }, req)
      expect(response.status).toBe(400)
    }
    expect(neonDeleteMessage).not.toHaveBeenCalled()
  })
})
