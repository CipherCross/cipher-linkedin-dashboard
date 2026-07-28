import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc, from, update, maybeSingle } = vi.hoisted(() => {
  const maybeSingle = vi.fn()
  const chain: Record<string, ReturnType<typeof vi.fn>> = {}
  chain.update = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.select = vi.fn(() => chain)
  chain.maybeSingle = maybeSingle
  return {
    rpc: vi.fn(),
    from: vi.fn(() => chain),
    update: chain.update,
    maybeSingle,
  }
})

vi.mock('../api/_lib/core.js', () => ({
  db: () => ({ rpc, from }),
}))

import { handleConversationImport } from '../api/_lib/conversationImport'

describe('conversation history actions', () => {
  beforeEach(() => {
    rpc.mockReset()
    from.mockClear()
    update.mockClear()
    maybeSingle.mockReset()
  })

  it('deletes an imported message without requiring a full import payload', async () => {
    rpc.mockResolvedValue({
      data: { deleted: true, milestones_recomputed: 1 },
      error: null,
    })

    const response = await handleConversationImport({
      action: 'delete_message',
      id: 42,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      deleted: 42,
      milestones_recomputed: 1,
    })
    expect(rpc).toHaveBeenCalledWith('delete_manual_message', {
      p_message_id: 42,
    })
  })

  it('edits a manual message without requiring conversation identity fields', async () => {
    maybeSingle.mockResolvedValue({ data: { id: 42 }, error: null })

    const response = await handleConversationImport({
      action: 'edit_message',
      id: 42,
      body: '  Corrected message  ',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      edited: 42,
      body: 'Corrected message',
    })
    expect(from).toHaveBeenCalledWith('messages')
    expect(update).toHaveBeenCalledWith({
      body: 'Corrected message',
      content_hash: expect.any(String),
    })
  })
})
