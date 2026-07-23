import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SkipForward,
  Upload,
  XCircle,
} from 'lucide-react'
import { CompanyResolutionModal } from '../components/CompanyResolutionModal'
import {
  buildCompanyRows,
  COMPANY_TARGET_FIELDS,
  COMPANY_TARGET_LABELS,
  companyMappingErrors,
  downloadCompanyImportResults,
  parseCompanyCsvFile,
  REQUIRED_COMPANY_TARGETS,
} from '../lib/csvImport'
import type {
  CompanyCsvDocument,
  CompanyCsvMapping,
  CompanyImportRow,
  ImportRowOutcome,
} from '../lib/csvImport'
import {
  commitCompanies,
  fetchCompanyImportMetadata,
  previewCompanies,
} from '../lib/importApi'
import type {
  AirtableCompany,
  CompanyCommitInputRow,
  CompanyCommitRowResult,
  CompanyPreviewRowResult,
  ImportMetadata,
} from '../lib/importApi'
import { useToast } from '../lib/ToastContext'

type CompanyDecision =
  | { kind: 'create' }
  | { kind: 'existing'; company: AirtableCompany }
  | { kind: 'skip' }

const STATUS_LABELS: Record<string, string> = {
  ready: 'Ready',
  company_action: 'Decision needed',
  duplicate: 'Existing',
  invalid: 'Invalid',
  skipped: 'Skipped',
  created: 'Created',
  failed: 'Failed',
}

function reasonLabel(reason?: string): string {
  if (reason === 'name_match') return 'One or more Airtable Companies have the same name'
  if (reason === 'ambiguous') return 'A website or LinkedIn identifier matches multiple Companies'
  if (reason === 'conflict') return 'Website and LinkedIn point to different Companies'
  return reason ?? ''
}

