import { useRef } from 'react'
import type { ReactNode } from 'react'

/**
 * `Tabs` switches which section of a page you are looking at; `SegmentedControl`
 * switches a mode or a period *within* one section. They look different on
 * purpose — the audit found four different selected-state idioms doing both jobs
 * interchangeably.
 *
 * Both follow the APG keyboard pattern: arrows move between options, Home/End
 * jump to the ends, and the selected option is the only tab stop.
 */

export interface TabItem<T extends string> {
  id: T
  label: ReactNode
  count?: number
  disabled?: boolean
}

function useRovingKeys<T extends string>(
  items: TabItem<T>[],
  value: T,
  onChange: (value: T) => void,
) {
  const listRef = useRef<HTMLDivElement>(null)
  const enabled = items.filter((item) => !item.disabled)

  return {
    listRef,
    onKeyDown(event: React.KeyboardEvent) {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
      if (!keys.includes(event.key)) return
      event.preventDefault()
      const index = enabled.findIndex((item) => item.id === value)
      let next = index
      if (event.key === 'ArrowLeft') next = (index - 1 + enabled.length) % enabled.length
      if (event.key === 'ArrowRight') next = (index + 1) % enabled.length
      if (event.key === 'Home') next = 0
      if (event.key === 'End') next = enabled.length - 1
      const target = enabled[next]
      if (!target) return
      onChange(target.id)
      requestAnimationFrame(() => {
        listRef.current
          ?.querySelector<HTMLElement>(`[data-option="${CSS.escape(target.id)}"]`)
          ?.focus()
      })
    },
  }
}

export function Tabs<T extends string>({
  label, items, value, onChange, className = '',
}: {
  label: string
  items: TabItem<T>[]
  value: T
  onChange: (value: T) => void
  className?: string
}) {
  const { listRef, onKeyDown } = useRovingKeys(items, value, onChange)
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className={`ui-tabs ${className}`.trim()}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          data-option={item.id}
          className="ui-tab"
          aria-selected={item.id === value}
          tabIndex={item.id === value ? 0 : -1}
          disabled={item.disabled}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count != null && <span className="ui-tab__count">{item.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function SegmentedControl<T extends string>({
  label, items, value, onChange, className = '',
}: {
  label: string
  items: TabItem<T>[]
  value: T
  onChange: (value: T) => void
  className?: string
}) {
  const { listRef, onKeyDown } = useRovingKeys(items, value, onChange)
  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label={label}
      className={`ui-segmented ${className}`.trim()}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          data-option={item.id}
          className="ui-segmented__item"
          aria-checked={item.id === value}
          tabIndex={item.id === value ? 0 : -1}
          disabled={item.disabled}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count != null && <span className="ui-segmented__count">{item.count}</span>}
        </button>
      ))}
    </div>
  )
}
