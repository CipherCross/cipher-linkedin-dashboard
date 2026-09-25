import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, FileSpreadsheet, Upload } from 'lucide-react'
import type { ImportMetadata } from '../lib/importApi'
import { Button, InlineError, Panel, SectionHeader, SelectField, UpdatingNote } from '../ui'

// Pieces both CSV import tabs share. Each tab loads its own Airtable choices,
// because "Added by" is a different select in DB and in Contacts.

export const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))

export function useImportMetadata(load: () => Promise<ImportMetadata>) {
  const [metadata, setMetadata] = useState<ImportMetadata | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setMetadata(await load())
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }, [load])

  useEffect(() => {
    void reload()
  }, [reload])

  return { metadata, busy, error, reload }
}

export function AddedByField({
  state, value, onChange, tableLabel,
}: {
  state: ReturnType<typeof useImportMetadata>
  value: string
  onChange: (value: string) => void
  tableLabel: string
}) {
  const { metadata, busy, error, reload } = state
  useEffect(() => {
    if (metadata && value && !metadata.addedBy.includes(value)) onChange('')
  }, [metadata, value, onChange])

  if (busy) return <UpdatingNote>Loading Airtable choices…</UpdatingNote>
  if (error) {
    return <InlineError title="Could not load the Airtable choices." message={error} onRetry={() => void reload()} />
  }
  return (
    <SelectField
      className="max-w-[360px]"
      label="Added by"
      help={`Choices come from the ${tableLabel} table.`}
      required
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Select your name…</option>
      {metadata?.addedBy.map((name) => <option key={name}>{name}</option>)}
    </SelectField>
  )
}

/** One stage of an import: a framed section with its heading. */
export function Stage({ title, description, aside, children }: {
  title: ReactNode
  description?: ReactNode
  aside?: ReactNode
  children?: ReactNode
}) {
  return (
    <Panel className="mb-section">
      <SectionHeader title={title} description={description} actions={aside} />
      {children}
    </Panel>
  )
}

/** The stage's primary action, kept in view at the bottom while its list scrolls. */
export function StageActions({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-app-md z-[8] flex items-center justify-between gap-group px-pane py-app-md mt-app-md mb-section border border-app-border-strong rounded-control bg-app-surface shadow-[var(--shadow-overlay)] max-[700px]:items-start max-[700px]:flex-col">
      <div>{summary}</div>
      <div className="flex items-center gap-app-sm flex-wrap max-[700px]:w-full">{children}</div>
    </div>
  )
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-app-sm mb-app-sm p-app-md border border-app-warning-border rounded-control bg-app-warning-subtle text-app-warning text-app-table">
      <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  )
}

/** The drop-zone card. It owns the one hidden native file input behind its button. */
export function CsvUploadCard({
  title, hint, disabled, disabledHint, onFile,
}: {
  title: string
  hint: ReactNode
  disabled: boolean
  disabledHint?: ReactNode
  onFile: (file: File) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <Panel className="csv-upload-card mb-section" data-disabled={disabled ? '' : undefined}>
      {/* ui-exception(native-file-input-csv): hidden native file input behind the Choose CSV button; verify: csvImportCompanies */}
      <input
        ref={inputRef}
        className="hidden"
        type="file"
        accept=".csv,text/csv"
        aria-label={title}
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) onFile(file)
        }}
      />
      <FileSpreadsheet size={32} aria-hidden="true" />
      <h2 className="m-0 text-app-section">{title}</h2>
      <p className="max-w-[600px] m-0 mb-app-xs text-app-body text-app-text-muted">{hint}</p>
      <Button
        variant="primary"
        icon={<Upload aria-hidden="true" />}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        Choose CSV
      </Button>
      {disabled && disabledHint && <div className="text-app-meta text-app-text-muted">{disabledHint}</div>}
    </Panel>
  )
}

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`
}