export function CompanyCsvImport({ onChangeType }: { onChangeType: () => void }) {
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [metadata, setMetadata] = useState<ImportMetadata | null>(null)
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [metadataBusy, setMetadataBusy] = useState(true)
  const [addedBy, setAddedBy] = useState('')
  const [document, setDocument] = useState<CompanyCsvDocument | null>(null)
  const [mapping, setMapping] = useState<CompanyCsvMapping | null>(null)
  const [rows, setRows] = useState<CompanyImportRow[]>([])
  const [preview, setPreview] = useState<CompanyPreviewRowResult[] | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [decisions, setDecisions] = useState<Record<number, CompanyDecision>>({})
  const [skippedRows, setSkippedRows] = useState<Set<number>>(new Set())
  const [openRow, setOpenRow] = useState<number | null>(null)
  const [commitBusy, setCommitBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<ImportRowOutcome[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadMetadata = useCallback(async () => {
    setMetadataBusy(true)
    setMetadataError(null)
    try {
      const next = await fetchCompanyImportMetadata()
      setMetadata(next)
      setAddedBy((current) => (next.addedBy.includes(current) ? current : ''))
    } catch (reason) {
      setMetadataError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setMetadataBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadMetadata()
  }, [loadMetadata])

  const previewByRow = useMemo(
    () => new Map((preview ?? []).map((result) => [result.rowNumber, result])),
    [preview],
  )
  const activeRow = openRow === null ? null : rows.find((row) => row.rowNumber === openRow) ?? null
  const activePreview = openRow === null ? null : previewByRow.get(openRow) ?? null

  const isSkipped = useCallback(
    (row: CompanyImportRow) =>
      skippedRows.has(row.rowNumber) || decisions[row.rowNumber]?.kind === 'skip',
    [decisions, skippedRows],
  )

  const unresolved = useMemo(
    () =>
      rows.filter((row) => {
        const result = previewByRow.get(row.rowNumber)
        return (
          result?.status === 'company_action' &&
          !decisions[row.rowNumber] &&
          !skippedRows.has(row.rowNumber)
        )
      }),
    [decisions, previewByRow, rows, skippedRows],
  )

  const committableRows = useMemo(
    () =>
      rows.filter((row) => {
        if (isSkipped(row)) return false
        const result = previewByRow.get(row.rowNumber)
        if (result?.status === 'ready') return true
        return result?.status === 'company_action' && decisions[row.rowNumber]?.kind === 'create'
      }),
    [decisions, isSkipped, previewByRow, rows],
  )

  const step = outcomes ? 4 : preview ? 3 : document ? 2 : 1

  const reset = () => {
    setDocument(null)
    setMapping(null)
    setRows([])
    setPreview(null)
    setDecisions({})
    setSkippedRows(new Set())
    setOpenRow(null)
    setOutcomes(null)
    setError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const chooseFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    setPreview(null)
    setOutcomes(null)
    try {
      const parsed = await parseCompanyCsvFile(file)
      setDocument(parsed)
      setMapping(parsed.mapping)
      setRows([])
      setDecisions({})
      setSkippedRows(new Set())
    } catch (reason) {
      setDocument(null)
      setMapping(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const startPreview = async () => {
    if (!document || !mapping) return
    setPreviewBusy(true)
    setError(null)
    try {
      const nextRows = buildCompanyRows(document, mapping)
      const response = await previewCompanies(nextRows)
      setRows(nextRows)
      setPreview(response.results)
      setDecisions({})
      setSkippedRows(new Set())
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPreviewBusy(false)
    }
  }

  const toggleSkip = (rowNumber: number) => {
    setSkippedRows((current) => {
      const next = new Set(current)
      next.has(rowNumber) ? next.delete(rowNumber) : next.add(rowNumber)
      return next
    })
  }

  const buildCommitRows = (onlyRows?: Set<number>): CompanyCommitInputRow[] =>
    committableRows
      .filter((row) => !onlyRows || onlyRows.has(row.rowNumber))
      .map((row) => ({
        ...row,
        allowNameDuplicate: decisions[row.rowNumber]?.kind === 'create',
      }))

  const initialOutcomes = (commitResults: CompanyCommitRowResult[]): ImportRowOutcome[] => {
    const committed = new Map(commitResults.map((result) => [result.rowNumber, result]))
    return rows.map((row) => {
      const server = committed.get(row.rowNumber)
      if (server) {
        return {
          rowNumber: row.rowNumber,
          status: server.status,
          detail: server.error,
          companyId: server.companyId,
          companyName: row.companyName,
        }
      }
      const result = previewByRow.get(row.rowNumber)
      const decision = decisions[row.rowNumber]
      if (isSkipped(row)) {
        return {
          rowNumber: row.rowNumber,
          status: 'skipped',
          detail: 'Skipped by user',
          companyName: row.companyName,
        }
      }
      if (decision?.kind === 'existing') {
        return {
          rowNumber: row.rowNumber,
          status: 'duplicate',
          detail: `Matched existing Company: ${decision.company.name}`,
          companyId: decision.company.id,
          companyName: row.companyName,
        }
      }
      return {
        rowNumber: row.rowNumber,
        status: result?.status ?? 'failed',
        detail: reasonLabel(result?.reason),
        companyId: result?.company?.id,
        companyName: row.companyName,
      }
    })
  }

  const doCommit = async (retryRows?: Set<number>) => {
    if (!addedBy) return
    const commitRows = buildCommitRows(retryRows)
    if (!commitRows.length) {
      if (!retryRows) {
        setOutcomes(initialOutcomes([]))
        toast.success('No new Companies to create · review the skipped and existing rows')
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
      return
    }
    setCommitBusy(true)
    setError(null)
    try {
      const response = await commitCompanies(addedBy, commitRows)
      if (retryRows && outcomes) {
        const replacements = new Map(response.results.map((result) => [result.rowNumber, result]))
        setOutcomes(
          outcomes.map((outcome) => {
            const next = replacements.get(outcome.rowNumber)
            if (!next) return outcome
            return {
              ...outcome,
              status: next.status,
              detail: next.error,
              companyId: next.companyId,
            }
          }),
        )
      } else {
        setOutcomes(initialOutcomes(response.results))
      }
      toast.success(
        `${response.counts.created} Compan${response.counts.created === 1 ? 'y' : 'ies'} created` +
          (response.counts.duplicate ? ` · ${response.counts.duplicate} duplicate` : '') +
          (response.counts.failed ? ` · ${response.counts.failed} failed` : ''),
      )
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      toast.error(`Import failed: ${message}`)
    } finally {
      setCommitBusy(false)
    }
  }

  const outcomeCounts = useMemo(
    () =>
      (outcomes ?? []).reduce<Record<string, number>>((counts, outcome) => {
        counts[outcome.status] = (counts[outcome.status] ?? 0) + 1
        return counts
      }, {}),
    [outcomes],
  )

  return (
    <>
      <header className="csv-page-header">
        <div>
          <h1>CSV Company Import</h1>
          <div className="muted small">
            Upload an Apollo Accounts export and create only Companies that do not already exist in Airtable.
          </div>
        </div>
        <div className="csv-header-actions">
          <button className="btn ghost sm" onClick={onChangeType} disabled={commitBusy}>
            Change import type
          </button>
          {(document || preview || outcomes) && (
            <button className="btn sm" onClick={reset} disabled={commitBusy}>
              <RotateCcw size={14} /> Start over
            </button>
          )}
        </div>
      </header>

      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        accept=".csv,text/csv"
        disabled={!addedBy || metadataBusy || !!metadataError || commitBusy}
        onChange={(event) => void chooseFile(event.target.files?.[0])}
      />

      <ol className="csv-import-steps" aria-label="Import progress">
        {['Set up', 'Map columns', 'Review companies', 'Results'].map((label, index) => {
          const number = index + 1
          return (
            <li key={label} className={number === step ? 'active' : number < step ? 'done' : ''}>
              <span>{number < step ? <CheckCircle2 size={15} /> : number}</span>
              {label}
            </li>
          )
        })}
      </ol>

      {error && (
        <div className="csv-error-banner" role="alert">
          <XCircle size={17} />
          <span>{error}</span>
          <button className="link-btn" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {!outcomes && (
        <section className="card csv-setup-card">
          <div className="card-head">
            <div>
              <h2>1. Choose who is importing</h2>
              <div className="muted small">
                Every new Company receives this Added by value and Approve Status = New.
              </div>
            </div>
          </div>
          {metadataBusy ? (
            <div className="muted small csv-loading-line">
              <RefreshCw size={14} className="spin" /> Loading Airtable choices…
            </div>
          ) : metadataError ? (
            <div className="csv-inline-error">
              <span>{metadataError}</span>
              <button className="btn sm" onClick={() => void loadMetadata()}>Retry</button>
            </div>
          ) : (
            <label className="csv-field">
              <span>Added by <strong aria-hidden="true">*</strong></span>
              <select value={addedBy} onChange={(event) => setAddedBy(event.target.value)}>
                <option value="">Select your name…</option>
                {metadata?.addedBy.map((name) => <option key={name}>{name}</option>)}
              </select>
            </label>
          )}
        </section>
      )}

      {!document && !outcomes && (
        <section className={`card csv-upload-card${addedBy ? '' : ' disabled'}`}>
          <FileSpreadsheet size={32} aria-hidden="true" />
          <h2>Upload Apollo Accounts CSV</h2>
          <p className="muted">
            Apollo Accounts exports only · up to 500 companies · maximum 5 MB. Apollo IDs and
            fields without an Airtable destination are ignored.
          </p>
          <button
            className="btn accent"
            disabled={!addedBy || metadataBusy || !!metadataError}
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={16} /> Choose CSV
          </button>
          {!addedBy && <div className="muted small">Select Added by first.</div>}
        </section>
      )}

      {document && mapping && !preview && !outcomes && (
        <CompanyMappingStep
          document={document}
          mapping={mapping}
          busy={previewBusy}
          onMapping={setMapping}
          onChooseAnother={() => fileRef.current?.click()}
          onPreview={() => void startPreview()}
        />
      )}

      {preview && !outcomes && (
        <>
          <CompanyPreviewSummary rows={rows} preview={preview} decisions={decisions} skippedRows={skippedRows} />

          {preview.some((result) => result.status === 'company_action') && (
            <section className="card csv-company-actions">
              <div className="card-head">
                <div>
                  <h2>Company decisions</h2>
                  <div className="muted small">
                    Existing records are never changed. Review weak or conflicting matches before continuing.
                  </div>
                </div>
                {unresolved.length > 0 && (
                  <span className="badge status-running">{unresolved.length} unresolved</span>
                )}
              </div>
              <div className="csv-company-action-list">
                {rows.map((row) => {
                  const result = previewByRow.get(row.rowNumber)
                  if (result?.status !== 'company_action') return null
                  const decision = decisions[row.rowNumber]
                  return (
                    <div className="csv-company-action-row" key={row.rowNumber}>
                      <AlertTriangle size={18} aria-hidden="true" />
                      <div className="csv-company-action-main">
                        <strong>{row.companyName || 'Unnamed company'}</strong>
                        <span className="muted small">{reasonLabel(result.reason)}</span>
                        {decision?.kind === 'create' && (
                          <span className="csv-resolution success"><Plus size={13} /> Create as a new Company</span>
                        )}
                        {decision?.kind === 'existing' && (
                          <span className="csv-resolution skipped">
                            <Building2 size={13} /> Existing: {decision.company.name}
                          </span>
                        )}
                        {decision?.kind === 'skip' && (
                          <span className="csv-resolution skipped"><SkipForward size={13} /> Will be skipped</span>
                        )}
                      </div>
                      <div className="csv-row-actions">
                        {result.canCreate && (
                          <button
                            className="btn accent sm"
                            onClick={() =>
                              setDecisions((current) => ({
                                ...current,
                                [row.rowNumber]: { kind: 'create' },
                              }))
                            }
                          >
                            <Plus size={14} /> Create new
                          </button>
                        )}
                        <button className="btn sm" onClick={() => setOpenRow(row.rowNumber)}>
                          <Search size={14} /> Review matches
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          <section className="card csv-preview-card">
            <div className="card-head">
              <div>
                <h2>Company preview</h2>
                <div className="muted small">
                  Stable Airtable duplicates and invalid rows are excluded automatically. You can skip any ready row.
                </div>
              </div>
            </div>
            <CompanyPreviewTable
              rows={rows}
              previewByRow={previewByRow}
              decisions={decisions}
              isSkipped={isSkipped}
              onToggleSkip={toggleSkip}
              onResolve={setOpenRow}
            />
          </section>

          <div className="csv-import-footer">
            <div>
              <strong>{committableRows.length}</strong> Companies ready to create
              {unresolved.length > 0 && (
                <span className="muted"> · resolve {unresolved.length} decision{unresolved.length === 1 ? '' : 's'} first</span>
              )}
            </div>
            <button
              className="btn accent"
              disabled={commitBusy || unresolved.length > 0}
              onClick={() => void doCommit()}
            >
              {commitBusy ? (
                <RefreshCw size={16} className="spin" />
              ) : committableRows.length > 0 ? (
                <Upload size={16} />
              ) : (
                <CheckCircle2 size={16} />
              )}
              {commitBusy
                ? 'Importing…'
                : committableRows.length > 0
                  ? `Create ${committableRows.length} Companies`
                  : 'Review results'}
            </button>
          </div>
        </>
      )}

      {outcomes && document && (
        <CompanyResults
          fileName={document.fileName}
          rows={rows}
          outcomes={outcomes}
          counts={outcomeCounts}
          busy={commitBusy}
          onDownload={() => downloadCompanyImportResults(document.fileName, rows, outcomes)}
          onRetry={(rowNumbers) => void doCommit(rowNumbers)}
          onReset={reset}
        />
      )}

      {activeRow && activePreview && (
        <CompanyResolutionModal
          sourceCompany={activeRow.companyName}
          affectedRows={1}
          suggestions={activePreview.suggestions ?? []}
          subjectLabel="company"
          onSelect={(company) => {
            setDecisions((current) => ({
              ...current,
              [activeRow.rowNumber]: { kind: 'existing', company },
            }))
            setOpenRow(null)
          }}
          onSkip={() => {
            setDecisions((current) => ({
              ...current,
              [activeRow.rowNumber]: { kind: 'skip' },
            }))
            setOpenRow(null)
          }}
          onClose={() => setOpenRow(null)}
        />
      )}
    </>
  )
}

function CompanyMappingStep({
  document,
  mapping,
  busy,
  onMapping,
  onChooseAnother,
  onPreview,
}: {
  document: CompanyCsvDocument
  mapping: CompanyCsvMapping
  busy: boolean
  onMapping: (mapping: CompanyCsvMapping) => void
  onChooseAnother: () => void
  onPreview: () => void
}) {
  const errors = companyMappingErrors(mapping)
  return (
    <section className="card csv-mapping-card">
      <div className="card-head">
        <div>
          <h2>2. Review the Apollo mapping</h2>
          <div className="muted small">
            {document.fileName} · {document.rows.length} rows · {document.headers.length} columns
          </div>
        </div>
        <button className="btn ghost sm" onClick={onChooseAnother}>Choose another file</button>
      </div>

      {document.warnings.map((warning) => (
        <div className="csv-warning-line" key={warning}><AlertTriangle size={14} /> {warning}</div>
      ))}

      <div className="csv-mapping-grid">
        {COMPANY_TARGET_FIELDS.map((target) => (
          <label className="csv-map-row" key={target}>
            <span>
              {COMPANY_TARGET_LABELS[target]}
              {REQUIRED_COMPANY_TARGETS.has(target) && <strong aria-label="required"> *</strong>}
            </span>
            <span aria-hidden="true">←</span>
            <select
              value={mapping[target]}
              onChange={(event) =>
                onMapping({ ...mapping, [target]: event.target.value } as CompanyCsvMapping)
              }
            >
              <option value="">Not mapped</option>
              {document.headers.map((header) => (
                <option key={header} value={header}>{header}</option>
              ))}
            </select>
          </label>
        ))}
        <div className="csv-map-row locked">
          <span>Added by</span><span>←</span><span>Selected for this import</span>
        </div>
        <div className="csv-map-row locked">
          <span>Approve Status</span><span>←</span><span>New</span>
        </div>
      </div>

      {errors.length > 0 && <div className="csv-inline-error" role="alert">{errors.join(' ')}</div>}
      <div className="csv-card-actions">
        <span className="muted small">
          Apollo Record Id, Subsidiary ID, and Airtable fields not shown above are ignored.
        </span>
        <button className="btn accent" disabled={busy || errors.length > 0} onClick={onPreview}>
          {busy ? <RefreshCw size={16} className="spin" /> : <Search size={16} />}
          {busy ? 'Checking Airtable…' : 'Check Companies'}
        </button>
      </div>
    </section>
  )
}

function CompanyPreviewSummary({
  rows,
  preview,
  decisions,
  skippedRows,
}: {
  rows: CompanyImportRow[]
  preview: CompanyPreviewRowResult[]
  decisions: Record<number, CompanyDecision>
  skippedRows: Set<number>
}) {
  const counts = preview.reduce<Record<string, number>>((result, row) => {
    result[row.status] = (result[row.status] ?? 0) + 1
    return result
  }, {})
  const manualSkips = rows.filter(
    (row) => skippedRows.has(row.rowNumber) || decisions[row.rowNumber]?.kind === 'skip',
  ).length
  const cards = [
    { label: 'CSV rows', value: rows.length, tone: 'info' },
    { label: 'Ready', value: counts.ready ?? 0, tone: 'success' },
    { label: 'Decisions', value: counts.company_action ?? 0, tone: 'warning' },
    { label: 'Existing', value: counts.duplicate ?? 0, tone: 'muted' },
    { label: 'Invalid', value: counts.invalid ?? 0, tone: 'danger' },
    ...(manualSkips ? [{ label: 'Manual skips', value: manualSkips, tone: 'muted' }] : []),
  ]
  return (
    <div className="csv-summary-grid">
      {cards.map((card) => (
        <div className={`card csv-summary-card ${card.tone}`} key={card.label}>
          <span className="muted small">{card.label}</span>
          <strong>{card.value}</strong>
        </div>
      ))}
    </div>
  )
}

function CompanyPreviewTable({
  rows,
  previewByRow,
  decisions,
  isSkipped,
  onToggleSkip,
  onResolve,
}: {
  rows: CompanyImportRow[]
  previewByRow: Map<number, CompanyPreviewRowResult>
  decisions: Record<number, CompanyDecision>
  isSkipped: (row: CompanyImportRow) => boolean
  onToggleSkip: (rowNumber: number) => void
  onResolve: (rowNumber: number) => void
}) {
  return (
    <div className="table-scroll csv-table-scroll">
      <table className="csv-preview-table">
        <thead>
          <tr>
            <th>Row</th>
            <th>Company</th>
            <th>Website</th>
            <th>LinkedIn</th>
            <th>Industry</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const result = previewByRow.get(row.rowNumber)
            const decision = decisions[row.rowNumber]
            const skipped = isSkipped(row)
            let status: string = result?.status ?? 'invalid'
            let detail = reasonLabel(result?.reason)
            if (skipped) {
              status = 'skipped'
              detail = 'Skipped by user'
            } else if (decision?.kind === 'create') {
              status = 'ready'
              detail = 'Confirmed as a new Company'
            } else if (decision?.kind === 'existing') {
              status = 'duplicate'
              detail = `Existing: ${decision.company.name}`
            }
            return (
              <tr key={row.rowNumber} className={skipped ? 'csv-row-skipped' : ''}>
                <td>{row.rowNumber}</td>
                <td>
                  <strong>{row.companyName || '—'}</strong>
                  {row.country && <div className="muted small">{row.country}</div>}
                </td>
                <td>{row.website ? <span className="csv-link-cell">{row.website}</span> : '—'}</td>
                <td>{row.linkedin ? <span className="csv-link-cell">{row.linkedin}</span> : '—'}</td>
                <td>{row.industry || '—'}</td>
                <td>
                  <span className={`badge csv-status ${status}`}>{STATUS_LABELS[status] ?? status}</span>
                  {detail && <div className="muted csv-status-detail">{detail}</div>}
                </td>
                <td>
                  <div className="csv-row-actions">
                    {result?.status === 'company_action' && (
                      <button className="btn ghost sm" onClick={() => onResolve(row.rowNumber)}>
                        Resolve
                      </button>
                    )}
                    {(result?.status === 'ready' || result?.status === 'company_action') && (
                      <button className="btn ghost sm" onClick={() => onToggleSkip(row.rowNumber)}>
                        {skipped ? 'Include' : 'Skip'}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function CompanyResults({
  fileName,
  rows,
  outcomes,
  counts,
  busy,
  onDownload,
  onRetry,
  onReset,
}: {
  fileName: string
  rows: CompanyImportRow[]
  outcomes: ImportRowOutcome[]
  counts: Record<string, number>
  busy: boolean
  onDownload: () => void
  onRetry: (rowNumbers: Set<number>) => void
  onReset: () => void
}) {
  const failedRows = new Set(outcomes.filter((row) => row.status === 'failed').map((row) => row.rowNumber))
  const byRow = new Map(rows.map((row) => [row.rowNumber, row]))
  return (
    <>
      <section className="card csv-result-hero">
        <CheckCircle2 size={34} className="csv-result-icon" />
        <div>
          <h2>Company import complete</h2>
          <p className="muted">
            {counts.created ?? 0} created · {counts.duplicate ?? 0} existing · {counts.skipped ?? 0} skipped ·{' '}
            {counts.invalid ?? 0} invalid · {counts.failed ?? 0} failed
          </p>
          <div className="csv-result-actions">
            <button className="btn accent sm" onClick={onDownload}>
              <Download size={14} /> Download results
            </button>
            {failedRows.size > 0 && (
              <button className="btn sm" disabled={busy} onClick={() => onRetry(failedRows)}>
                <RefreshCw size={14} className={busy ? 'spin' : ''} /> Retry failed
              </button>
            )}
            <button className="btn ghost sm" onClick={onReset} disabled={busy}>
              <RotateCcw size={14} /> Import another file
            </button>
          </div>
        </div>
      </section>

      <section className="card csv-preview-card">
        <div className="card-head">
          <div>
            <h2>Row-level report</h2>
            <div className="muted small">{fileName}</div>
          </div>
        </div>
        <div className="table-scroll csv-table-scroll">
          <table className="csv-preview-table">
            <thead>
              <tr><th>Row</th><th>Company</th><th>Status</th><th>Detail</th><th>Airtable ID</th></tr>
            </thead>
            <tbody>
              {outcomes.map((outcome) => (
                <tr key={outcome.rowNumber}>
                  <td>{outcome.rowNumber}</td>
                  <td>{byRow.get(outcome.rowNumber)?.companyName ?? outcome.companyName ?? '—'}</td>
                  <td>
                    <span className={`badge csv-status ${outcome.status}`}>
                      {STATUS_LABELS[outcome.status] ?? outcome.status}
                    </span>
                  </td>
                  <td>{outcome.detail || '—'}</td>
                  <td>{outcome.companyId || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
