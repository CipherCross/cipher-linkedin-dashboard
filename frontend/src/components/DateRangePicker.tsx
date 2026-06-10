import { useEffect, useRef, useState } from 'react'
import type { DateRange } from '../lib/leads'

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`
const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate()
// Monday-first index (0..6) of the 1st of the month.
const firstWeekday = (y: number, m: number) => (new Date(y, m, 1).getDay() + 6) % 7
const ddmmyyyy = (day: string) => {
  const [y, m, d] = day.split('-')
  return `${d}.${m}.${y}`
}

/** Display text for the trigger button. */
export function rangeButtonLabel(r: DateRange): string {
  if (r.id !== 'custom') return r.label
  if (r.from && r.to) return `${ddmmyyyy(r.from)} – ${ddmmyyyy(r.to)}`
  if (r.from) return `since ${ddmmyyyy(r.from)}`
  if (r.to) return `until ${ddmmyyyy(r.to)}`
  return 'Custom range'
}

function customRange(from: string, to: string): DateRange {
  const label = `${ddmmyyyy(from)} – ${ddmmyyyy(to)}`
  return { id: 'custom', label, from, to }
}

interface Props {
  presets: DateRange[]
  value: DateRange
  onChange: (r: DateRange) => void
}

export function DateRangePicker({ presets, value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [draftStart, setDraftStart] = useState<string | null>(value.from)
  const [draftEnd, setDraftEnd] = useState<string | null>(value.to)
  const now = new Date()
  const [viewY, setViewY] = useState(now.getFullYear())
  const [viewM, setViewM] = useState(now.getMonth())
  const wrap = useRef<HTMLDivElement>(null)

  // Sync the calendar selection from the active range whenever we open.
  useEffect(() => {
    if (!open) return
    setDraftStart(value.from)
    setDraftEnd(value.to)
    const anchor = value.from ?? value.to
    if (anchor) {
      setViewY(Number(anchor.slice(0, 4)))
      setViewM(Number(anchor.slice(5, 7)) - 1)
    }
  }, [open, value])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const pickPreset = (p: DateRange) => {
    onChange(p)
    setOpen(false)
  }

  const clickDay = (day: string) => {
    if (!draftStart || draftEnd) {
      setDraftStart(day)
      setDraftEnd(null)
      return
    }
    const [from, to] = day < draftStart ? [day, draftStart] : [draftStart, day]
    setDraftStart(from)
    setDraftEnd(to)
    onChange(customRange(from, to))
    setOpen(false)
  }

  const shiftMonth = (delta: number) => {
    const m = viewM + delta
    setViewY(viewY + Math.floor(m / 12))
    setViewM(((m % 12) + 12) % 12)
  }

  return (
    <div className="drp" ref={wrap}>
      <button className="drp-trigger" onClick={() => setOpen((o) => !o)}>
        <span className="drp-cal-icon" aria-hidden>▦</span>
        {rangeButtonLabel(value)}
        <span className="drp-caret" aria-hidden>▾</span>
      </button>

      {open && (
        <div className="drp-pop">
          <ul className="drp-presets">
            {presets.map((p) => (
              <li key={p.id}>
                <button
                  className={value.id === p.id ? 'active' : ''}
                  onClick={() => pickPreset(p)}
                >
                  {p.label}
                </button>
              </li>
            ))}
          </ul>

          <div className="drp-cal">
            <div className="drp-cal-head">
              <button className="drp-nav" onClick={() => shiftMonth(-1)} aria-label="Previous month">‹</button>
              <span>{MONTHS[viewM]} {viewY}</span>
              <button className="drp-nav" onClick={() => shiftMonth(1)} aria-label="Next month">›</button>
            </div>
            <div className="drp-grid">
              {WEEKDAYS.map((w) => (
                <span key={w} className="drp-wd">{w}</span>
              ))}
              {Array.from({ length: firstWeekday(viewY, viewM) }).map((_, i) => (
                <span key={`b${i}`} />
              ))}
              {Array.from({ length: daysInMonth(viewY, viewM) }).map((_, i) => {
                const d = i + 1
                const day = ymd(viewY, viewM, d)
                const isStart = day === draftStart
                const isEnd = day === draftEnd
                const inRange =
                  draftStart && draftEnd && day > draftStart && day < draftEnd
                const cls = [
                  'drp-day',
                  isStart || isEnd ? 'edge' : '',
                  inRange ? 'between' : '',
                ].filter(Boolean).join(' ')
                return (
                  <button key={day} className={cls} onClick={() => clickDay(day)}>
                    {d}
                  </button>
                )
              })}
            </div>
            <div className="drp-hint muted small">
              {draftStart && !draftEnd
                ? 'Pick an end date'
                : 'Click a start then an end date for a custom range'}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
