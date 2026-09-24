// @vitest-environment jsdom
/**
 * The date range picker's contract, after it moved onto Base UI's Popover and
 * react-day-picker.
 *
 * What is asserted is the contract, not the implementation: a trigger that
 * announces a dialog, a named dialog containing a date grid, Escape returning
 * focus to the trigger, and a preset committing and closing. The previous
 * version of this file pinned `data-day="1"` and an exact initial focus
 * target, which described the hand-rolled grid rather than the promise it kept.
 *
 * The timezone test is new and is the one worth keeping most: `DateRange`
 * carries `YYYY-MM-DD` as the operator reads it, and a single `toISOString()`
 * anywhere in the conversion shifts every range a day for anyone west of UTC.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DateRangePicker, rangeButtonLabel } from '../src/components/DateRangePicker'
import type { DateRange } from '../src/lib/leads'

const range: DateRange = { id: 'last-7-days', label: 'Last 7 days', from: '2026-09-01', to: '2026-09-07' }
const presets: DateRange[] = [range, { id: 'all-time', label: 'All time', from: null, to: null }]

afterEach(() => cleanup())

function paint(count = 1, onChange = vi.fn()) {
  return render(
    <>
      {Array.from({ length: count }, (_, i) => (
        <DateRangePicker key={i} presets={presets} value={range} onChange={onChange} ariaLabel={`Picker ${i + 1}`} />
      ))}
    </>,
  )
}

/** Base UI queues focus work through a frame; flush it before asserting. */
const settle = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))) })

describe('DateRangePicker accessibility', () => {
  it('announces a dialog and opens one that is named and contains a date grid', async () => {
    paint()
    const trigger = screen.getByRole('button', { name: 'Picker 1' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    await settle()

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const dialog = screen.getByRole('dialog', { name: 'Picker 1 calendar' })
    // The trigger points at the dialog it opened.
    expect(trigger.getAttribute('aria-controls')).toBe(dialog.getAttribute('id'))
    expect(within(dialog).getByRole('grid')).toBeTruthy()
  })

  it('gives each instance its own dialog', async () => {
    paint(2)
    const [first, second] = screen.getAllByRole('button', { name: /^Picker \d$/ })
    fireEvent.click(first)
    await settle()
    const firstId = first.getAttribute('aria-controls')
    fireEvent.keyDown(document, { key: 'Escape' })
    await settle()
    fireEvent.click(second)
    await settle()
    expect(second.getAttribute('aria-controls')).toBeTruthy()
    expect(second.getAttribute('aria-controls')).not.toBe(firstId)
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    paint()
    const trigger = screen.getByRole('button', { name: 'Picker 1' })
    trigger.focus()
    fireEvent.click(trigger)
    await settle()
    fireEvent.keyDown(document, { key: 'Escape' })
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('commits a preset and closes', async () => {
    const onChange = vi.fn()
    paint(1, onChange)
    const trigger = screen.getByRole('button', { name: 'Picker 1' })
    fireEvent.click(trigger)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'All time' }))
    await settle()
    expect(onChange).toHaveBeenCalledWith(presets[1])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('waits for the second day before committing a custom range', async () => {
    const onChange = vi.fn()
    paint(1, onChange)
    fireEvent.click(screen.getByRole('button', { name: 'Picker 1' }))
    await settle()
    const dialog = screen.getByRole('dialog')
    const day = (n: number) => within(dialog).getAllByRole('button').find((b) => b.textContent === String(n) && !b.closest('[data-outside]'))!
    // Picked end first: the range is ordered, not rejected.
    fireEvent.click(day(12))
    await settle()
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(day(3))
    await settle()
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'custom', from: '2026-09-03', to: '2026-09-12' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('date conversion', () => {
  it('never shifts a day across the UTC boundary', () => {
    // `2026-09-01` must read back as the 1st, not the 31st, for a viewer west
    // of UTC. This is what `toISOString()` would break.
    expect(rangeButtonLabel({ id: 'custom', label: '', from: '2026-09-01', to: '2026-09-07' }))
      .toBe('01.09.2026 – 07.09.2026')
  })

  it('leaves a named preset’s own label alone', () => {
    expect(rangeButtonLabel(range)).toBe('Last 7 days')
  })
})
