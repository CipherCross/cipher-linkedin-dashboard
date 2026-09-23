import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { IconButton } from '../ui'

/** Icon button that copies `text` to the clipboard and briefly shows a check.
 *  The one copy action for the ICP and Hypothesis viewers. Stops click
 *  propagation so it can sit inside clickable cards/rows without triggering them. */
export function CopyButton({
  text,
  title = 'Copy',
  className = '',
}: {
  text: string
  title?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — nothing useful to show */
    }
  }
  return (
    <IconButton
      className={className}
      label={copied ? 'Copied' : title}
      icon={copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      onClick={(e) => {
        e.stopPropagation()
        void copy()
      }}
    />
  )
}
