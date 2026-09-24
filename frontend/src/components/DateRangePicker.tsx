import { useMemo, useState } from 'react'
import { Calendar as CalendarIcon, ChevronDown } from 'lucide-react'
import type { DateRange } from '../lib/leads'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Calendar } from './ui/calendar'
import { Button } from '../ui'

/**
 * A preset list beside a two-month calendar, in a popover.
 *
 * Positioning, collision handling, Escape, outside press and returning focus to
 * the trigger are Base UI's through `Popover` — this component used to carry
 * its own copy of all of it, including a hand-written `positionPopup` that
 * measured the viewport twice per open. The month grid, its roving arrow-key
 * focus and range selection are `react-day-picker`.
 *
 * **Dates stay local-calendar strings.** A `DateRange`'s `from`/`to` are
 * `YYYY-MM-DD` as the operator sees them, and `toISOString()` would shift them
 * a day for anyone west of UTC. Conversion goes through `ymd`/`toDate` below,
 * which read and write local components only.
 */

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const toDate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
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

  const selected = useMemo(
    () => ({
      from: value.from ? toDate(value.from) : undefined,
      to: value.to ? toDate(value.to) : undefined,
    }),
    [value.from, value.to],
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="secondary"
            aria-label={ariaLabel}
            className="font-normal"
            icon={<CalendarIcon className="text-app-text-muted" size={16} aria-hidden />}
          >
            {rangeButtonLabel(value)}
            <ChevronDown className="text-app-text-muted" size={16} aria-hidden />
          </Button>
        }
      />
      <PopoverContent aria-label={`${ariaLabel} calendar`} className="w-auto max-w-[min(520px,calc(100vw-32px))] flex flex-row items-start gap-app-md p-app-md">
        <ul className="shrink-0 list-none m-0 p-app-sm border-r border-app-border flex flex-col gap-0.5 min-w-[132px]">
          {presets.map((p) => (
            <li key={p.id}>
              <Button
                variant="ghost"
                size="sm"
                block
                aria-pressed={value.id === p.id}
                className="justify-start font-normal whitespace-nowrap aria-pressed:bg-app-accent-subtle aria-pressed:text-app-accent aria-pressed:font-semibold"
                onClick={() => { onChange(p); setOpen(false) }}
              >
                {p.label}
              </Button>
            </li>
          ))}
        </ul>
        <Calendar
          mode="range"
          numberOfMonths={1}
          defaultMonth={selected.from}
          selected={selected.from ? selected : undefined}
          onSelect={(range) => {
            // Only commit once both ends exist: a single click is the start of
            // a range, not a one-day range.
            if (!range?.from || !range?.to) return
            onChange(customRange(ymd(range.from), ymd(range.to)))
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
