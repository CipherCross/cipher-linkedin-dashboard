// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../src/components/conversation/MessageBubble'
import { ConversationThread } from '../src/components/conversation/ConversationThread'
import type { ReplyThreadMessage } from '../src/lib/replyReview'

const key = { instance_id: 'one', profile_url: 'https://linkedin.com/in/a', campaign_id: null }
const message = (id: number, direction: string, sent_at: string, extra: Partial<ReplyThreadMessage> = {}): ReplyThreadMessage =>
  ({ ...key, id, direction, body: `body ${id}`, sent_at, review: null, ...extra })

describe('MessageBubble', () => {
  afterEach(cleanup)

  it('is visual only: no control of its own, so a drawer can put its editor beside it', () => {
    const { container } = render(<MessageBubble direction="out" body="Hello" title="21 Sept, 14:00 · Madrid time" />)
    expect(container.querySelectorAll('button, a, input, textarea, select, [tabindex]')).toHaveLength(0)
    const bubble = container.firstElementChild as HTMLElement
    expect(bubble.className).toContain('message-bubble--out')
    expect(bubble.className).toContain('message-bubble--tail')
    expect(bubble.title).toBe('21 Sept, 14:00 · Madrid time')
  })
})

describe('ConversationThread grouping', () => {
  afterEach(cleanup)

  const messages = [
    message(1, 'out', '2026-09-19T15:52:00.000Z'),
    message(2, 'out', '2026-09-19T15:53:00.000Z'),
    message(3, 'in', '2026-09-20T21:55:00.000Z'),
    message(4, 'in', '2026-09-20T22:10:00.000Z'),
    message(5, 'out', '2026-09-21T09:00:00.000Z', { source: 'manual' }),
  ]

  it('draws one time per group but keeps every message selectable with its exact time', () => {
    const onSelect = vi.fn()
    const { container } = render(<ConversationThread messages={messages} selectedMessageId={4} onSelectMessage={onSelect} />)
    // 1+2 are one run; 3 and 4 straddle Madrid midnight, so they are two groups.
    expect(container.querySelectorAll('.replies-group')).toHaveLength(4)
    expect(container.querySelectorAll('.replies-group-time')).toHaveLength(4)
    const buttons = screen.getAllByRole('button', { name: /message/ })
    expect(buttons).toHaveLength(5)
    expect(buttons[1].getAttribute('aria-label')).toBe('Outbound message 19 Sept, 17:53 · Madrid time')
    expect(buttons[3].getAttribute('aria-pressed')).toBe('true')
    // Only the last bubble of a group points at its sender.
    expect(buttons[0].querySelector('.message-bubble--tail')).toBeNull()
    expect(buttons[1].querySelector('.message-bubble--tail')).not.toBeNull()
    fireEvent.click(buttons[0])
    expect(onSelect).toHaveBeenCalledWith(messages[0])
  })

  it('starts a day separator at the Madrid day boundary and marks imported messages', () => {
    const { container } = render(<ConversationThread messages={messages} selectedMessageId={null} onSelectMessage={() => {}} />)
    expect(container.querySelectorAll('.replies-day')).toHaveLength(3)
    expect(screen.getByRole('button', { name: /imported/ })).toBeTruthy()
    expect(screen.getByText('Imported')).toBeTruthy()
    expect(screen.getAllByText('Unreviewed')).toHaveLength(2)
  })
})
