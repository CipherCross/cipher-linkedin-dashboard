import { useState } from 'react'
import { X } from 'lucide-react'

/** Tag-style input for a string array — Enter or comma adds, backspace on an
 *  empty input removes the last chip. Shared by the Search Library and the ICP
 *  editor (keyword lists, job titles, features, …). */
export function ChipInput({
  values,
  onChange,
  placeholder,
  variant = 'include',
}: {
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  variant?: 'include' | 'exclude'
}) {
  const [text, setText] = useState('')
  const add = (raw: string) => {
    const t = raw.trim()
    if (!t) return
    if (!values.includes(t)) onChange([...values, t])
    setText('')
  }
  return (
    <div className="chip-input">
      {values.map((v) => (
        <span className={`chip ${variant}`} key={v}>
          {variant === 'exclude' ? '−' : ''}
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={text}
        placeholder={values.length === 0 ? placeholder : ''}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add(text)
          } else if (e.key === 'Backspace' && text === '' && values.length > 0) {
            onChange(values.slice(0, -1))
          }
        }}
        onBlur={() => add(text)}
      />
    </div>
  )
}
