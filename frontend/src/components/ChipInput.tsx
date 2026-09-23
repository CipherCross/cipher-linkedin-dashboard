import { useState } from 'react'
import type { ReactNode } from 'react'
import { Field } from '../ui/Field'
import { Chip } from './library'

/** Tag-style input for a string array — Enter or comma adds, backspace on an
 *  empty input removes the last chip. Shared by the Search Library and the ICP
 *  and Hypothesis editors (keyword lists, job titles, features, …).
 *
 *  Pass `label` and it renders as a labelled `Field`, the text box carrying the
 *  field's id; without one the caller supplies the label. */
export function ChipInput({
  values,
  onChange,
  placeholder,
  variant = 'include',
  label,
  labelHidden,
  help,
}: {
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  variant?: 'include' | 'exclude'
  label?: ReactNode
  labelHidden?: boolean
  help?: ReactNode
}) {
  const [text, setText] = useState('')
  const add = (raw: string) => {
    const t = raw.trim()
    if (!t) return
    if (!values.includes(t)) onChange([...values, t])
    setText('')
  }
  const box = (inputProps: { id?: string; 'aria-describedby'?: string }) => (
    <div className="flex flex-wrap items-center gap-1.5 min-h-control p-1.5 rounded-control border border-app-border-strong bg-app-surface focus-within:outline-2 focus-within:outline-app-accent focus-within:outline-offset-1">
      {values.map((v) => (
        <Chip key={v} tone={variant} onRemove={() => onChange(values.filter((x) => x !== v))} removeLabel={`Remove ${v}`}>
          {v}
        </Chip>
      ))}
      {/* ui-exception(chip-input-entry): the text box inside a tag field; the
          field frame above is the visible control. verify: Enter/comma adds,
          Backspace removes, label focuses it. */}
      <input
        {...inputProps}
        className="flex-1 min-w-[120px] border-0 bg-transparent px-1 py-0.5 text-app-text focus:outline-none"
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
  if (label == null) return box({})
  return (
    <Field label={label} labelHidden={labelHidden} help={help}>
      {({ id, 'aria-describedby': describedBy }) => box({ id, 'aria-describedby': describedBy })}
    </Field>
  )
}
