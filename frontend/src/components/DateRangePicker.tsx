import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Calendar, ChevronDown } from 'lucide-react'
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
  ariaLabel?: string
}

export function DateRangePicker({ presets, value, onChange, ariaLabel = 'Date range' }: Props) {
  const [open, setOpen] = useState(false)
  const [popupStyle, setPopupStyle] = useState<CSSProperties>({})
  const [draftStart, setDraftStart] = useState<string | null>(value.from)
  const [draftEnd, setDraftEnd] = useState<string | null>(value.to)
  const now = new Date()
  const [viewY, setViewY] = useState(now.getFullYear())
  const [viewM, setViewM] = useState(now.getMonth())
  const wrap = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const reactId = useId()
  const popupId = `date-range-popup-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  const closePicker = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  const positionPopup = useCallback(() => {
    const trigger = triggerRef.current
    const popup = popupRef.current
    const wrapper = wrap.current
    if (!trigger || !popup || !wrapper) return
    const triggerRect = trigger.getBoundingClientRect()
    const wrapperRect = wrapper.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const gap = 6
    const availableHorizontal = Math.max(180, Math.min(390, viewportWidth - 24))
    // Apply the horizontal constraint before measuring height: the preset
    // list/calendar reflow at narrow widths and changes the popup's natural
    // height. The wrapper is intentionally not a viewport-sized positioning
    // context, so the offset may be negative when it must align to the window.
    popup.style.width = `${availableHorizontal}px`
    popup.style.maxWidth = `${availableHorizontal}px`
    popup.style.maxHeight = 'none'
    const naturalHeight = popup.scrollHeight
    const popupHeight = Math.min(Math.max(120, naturalHeight), Math.max(120, viewportHeight - 24))
    const belowTop = triggerRect.bottom + gap
    const aboveTop = triggerRect.top - gap - popupHeight
    const desiredTop = belowTop + popupHeight <= viewportHeight - 12 ? belowTop : aboveTop
    const viewportTop = Math.max(12, Math.min(desiredTop, viewportHeight - popupHeight - 12))
    const viewportLeft = Math.max(12, Math.min(triggerRect.left, viewportWidth - availableHorizontal - 12))
    const relativeLeft = viewportLeft - wrapperRect.left
    const relativeTop = viewportTop - wrapperRect.top
    const style: CSSProperties = {
      width: `${availableHorizontal}px`,
      maxWidth: `${availableHorizontal}px`,
      maxHeight: `${popupHeight}px`,
      top: `${relativeTop}px`,
      bottom: 'auto',
      left: `${relativeLeft}px`,
      right: 'auto',
      overflow: 'auto',
    }
    setPopupStyle(style)
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const entry = popupRef.current?.querySelector<HTMLElement>('[tabindex="0"]:not(:disabled)')
      ?? popupRef.current?.querySelector<HTMLElement>('button:not(:disabled)')
    entry?.focus()
    positionPopup()
    window.addEventListener('resize', positionPopup)
    window.addEventListener('scroll', positionPopup, true)
    return () => {
      window.removeEventListener('resize', positionPopup)
      window.removeEventListener('scroll', positionPopup, true)
    }
  }, [open, positionPopup])

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
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closePicker()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [closePicker, open])

  // Today as a UTC day-string, so future days are disabled by string compare
  // (matching the UTC day-slices used everywhere else — no local-tz drift).
  const todayStr = new Date().toISOString().slice(0, 10)
  const gridRef = useRef<HTMLDivElement>(null)
  const [focusedDay, setFocusedDay] = useState(1)

  // Build rows of 7 cells each for the ARIA grid. null = blank spacer.
  const blanks = firstWeekday(viewY, viewM)
  const days = daysInMonth(viewY, viewM)
  const totalCells = blanks + days
  const rows: (number | null)[][] = []
  for (let i = 0; i < totalCells; i += 7) {
    const row: (number | null)[] = []
    for (let j = i; j < i + 7; j++) {
      row.push(j < blanks ? null : j - blanks + 1 <= days ? j - blanks + 1 : null)
    }
    rows.push(row)
  }
  // Pad last row to 7 cells if needed.
  if (rows.length > 0) {
    const last = rows[rows.length - 1]
    while (last.length < 7) last.push(null)
  }

  // Clamp focusedDay when month changes.
  const clampedFocus = Math.min(focusedDay, days)

  const focusDayButton = useCallback((d: number) => {
    setFocusedDay(d)
    const el = gridRef.current?.querySelector(`[data-day="${d}"]`) as HTMLElement | null
    el?.focus()
  }, [])

  const onGridKeyDown = useCallback((e: ReactKeyboardEvent) => {
    const d = clampedFocus
    let next: number | null = null
    switch (e.key) {
      case 'ArrowRight': next = d < days ? d + 1 : null; break
      case 'ArrowLeft': next = d > 1 ? d - 1 : null; break
      case 'ArrowDown': next = d + 7 <= days ? d + 7 : null; break
      case 'ArrowUp': next = d - 7 >= 1 ? d - 7 : null; break
      case 'Home': next = 1; break
      case 'End': next = days; break
      default: return
    }
    if (next != null) {
      e.preventDefault()
      focusDayButton(next)
    }
  }, [clampedFocus, days, focusDayButton])

  const pickPreset = (p: DateRange) => {
    onChange(p)
    closePicker()
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
    closePicker()
  }

  const shiftMonth = (delta: number) => {
    const m = viewM + delta
    setViewY(viewY + Math.floor(m / 12))
    setViewM(((m % 12) + 12) % 12)
  }

  return (
    <div className="drp" ref={wrap}>
      <button
        ref={triggerRef}
        className="drp-trigger"
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popupId}
        onClick={() => {
          if (open) closePicker()
          else setOpen(true)
        }}
      >
        <Calendar className="drp-cal-icon" size={14} aria-hidden />
        {rangeButtonLabel(value)}
        <ChevronDown className="drp-caret" size={14} aria-hidden />
      </button>

      {open && (
        <div ref={popupRef} id={popupId} className="drp-pop" role="dialog" aria-label={`${ariaLabel} calendar`} style={popupStyle}>
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
            <div className="drp-grid" role="grid" aria-label="Choose date" ref={gridRef} onKeyDown={onGridKeyDown}>
              <div role="row" className="drp-wd-row">
                {WEEKDAYS.map((w) => (
                  <span key={w} role="columnheader" className="drp-wd">{w}</span>
                ))}
              </div>
              {rows.map((row, ri) => (
                <div role="row" className="drp-wd-row" key={ri}>
                  {row.map((d, ci) => {
                    if (d == null) {
                      return <span key={`b${ri}-${ci}`} role="gridcell" aria-disabled="true" />
                    }
                    const day = ymd(viewY, viewM, d)
                    const isStart = day === draftStart
                    const isEnd = day === draftEnd
                    const inRange =
                      draftStart && draftEnd && day > draftStart && day < draftEnd
                    const future = day > todayStr
                    const cls = [
                      'drp-day',
                      isStart || isEnd ? 'edge' : '',
                      inRange ? 'between' : '',
                      future ? 'disabled' : '',
                    ].filter(Boolean).join(' ')
                    return (
                      <button
                        key={day}
                        role="gridcell"
                        data-day={d}
                        className={cls}
                        disabled={future}
                        tabIndex={d === clampedFocus ? 0 : -1}
                        onClick={() => clickDay(day)}
                        onFocus={() => setFocusedDay(d)}
                      >
                        {d}
                      </button>
                    )
                  })}
                </div>
              ))}
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
