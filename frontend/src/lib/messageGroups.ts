import { replyDateKey } from './replyTime'

/**
 * Consecutive messages that read as one turn in a chat.
 *
 * A run of messages from the same side, each within `GROUP_WINDOW_MS` of the
 * one before it and on the same Madrid calendar day, is one group: the thread
 * spaces groups apart, draws one time under the last bubble, and keeps every
 * message individually selectable. A day boundary always starts a new group,
 * so a day separator never lands inside a run.
 */
export const GROUP_WINDOW_MS = 10 * 60 * 1000

export interface GroupableMessage {
  id: number
  direction: string
  sent_at: string
}

export interface MessageGroup<M extends GroupableMessage> {
  /** The first message's id — stable while older pages are prepended elsewhere. */
  key: number
  direction: 'in' | 'out'
  /** The Madrid calendar day (`YYYY-MM-DD`) all messages of the group share. */
  day: string
  /** True when this group opens a new day in the thread. */
  startsDay: boolean
  messages: M[]
}

export function messageDirection(direction: string): 'in' | 'out' {
  return direction === 'in' ? 'in' : 'out'
}

export function groupMessages<M extends GroupableMessage>(messages: readonly M[]): MessageGroup<M>[] {
  const groups: MessageGroup<M>[] = []
  let previousDay: string | null = null
  for (const message of messages) {
    const direction = messageDirection(message.direction)
    const day = replyDateKey(message.sent_at)
    const current = groups[groups.length - 1]
    const last = current?.messages[current.messages.length - 1]
    const gap = last ? new Date(message.sent_at).getTime() - new Date(last.sent_at).getTime() : Infinity
    if (current && current.direction === direction && current.day === day && gap >= 0 && gap < GROUP_WINDOW_MS) {
      current.messages.push(message)
    } else {
      groups.push({ key: message.id, direction, day, startsDay: day !== previousDay, messages: [message] })
    }
    previousDay = day
  }
  return groups
}
