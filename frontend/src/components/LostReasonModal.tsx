import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

/** Small centred modal that captures the required free-text reason before a lead
 *  is moved to "Lost". Shared by the board, the leads table, and the drawer so
 *  the flow is identical everywhere. Enter submits, Esc / backdrop cancels. */
export function LostReasonModal({
  leadName,
  onConfirm,
  onCancel,
}: {
  leadName?: string | null
  onConfirm: (reason: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = () => {
    const t = reason.trim()
    if (t) onConfirm(t)
  }

  return (
    <div className="pipe-modal-overlay" onClick={onCancel}>
      <div
        className="pipe-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Reason for marking lost"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pipe-modal-head">
          <span>Mark as lost{leadName ? ` — ${leadName}` : ''}</span>
          <button className="conv-close" onClick={onCancel} aria-label="Cancel">
            <X size={16} />
          </button>
        </div>
        <label className="filter-field">
          <span className="filter-label">Reason (required)</span>
          <textarea
            autoFocus
            rows={3}
            value={reason}
            placeholder="Why was this lead lost?"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </label>
        <div className="pipe-modal-actions">
          <button className="btn ghost sm" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn accent sm" onClick={submit} disabled={!reason.trim()}>
            Mark lost
          </button>
        </div>
      </div>
    </div>
  )
}
