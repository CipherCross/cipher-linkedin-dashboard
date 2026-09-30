import { describe, expect, it } from 'vitest'
import { GROUP_WINDOW_MS, groupMessages } from '../src/lib/messageGroups'

const at = (id: number, direction: string, sent_at: string) => ({ id, direction, sent_at })
const shape = (messages: ReturnType<typeof at>[]) =>
  groupMessages(messages).map((group) => ({ direction: group.direction, day: group.day, startsDay: group.startsDay, ids: group.messages.map(({ id }) => id) }))

describe('groupMessages', () => {
  it('joins a same-side run inside the window and splits at the window edge', () => {
    const start = Date.UTC(2026, 8, 21, 9, 0)
    const iso = (offset: number) => new Date(start + offset).toISOString()
    expect(shape([
      at(1, 'out', iso(0)),
      at(2, 'out', iso(GROUP_WINDOW_MS - 1)),
      at(3, 'out', iso(2 * GROUP_WINDOW_MS - 2)),
      at(4, 'out', iso(3 * GROUP_WINDOW_MS - 2)), // exactly one window after #3: new group
    ]).map(({ ids }) => ids)).toEqual([[1, 2, 3], [4]])
  })

  it('splits whenever the side changes', () => {
    expect(shape([
      at(1, 'in', '2026-09-21T09:00:00Z'),
      at(2, 'out', '2026-09-21T09:01:00Z'),
      at(3, 'in', '2026-09-21T09:02:00Z'),
    ]).map(({ direction, ids }) => [direction, ids])).toEqual([['in', [1]], ['out', [2]], ['in', [3]]])
  })

  it('treats every non-inbound direction as outbound', () => {
    expect(shape([at(1, 'outbound', '2026-09-21T09:00:00Z'), at(2, 'out', '2026-09-21T09:01:00Z')])).toEqual([
      { direction: 'out', day: '2026-09-21', startsDay: true, ids: [1, 2] },
    ])
  })

  it('breaks a run at Madrid midnight, not UTC midnight', () => {
    // 21:55Z and 22:01Z on 20 Sep are 23:55 and 00:01 in Madrid (CEST, UTC+2):
    // six minutes apart, but two Madrid days.
    expect(shape([
      at(1, 'in', '2026-09-20T21:50:00Z'),
      at(2, 'in', '2026-09-20T21:55:00.000Z'),
      at(3, 'in', '2026-09-20T22:01:00.000Z'),
    ])).toEqual([
      { direction: 'in', day: '2026-09-20', startsDay: true, ids: [1, 2] },
      { direction: 'in', day: '2026-09-21', startsDay: true, ids: [3] },
    ])
    // And 23:30Z → 00:05Z UTC stays one Madrid day (01:30 → 02:05).
    expect(shape([at(4, 'out', '2026-09-20T23:30:00Z'), at(5, 'out', '2026-09-20T23:35:00Z')]).map(({ ids }) => ids)).toEqual([[4, 5]])
  })

  it('uses the winter offset after the DST change', () => {
    // 25 Oct 2026 is the switch to CET (UTC+1): 22:55Z is 23:55 and 23:05Z is 00:05.
    expect(shape([at(1, 'in', '2026-10-25T22:55:00Z'), at(2, 'in', '2026-10-25T23:05:00Z')]).map(({ day }) => day))
      .toEqual(['2026-10-25', '2026-10-26'])
  })

  it('never joins a message that is out of time order', () => {
    expect(shape([at(1, 'in', '2026-09-21T09:05:00Z'), at(2, 'in', '2026-09-21T09:00:00Z')]).map(({ ids }) => ids)).toEqual([[1], [2]])
  })
})
