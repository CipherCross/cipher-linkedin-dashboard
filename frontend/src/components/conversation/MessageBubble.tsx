import type { ReactNode } from 'react'

/**
 * One chat bubble — the look only.
 *
 * Outbound is filled accent with white text on the right, inbound is a quiet
 * grey on the left, and the corner on the sender's side is squared off on the
 * last bubble of a group. It renders no control of its own: Replies wraps it in
 * the selection button that picks a message for review, and the conversation
 * drawer puts its editor and edit/delete controls beside it, so an interactive
 * element never ends up inside another.
 */
export function MessageBubble({
  direction, body, tail = true, title, children, className = '',
}: {
  direction: 'in' | 'out'
  body?: string | null
  /** The last bubble of a group points at its sender. */
  tail?: boolean
  /** The exact send time, available on hover for every bubble in a group. */
  title?: string
  /** Extra content inside the bubble, e.g. the drawer's inline editor. */
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      className={['message-bubble', `message-bubble--${direction}`, tail ? 'message-bubble--tail' : '', className].filter(Boolean).join(' ')}
      title={title}
    >
      {body !== undefined && <span className="message-bubble__body">{body || '—'}</span>}
      {children}
    </div>
  )
}
