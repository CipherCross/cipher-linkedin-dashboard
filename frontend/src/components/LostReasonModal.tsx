import { useState } from 'react'
import { Button, Dialog, TextareaField } from '../ui'

/** Small centred dialog that captures the required free-text reason before a
 *  lead is moved to "Lost". Shared by the board, the leads table, and the
 *  conversation drawer so the flow is identical everywhere. Cmd/Ctrl+Enter
 *  submits; Escape, the backdrop and Close cancel. */
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

  const submit = () => {
    const t = reason.trim()
    if (t) onConfirm(t)
  }

  return (
    <Dialog
      size="sm"
      title={`Mark as lost${leadName ? ` — ${leadName}` : ''}`}
      closeLabel="Cancel"
      onRequestClose={onCancel}
      footer={<>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={!reason.trim()}>Mark lost</Button>
      </>}
    >
      <TextareaField
        label="Reason"
        required
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
    </Dialog>
  )
}
