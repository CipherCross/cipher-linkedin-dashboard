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
  // The half-picked range between the first and second click. react-day-picker's
  // own range logic can't be used for this: with `min` 0 its first click
  // returns a complete one-day range, and a click on an existing range extends
  // it instead of starting over.
  const [draft, setDraft] = useState<Date | null>(null)

  const onOpenChange = (next: boolean) => {
    setDraft(null)
    setOpen(next)
  }

  const onDayClick = (day: Date) => {
    if (!draft) { setDraft(day); return }
    const [from, to] = day < draft ? [day, draft] : [draft, day]
    onChange(customRange(ymd(from), ymd(to)))
    onOpenChange(false)
  }

  const selected = useMemo(
    () => ({
      from: value.from ? toDate(value.from) : undefined,
      to: value.to ? toDate(value.to) : undefined,
    }),
    [value.from, value.to],
  )

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant="secondary"
            aria-label={ariaLabel}
            className="font-normal"
            icon={<CalendarIcon className="text-app-text-muted" aria-hidden />}
          >
            {rangeButtonLabel(value)}
            <ChevronDown className="text-app-text-muted" size={16} aria-hidden />
          </Button>
        }
      />
      <PopoverContent
        aria-label={`${ariaLabel} calendar`}
        align="end"
        className="w-auto max-w-[calc(100vw-32px)] flex flex-row items-stretch gap-0 p-0 overflow-hidden rounded-card border border-app-border ring-0 shadow-lg"
      >
        <ul className="shrink-0 list-none m-0 p-app-xs bg-app-surface-2 border-r border-app-border flex flex-col gap-px min-w-[120px]">
          {presets.map((p) => (
            <li key={p.id}>
              <Button
                variant="ghost"
                size="sm"
                block
                aria-pressed={value.id === p.id}
                className="justify-start font-normal text-app-text-secondary whitespace-nowrap hover:bg-app-surface-3 hover:text-app-text aria-pressed:bg-app-surface aria-pressed:text-app-accent aria-pressed:font-semibold aria-pressed:shadow-sm"
                onClick={() => { onChange(p); onOpenChange(false) }}
              >
                {p.label}
              </Button>
            </li>
          ))}
        </ul>
        <Calendar
          className="p-app-sm"
          mode="range"
          numberOfMonths={1}
          defaultMonth={selected.from}
          selected={draft ? { from: draft, to: draft } : selected.from ? selected : undefined}
          onSelect={() => {}}
          onDayClick={onDayClick}
        />
      </PopoverContent>
    </Popover>
  )
}
