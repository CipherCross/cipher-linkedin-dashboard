import { forwardRef, useId } from 'react'
import type {
  InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes,
} from 'react'
import { CircleAlert } from 'lucide-react'

/**
 * Form controls with a visible label, wired help/error ids, and one height.
 *
 * An error is never signalled by colour alone (WCAG 1.4.1): the message is text
 * and carries an icon, and the control is marked `aria-invalid`.
 */

interface FieldShellProps {
  label: ReactNode
  /** Hide the label visually but keep it for assistive tech. Use sparingly. */
  labelHidden?: boolean
  help?: ReactNode
  error?: ReactNode
  required?: boolean
  className?: string
}

interface RenderArgs {
  id: string
  'aria-describedby': string | undefined
  'aria-invalid': true | undefined
  required: boolean | undefined
}

export function Field({
  label, labelHidden, help, error, required, className = '', children,
}: FieldShellProps & { children: (args: RenderArgs) => ReactNode }) {
  const id = useId()
  const helpId = help ? `${id}-help` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className={`ui-field ${className}`.trim()}>
      <label className={labelHidden ? 'sr-only' : 'ui-field__label'} htmlFor={id}>
        {label}
        {required && <span className="ui-field__required" aria-hidden="true">*</span>}
      </label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        required: required || undefined,
      })}
      {help && <span className="ui-field__help" id={helpId}>{help}</span>}
      {error && (
        <span className="ui-field__error" id={errorId}>
          <CircleAlert size={14} aria-hidden="true" />
          {error}
        </span>
      )}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...rest }, ref) {
    return <input ref={ref} className={`ui-input ${className}`.trim()} {...rest} />
  },
)

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = '', ...rest }, ref) {
    return <textarea ref={ref} className={`ui-textarea ${className}`.trim()} {...rest} />
  },
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = '', children, ...rest }, ref) {
    return (
      <select ref={ref} className={`ui-select ${className}`.trim()} {...rest}>
        {children}
      </select>
    )
  },
)

/** A labelled field wrapping a single text input — the common case. */
export function TextField({
  label, labelHidden, help, error, required, className, ...rest
}: FieldShellProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field
      label={label} labelHidden={labelHidden} help={help} error={error}
      required={required} className={className}
    >
      {(args) => <Input {...args} {...rest} />}
    </Field>
  )
}

export function SelectField({
  label, labelHidden, help, error, required, className, children, ...rest
}: FieldShellProps & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Field
      label={label} labelHidden={labelHidden} help={help} error={error}
      required={required} className={className}
    >
      {(args) => <Select {...args} {...rest}>{children}</Select>}
    </Field>
  )
}

export function TextareaField({
  label, labelHidden, help, error, required, className, ...rest
}: FieldShellProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Field
      label={label} labelHidden={labelHidden} help={help} error={error}
      required={required} className={className}
    >
      {(args) => <Textarea {...args} {...rest} />}
    </Field>
  )
}

export function Checkbox({
  label, hint, className = '', ...rest
}: { label: ReactNode; hint?: ReactNode; className?: string } &
  InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={`ui-checkbox ${className}`.trim()}>
      <input type="checkbox" {...rest} />
      <span className="ui-checkbox__copy">
        <span>{label}</span>
        {hint && <span className="ui-checkbox__hint">{hint}</span>}
      </span>
    </label>
  )
}

export interface RadioOption<T extends string> {
  value: T
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
}

export function RadioGroup<T extends string>({
  legend, legendHidden, name, value, onChange, options, row, error,
}: {
  legend: ReactNode
  legendHidden?: boolean
  name: string
  value: T | null
  onChange: (value: T) => void
  options: RadioOption<T>[]
  row?: boolean
  error?: ReactNode
}) {
  return (
    <fieldset className={`ui-radio-group${row ? ' ui-radio-group--row' : ''}`}>
      <legend className={legendHidden ? 'sr-only' : undefined}>{legend}</legend>
      {options.map((option) => (
        <label className="ui-radio" key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          <span className="ui-radio__copy">
            <span>{option.label}</span>
            {option.hint && <span className="ui-radio__hint">{option.hint}</span>}
          </span>
        </label>
      ))}
      {error && (
        <span className="ui-field__error">
          <CircleAlert size={14} aria-hidden="true" />
          {error}
        </span>
      )}
    </fieldset>
  )
}
