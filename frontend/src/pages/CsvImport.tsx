import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Link2,
  RefreshCw,
  RotateCcw,
  Search,
  SkipForward,
  Upload,
  Users,
  XCircle,
} from 'lucide-react'
import { CompanyResolutionModal } from '../components/CompanyResolutionModal'
import { CompanyCsvImport } from './CompanyCsvImport'
import { useToast } from '../lib/ToastContext'
import {
  buildContactRows,
  downloadImportResults,
  mappingErrors,
  parseCsvFile,
  REQUIRED_TARGETS,
  TARGET_FIELDS,
  TARGET_LABELS,
} from '../lib/csvImport'
import type {
  ContactImportRow,
  CsvDocument,
  CsvMapping,
  ImportRowOutcome,
} from '../lib/csvImport'
import {
  commitContacts,
  fetchImportMetadata,
  previewContacts,
} from '../lib/importApi'
import type {
  AirtableCompany,
  CommitInputRow,
  CommitRowResult,
  ImportMetadata,
  PreviewRowResult,
} from '../lib/importApi'

type CompanyDecision =
  | { kind: 'company'; company: AirtableCompany }
  | { kind: 'skip' }

interface CompanyActionGroup {
  key: string
  sourceCompany: string
  rows: ContactImportRow[]
  reason: string
  suggestions: AirtableCompany[]
}

const STATUS_LABELS: Record<string, string> = {
  ready: 'Ready',
  company_action: 'Company needed',
  duplicate: 'Duplicate',
  invalid: 'Needs correction',
  skipped: 'Skipped',
  created: 'Created',
  failed: 'Failed',
}

