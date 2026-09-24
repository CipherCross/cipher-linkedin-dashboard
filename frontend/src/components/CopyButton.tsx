import { useState } from 'react'
import type { MouseEvent } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button, IconButton } from '../ui'

/** Icon button (or, with `showLabel`, a ghost text button) that copies `text`
 *  to the clipboard and briefly shows a check. The one copy action for the
 *  ICP/Hypothesis viewers and Chat's message and code-block copy actions.
 *  Stops click propagation so it can sit inside clickable cards/rows without
 *  triggering them.
 *
 *  `text` may be a thunk instead of a string — Chat's code-block copy reads
 *  the rendered `<pre>`'s `innerText` at click time rather than reconstructing
 *  it from markdown AST nodes, so the value has to be read lazily. */
export function CopyButton({
  text,
  title = 'Copy',
  className = '',
  showLabel = false,
}: {
  text: string | (() => string)
  title?: string
  className?: string
  /** Renders a ghost `Button` with the icon plus the visible word ("Copy" /
   *  "Copied") instead of an icon-only `IconButton`. */
  showLabel?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      const value = typeof text === 'function' ? text() : text
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — nothing useful to show */
    }
  }
  const label = copied ? 'Copied' : title
  const onClick = (e: MouseEvent) => {
    e.stopPropagation()
    void copy()
  }

  if (showLabel) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className={className}
        icon={copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        onClick={onClick}
      >
        {label}
      </Button>
    )
  }

  return (
    <IconButton
      className={className}
      label={label}
      icon={copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      onClick={onClick}
    />
  )
}
