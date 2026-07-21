import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

/** Small icon button that copies `text` to the clipboard and briefly shows a
 *  check. Shared by the ICP and Hypothesis read-only viewers. Stops click
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
    <button
      type="button"
      className={`icon-only-btn icp-copy-btn ${className}`.trim()}
      onClick={(e) => {
        e.stopPropagation()
        copy()
      }}
      title={copied ? 'Copied' : title}
      aria-label={copied ? 'Copied' : title}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}