function companyGroupKey(row: ContactImportRow): string {
  let linkedIn = row.companyLinkedin.trim().toLowerCase()
  try {
    const url = new URL(/^https?:\/\//.test(linkedIn) ? linkedIn : `https://${linkedIn}`)
    const host = url.hostname.replace(/^www\./, '').replace(/^([a-z]{2}\.)?linkedin\.com$/, 'linkedin.com')
    linkedIn = `${host}${url.pathname.replace(/\/+/g, '/').replace(/\/$/, '')}`
  } catch {
    linkedIn = linkedIn.replace(/[?#].*$/, '').replace(/\/$/, '')
  }
  if (linkedIn) return `linkedin:${linkedIn}`
  const website = row.companyWebsite
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
  if (website) return `website:${website}`
  return `name:${row.companyName.trim().toLowerCase().replace(/\s+/g, ' ')}`
}

function reasonLabel(reason?: string): string {
  if (reason === 'not_found') return 'No existing company matched'
  if (reason === 'ambiguous') return 'More than one Airtable company matched'
  if (reason === 'conflict') return 'Company identifiers point to different records'
  return reason ?? ''
}

export function CsvImport() {
  const [kind, setKind] = useState<'contacts' | 'companies' | null>(null)
  if (kind === 'contacts') return <ContactCsvImport onChangeType={() => setKind(null)} />
  if (kind === 'companies') return <CompanyCsvImport onChangeType={() => setKind(null)} />
  return (
    <>
      <header className="csv-page-header">
        <div>
          <h1>CSV Import</h1>
          <div className="muted small">
            Choose what your Apollo export contains. Each import writes directly to the matching Airtable table.
          </div>
        </div>
      </header>
      <section className="csv-import-type-grid" aria-label="Choose import type">
        <button className="card csv-import-type-card" onClick={() => setKind('contacts')}>
          <Users size={28} aria-hidden="true" />
          <span>
            <strong>Leads / Contacts</strong>
            <small>Import Apollo people and connect them to existing Companies.</small>
          </span>
        </button>
        <button className="card csv-import-type-card" onClick={() => setKind('companies')}>
          <Building2 size={28} aria-hidden="true" />
          <span>
            <strong>Companies</strong>
            <small>Import Apollo accounts as new Companies, skipping existing records.</small>
          </span>
        </button>
      </section>
    </>
  )
}

function ContactCsvImport({ onChangeType }: { onChangeType: () => void }) {
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [metadata, setMetadata] = useState<ImportMetadata | null>(null)
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [metadataBusy, setMetadataBusy] = useState(true)
  const [addedBy, setAddedBy] = useState('')
  const [document, setDocument] = useState<CsvDocument | null>(null)
  const [mapping, setMapping] = useState<CsvMapping | null>(null)
  const [rows, setRows] = useState<ContactImportRow[]>([])
  const [preview, setPreview] = useState<PreviewRowResult[] | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewDirty, setPreviewDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [decisions, setDecisions] = useState<Record<string, CompanyDecision>>({})
  const [skippedRows, setSkippedRows] = useState<Set<number>>(new Set())
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const [commitBusy, setCommitBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<ImportRowOutcome[] | null>(null)

  const loadMetadata = useCallback(async () => {
    setMetadataBusy(true)
    setMetadataError(null)
    try {
      const next = await fetchImportMetadata()
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

  const actionGroups = useMemo(() => {
    if (!preview) return [] as CompanyActionGroup[]
    const groups = new Map<string, CompanyActionGroup>()
    for (const row of rows) {
      const result = previewByRow.get(row.rowNumber)
      if (result?.status !== 'company_action') continue
      const key = companyGroupKey(row)
      const existing = groups.get(key)
      if (existing) {
        existing.rows.push(row)
        for (const suggestion of result.suggestions ?? []) {
          if (!existing.suggestions.some((item) => item.id === suggestion.id)) {
            existing.suggestions.push(suggestion)
          }
        }
      } else {
        groups.set(key, {
          key,
          sourceCompany: row.companyName,
          rows: [row],
          reason: result.reason ?? 'not_found',
          suggestions: [...(result.suggestions ?? [])],
        })
      }
    }
    return [...groups.values()]
  }, [preview, previewByRow, rows])

  const groupByKey = useMemo(
    () => new Map(actionGroups.map((group) => [group.key, group])),
    [actionGroups],
  )
  const activeGroup = openGroup ? groupByKey.get(openGroup) ?? null : null

  const companyForRow = useCallback(
    (row: ContactImportRow): AirtableCompany | null => {
      const result = previewByRow.get(row.rowNumber)
      if (result?.status === 'ready' && result.company) return result.company
      if (result?.status === 'company_action') {
        const decision = decisions[companyGroupKey(row)]
        return decision?.kind === 'company' ? decision.company : null
      }
      return null
    },
    [decisions, previewByRow],
  )

  const isSkipped = useCallback(
    (row: ContactImportRow): boolean => {
      if (skippedRows.has(row.rowNumber)) return true
      const result = previewByRow.get(row.rowNumber)
      if (result?.status === 'company_action') {
        return decisions[companyGroupKey(row)]?.kind === 'skip'
      }
      return false
    },
    [decisions, previewByRow, skippedRows],
  )

  const unresolvedGroups = useMemo(
    () =>
      actionGroups.filter((group) => {
        if (decisions[group.key]) return false
        return group.rows.some((row) => !skippedRows.has(row.rowNumber))
      }),
    [actionGroups, decisions, skippedRows],
  )

  const committableRows = useMemo(() => {
    if (!preview || previewDirty) return []
    return rows.filter((row) => {
      const result = previewByRow.get(row.rowNumber)
      if (!result || isSkipped(row)) return false
      if (result.status === 'ready') return !!companyForRow(row)
      if (result.status === 'company_action') return !!companyForRow(row)
      return false
    })
  }, [companyForRow, isSkipped, preview, previewByRow, previewDirty, rows])

  const step = outcomes ? 4 : preview ? 3 : document ? 2 : 1

  const reset = () => {
    setDocument(null)
    setMapping(null)
    setRows([])
    setPreview(null)
    setPreviewDirty(false)
    setError(null)
    setDecisions({})
    setSkippedRows(new Set())
    setOpenGroup(null)
    setOutcomes(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const chooseFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    setPreview(null)
    setOutcomes(null)
    try {
      const parsed = await parseCsvFile(file)
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

  const runPreview = async (nextRows: ContactImportRow[]) => {
    setPreviewBusy(true)
    setError(null)
    try {
      const response = await previewContacts(nextRows)
      setRows(nextRows)
      setPreview(response.results)
      setPreviewDirty(false)
      setDecisions({})
      setSkippedRows(new Set())
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPreviewBusy(false)
    }
  }

  const startPreview = () => {
    if (!document || !mapping) return
    try {
      void runPreview(buildContactRows(document, mapping))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const editPersonLinkedin = (rowNumber: number, value: string) => {
    setRows((current) =>
      current.map((row) => (row.rowNumber === rowNumber ? { ...row, personLinkedin: value } : row)),
    )
    setPreviewDirty(true)
  }

  const toggleSkip = (rowNumber: number) => {
    setSkippedRows((current) => {
      const next = new Set(current)
      next.has(rowNumber) ? next.delete(rowNumber) : next.add(rowNumber)
      return next
    })
  }

  const buildCommitRows = (onlyRows?: Set<number>): CommitInputRow[] =>
    committableRows
      .filter((row) => !onlyRows || onlyRows.has(row.rowNumber))
      .map((row) => ({
        rowNumber: row.rowNumber,
        personLinkedin: row.personLinkedin,
        firstName: row.firstName,
        fullName: row.fullName,
        title: row.title,
        companyId: companyForRow(row)!.id,
      }))

  const initialOutcomes = (commitResults: CommitRowResult[]): ImportRowOutcome[] => {
    const committed = new Map(commitResults.map((result) => [result.rowNumber, result]))
    return rows.map((row) => {
      const company = companyForRow(row)
      const server = committed.get(row.rowNumber)
      if (server) {
        return {
          rowNumber: row.rowNumber,
          status: server.status,
          detail: server.error,
          contactId: server.contactId,
          companyId: company?.id,
          companyName: company?.name,
        }
      }
      const result = previewByRow.get(row.rowNumber)
      if (isSkipped(row)) {
        return {
          rowNumber: row.rowNumber,
          status: 'skipped',
          detail: 'Skipped by user',
          companyId: company?.id,
          companyName: company?.name,
        }
      }
      return {
        rowNumber: row.rowNumber,
        status: result?.status ?? 'failed',
        detail: result?.status === 'company_action'
          ? reasonLabel(result.reason)
          : result?.reason,
        companyId: company?.id,
        companyName: company?.name,
      }
    })
  }

  const doCommit = async (retryRows?: Set<number>) => {
    if (!addedBy) return
    const commitRows = buildCommitRows(retryRows)
    if (!commitRows.length) return
    setCommitBusy(true)
    setError(null)
    try {
      const response = await commitContacts(addedBy, commitRows)
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
              contactId: next.contactId,
            }
          }),
        )
      } else {
        setOutcomes(initialOutcomes(response.results))
      }
      toast.success(
        `${response.counts.created} Contact${response.counts.created === 1 ? '' : 's'} created` +
          (response.counts.duplicate ? ` · ${response.counts.duplicate} duplicate` : '') +
          (response.counts.failed ? ` · ${response.counts.failed} failed` : ''),
      )
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      toast.error(`Import failed: ${reason instanceof Error ? reason.message : String(reason)}`)
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
          <h1>CSV Contact Import</h1>
          <div className="muted small">
            Upload an Apollo people export, connect each lead to an existing Airtable company,
            and add new records to Contacts.
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
        {['Set up', 'Map columns', 'Resolve companies', 'Results'].map((label, index) => {
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
              <div className="muted small">This value is written to Airtable’s Added by field for every new Contact.</div>
            </div>
          </div>
          {metadataBusy ? (
            <div className="muted small csv-loading-line"><RefreshCw size={14} className="spin" /> Loading Airtable choices…</div>
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
          <h2>Upload Apollo people CSV</h2>
          <p className="muted">
            Apollo exports only · up to 500 contacts · maximum 5 MB. The file is parsed in
            your browser; ignored email and phone columns are never sent.
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
        <MappingStep
          document={document}
          mapping={mapping}
          busy={previewBusy}
          onMapping={setMapping}
          onChooseAnother={() => fileRef.current?.click()}
          onPreview={startPreview}
        />
      )}

      {preview && !outcomes && (
        <>
          <PreviewSummary
            rows={rows}
            preview={preview}
            decisions={decisions}
            skippedRows={skippedRows}
          />

          {actionGroups.length > 0 && (
            <section className="card csv-company-actions">
              <div className="card-head">
                <div>
                  <h2>Company decisions</h2>
                  <div className="muted small">
                    Choose an existing Airtable Company or skip the affected leads. No Companies will be created.
                  </div>
                </div>
                {unresolvedGroups.length > 0 && (
                  <span className="badge status-running">{unresolvedGroups.length} unresolved</span>
                )}
              </div>
              <div className="csv-company-action-list">
                {actionGroups.map((group) => {
                  const decision = decisions[group.key]
                  return (
                    <div className="csv-company-action-row" key={group.key}>
                      <AlertTriangle size={18} aria-hidden="true" />
                      <div className="csv-company-action-main">
                        <strong>{group.sourceCompany || 'Unnamed company'}</strong>
                        <span className="muted small">
                          {reasonLabel(group.reason)} · {group.rows.length} lead{group.rows.length === 1 ? '' : 's'}
                        </span>
                        {decision?.kind === 'company' && (
                          <span className="csv-resolution success">
                            <Link2 size={13} /> {decision.company.name}
                          </span>
                        )}
                        {decision?.kind === 'skip' && (
                          <span className="csv-resolution skipped"><SkipForward size={13} /> Leads will be skipped</span>
                        )}
                      </div>
                      <button className="btn sm" onClick={() => setOpenGroup(group.key)}>
                        <Search size={14} /> {decision ? 'Change' : 'Resolve'}
                      </button>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          <section className="card csv-preview-card">
            <div className="card-head">
              <div>
                <h2>Contact preview</h2>
                <div className="muted small">Existing and invalid Contacts are excluded automatically. You can skip any other row.</div>
              </div>
              {previewDirty && (
                <button className="btn accent sm" onClick={() => void runPreview(rows)} disabled={previewBusy}>
                  <RefreshCw size={14} className={previewBusy ? 'spin' : ''} /> Recheck edits
                </button>
              )}
            </div>
            <ContactPreviewTable
              rows={rows}
              previewByRow={previewByRow}
              companyForRow={companyForRow}
              isSkipped={isSkipped}
              previewDirty={previewDirty}
              onEditLinkedin={editPersonLinkedin}
              onToggleSkip={toggleSkip}
              onResolve={(row) => setOpenGroup(companyGroupKey(row))}
            />
          </section>

          <div className="csv-import-footer">
            <div>
              <strong>{committableRows.length}</strong> Contacts ready to create
              {unresolvedGroups.length > 0 && (
                <span className="muted"> · resolve {unresolvedGroups.length} compan{unresolvedGroups.length === 1 ? 'y' : 'ies'} first</span>
              )}
            </div>
            <button
              className="btn accent"
              disabled={
                commitBusy ||
                previewDirty ||
                unresolvedGroups.length > 0 ||
                committableRows.length === 0
              }
              onClick={() => void doCommit()}
            >
              {commitBusy ? <RefreshCw size={16} className="spin" /> : <Upload size={16} />}
              {commitBusy ? 'Importing…' : `Create ${committableRows.length} Contacts`}
            </button>
          </div>
        </>
      )}

      {outcomes && document && (
        <ResultsStep
          fileName={document.fileName}
          rows={rows}
          outcomes={outcomes}
          counts={outcomeCounts}
          busy={commitBusy}
          onDownload={() => downloadImportResults(document.fileName, rows, outcomes)}
          onRetry={(rowNumbers) => void doCommit(rowNumbers)}
          onReset={reset}
        />
      )}

      {activeGroup && (
        <CompanyResolutionModal
          sourceCompany={activeGroup.sourceCompany}
          affectedRows={activeGroup.rows.length}
          suggestions={activeGroup.suggestions}
          onSelect={(company) => {
            setDecisions((current) => ({
              ...current,
              [activeGroup.key]: { kind: 'company', company },
            }))
            setOpenGroup(null)
          }}
          onSkip={() => {
            setDecisions((current) => ({
              ...current,
              [activeGroup.key]: { kind: 'skip' },
            }))
            setOpenGroup(null)
          }}
          onClose={() => setOpenGroup(null)}
        />
      )}
    </>
  )
}

function MappingStep({
  document,
  mapping,
  busy,
  onMapping,
  onChooseAnother,
  onPreview,
}: {
  document: CsvDocument
  mapping: CsvMapping
  busy: boolean
  onMapping: (mapping: CsvMapping) => void
  onChooseAnother: () => void
  onPreview: () => void
}) {
  const errors = mappingErrors(mapping)
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
        {TARGET_FIELDS.map((target) => (
          <label className="csv-map-row" key={target}>
            <span>
              {TARGET_LABELS[target]}
              {REQUIRED_TARGETS.has(target) && <strong aria-label="required"> *</strong>}
            </span>
            <span aria-hidden="true">←</span>
            <select
              value={mapping[target]}
              onChange={(event) =>
                onMapping({ ...mapping, [target]: event.target.value } as CsvMapping)
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
          <span>Airtable Company</span><span>←</span><span>Matched or selected in the next step</span>
        </div>
        <div className="csv-map-row locked">
          <span>Added by</span><span>←</span><span>Selected for this import</span>
        </div>
        <div className="csv-map-row locked">
          <span>Approve status</span><span>←</span><span>New</span>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="csv-inline-error" role="alert">{errors.join(' ')}</div>
      )}
      <div className="csv-card-actions">
        <span className="muted small">Email, phone, Apollo IDs, and all other columns are ignored.</span>
        <button className="btn accent" disabled={busy || errors.length > 0} onClick={onPreview}>
          {busy ? <RefreshCw size={16} className="spin" /> : <Search size={16} />}
          {busy ? 'Checking Airtable…' : 'Match Contacts and Companies'}
        </button>
      </div>
    </section>
  )
}

function PreviewSummary({
  rows,
  preview,
  decisions,
  skippedRows,
}: {
  rows: ContactImportRow[]
  preview: PreviewRowResult[]
  decisions: Record<string, CompanyDecision>
  skippedRows: Set<number>
}) {
  const counts = preview.reduce<Record<string, number>>((result, row) => {
    result[row.status] = (result[row.status] ?? 0) + 1
    return result
  }, {})
  const manualSkips = rows.filter(
    (row) =>
      skippedRows.has(row.rowNumber) ||
      decisions[companyGroupKey(row)]?.kind === 'skip',
  ).length
  const cards = [
    { label: 'CSV rows', value: rows.length, tone: 'info' },
    { label: 'Auto-ready', value: counts.ready ?? 0, tone: 'success' },
    { label: 'Company action', value: counts.company_action ?? 0, tone: 'warning' },
    { label: 'Duplicates', value: counts.duplicate ?? 0, tone: 'muted' },
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

function ContactPreviewTable({
  rows,
  previewByRow,
  companyForRow,
  isSkipped,
  previewDirty,
  onEditLinkedin,
  onToggleSkip,
  onResolve,
}: {
  rows: ContactImportRow[]
  previewByRow: Map<number, PreviewRowResult>
  companyForRow: (row: ContactImportRow) => AirtableCompany | null
  isSkipped: (row: ContactImportRow) => boolean
  previewDirty: boolean
  onEditLinkedin: (rowNumber: number, value: string) => void
  onToggleSkip: (rowNumber: number) => void
  onResolve: (row: ContactImportRow) => void
}) {
  return (
    <div className="table-scroll csv-table-scroll">
      <table className="csv-preview-table">
        <thead>
          <tr>
            <th>Row</th>
            <th>Contact</th>
            <th>Title</th>
            <th>LinkedIn</th>
            <th>Company</th>
            <th>Status</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const result = previewByRow.get(row.rowNumber)
            const skipped = isSkipped(row)
            const company = companyForRow(row)
            const status = skipped ? 'skipped' : result?.status ?? 'invalid'
            const canToggle = result?.status === 'ready' || (result?.status === 'company_action' && !!company)
            return (
              <tr key={row.rowNumber} className={skipped ? 'csv-row-skipped' : ''}>
                <td className="muted">{row.rowNumber}</td>
                <td><strong>{row.fullName || '—'}</strong></td>
                <td className="muted">{row.title || '—'}</td>
                <td>
                  {result?.status === 'invalid' ? (
                    <input
                      className="csv-inline-input"
                      value={row.personLinkedin}
                      aria-label={`LinkedIn URL for row ${row.rowNumber}`}
                      onChange={(event) => onEditLinkedin(row.rowNumber, event.target.value)}
                    />
                  ) : (
                    <a href={row.personLinkedin} target="_blank" rel="noreferrer" className="csv-link-cell">
                      {row.personLinkedin.replace(/^https?:\/\/(www\.)?/, '')}
                    </a>
                  )}
                </td>
                <td>
                  {company ? (
                    <span className="csv-company-linked"><Link2 size={13} /> {company.name}</span>
                  ) : (
                    <span className="muted">{row.companyName || '—'}</span>
                  )}
                </td>
                <td>
                  <span className={`badge csv-status ${status}`}>
                    {STATUS_LABELS[status] ?? status}
                  </span>
                  {!skipped && result?.reason && (
                    <div className="muted csv-status-detail">{reasonLabel(result.reason)}</div>
                  )}
                </td>
                <td>
                  <div className="csv-row-actions">
                    {result?.status === 'company_action' && !company && !skipped && (
                      <button className="btn sm" onClick={() => onResolve(row)}>Resolve</button>
                    )}
                    {canToggle && (
                      <button className="btn ghost sm" onClick={() => onToggleSkip(row.rowNumber)}>
                        {skipped ? 'Include' : 'Skip'}
                      </button>
                    )}
                    {result?.status === 'invalid' && !previewDirty && (
                      <span className="muted small">Edit URL above</span>
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

function ResultsStep({
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
  rows: ContactImportRow[]
  outcomes: ImportRowOutcome[]
  counts: Record<string, number>
  busy: boolean
  onDownload: () => void
  onRetry: (rows: Set<number>) => void
  onReset: () => void
}) {
  const failedRows = new Set(
    outcomes.filter((outcome) => outcome.status === 'failed').map((outcome) => outcome.rowNumber),
  )
  const rowByNumber = new Map(rows.map((row) => [row.rowNumber, row]))
  return (
    <>
      <section className="card csv-result-hero">
        <CheckCircle2 size={34} className="csv-result-icon" aria-hidden="true" />
        <div>
          <h2>Import complete</h2>
          <p className="muted">
            {counts.created ?? 0} created · {counts.duplicate ?? 0} duplicates ·{' '}
            {counts.skipped ?? 0} skipped · {counts.invalid ?? 0} invalid · {counts.failed ?? 0} failed
          </p>
          <div className="csv-result-actions">
            <button className="btn accent" onClick={onDownload}>
              <Download size={16} /> Download results
            </button>
            {failedRows.size > 0 && (
              <button className="btn" disabled={busy} onClick={() => onRetry(failedRows)}>
                <RefreshCw size={15} className={busy ? 'spin' : ''} /> Retry failed
              </button>
            )}
            <button className="btn ghost" onClick={onReset}>Import another CSV</button>
          </div>
        </div>
      </section>

      <section className="card csv-preview-card">
        <div className="card-head">
          <div>
            <h2>Row results</h2>
            <div className="muted small">{fileName} · results are not stored after this page is closed</div>
          </div>
        </div>
        <div className="table-scroll csv-table-scroll">
          <table>
            <thead>
              <tr><th>Row</th><th>Contact</th><th>Company</th><th>Status</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {outcomes.map((outcome) => {
                const row = rowByNumber.get(outcome.rowNumber)
                return (
                  <tr key={outcome.rowNumber}>
                    <td className="muted">{outcome.rowNumber}</td>
                    <td>{row?.fullName ?? '—'}</td>
                    <td>{outcome.companyName ?? row?.companyName ?? '—'}</td>
                    <td><span className={`badge csv-status ${outcome.status}`}>{STATUS_LABELS[outcome.status] ?? outcome.status}</span></td>
                    <td className="muted">{outcome.detail ?? (outcome.contactId ? `Airtable ${outcome.contactId}` : '—')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
