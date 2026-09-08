// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DateRangePicker } from '../src/components/DateRangePicker'
import type { DateRange } from '../src/lib/leads'

const range: DateRange = { id: 'last-7-days', label: 'Last 7 days', from: '2026-09-01', to: '2026-09-07' }
const presets: DateRange[] = [range, { id: 'all-time', label: 'All time', from: null, to: null }]

afterEach(() => cleanup())

function paint(count = 1, onChange = vi.fn()) {
  return render(
    <>
      {Array.from({ length: count }, (_, index) => (
        <DateRangePicker key={index} presets={presets} value={range} onChange={onChange} ariaLabel={`Picker ${index + 1}`} />
      ))}
    </>,
  )
}

describe('DateRangePicker accessibility', () => {
  it('exposes an expanded dialog relationship and unique popup ids', () => {
    paint(2)
    const triggers = screen.getAllByRole('button', { name: /Picker/ })
    expect(triggers[0].getAttribute('aria-haspopup')).toBe('dialog')
    expect(triggers[0].getAttribute('aria-expanded')).toBe('false')
    expect(triggers[0].getAttribute('aria-controls')).toBeTruthy()
    expect(triggers[0].getAttribute('aria-controls')).not.toBe(triggers[1].getAttribute('aria-controls'))

    fireEvent.click(triggers[0])
    expect(triggers[0].getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('dialog', { name: 'Picker 1 calendar' })).toBeTruthy()
    expect((document.activeElement as HTMLElement).getAttribute('data-day')).toBe('1')
  })

  it('restores trigger focus when Escape closes the popup', () => {
    paint()
    const trigger = screen.getByRole('button', { name: 'Picker 1' })
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('restores trigger focus after selecting a preset', () => {
    const onChange = vi.fn()
    paint(1, onChange)
    const trigger = screen.getByRole('button', { name: 'Picker 1' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'All time' }))
    expect(onChange).toHaveBeenCalledWith(presets[1])
    expect(document.activeElement).toBe(trigger)
  })
})
