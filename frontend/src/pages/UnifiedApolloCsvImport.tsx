import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  RefreshCw,
  RotateCcw,
  Search,
  SkipForward,
  Upload,
  Users,
  XCircle,
} from 'lucide-react'
import { CompanyResolutionModal } from '../components/CompanyResolutionModal'
import {
  buildUnifiedImportRows,
  downloadUnifiedImportResults,
  parseCsvFile,
  TARGET_FIELDS,
  TARGET_LABELS,
} from '../lib/csvImport'
import type {
  CsvDocument,
  ImportRowOutcome,
  UnifiedCompanyImportRow,
  UnifiedContactImportRow,
} from '../lib/csvImport'
import {
  commitCompanies,
  commitContacts,
  fetchCompanyImportMetadata,
  fetchImportMetadata,
  previewCompanies,
  previewContacts,
} from '../lib/importApi'
import type {
  AirtableCompany,
  CompanyCommitInputRow,
  CompanyPreviewRowResult,
  ImportMetadata,
  PreviewRowResult,
} from '../lib/importApi'
import { useToast } from '../lib/ToastContext'

type CompanyDecision =
  | { kind: 'create' }
  | { kind: 'existing'; company: AirtableCompany }
  | { kind: 'skip' }

const COMPANY_STATUS: Record<string, string> = {
  ready: 'New',
  company_action: 'Decision needed',
  duplicate: 'Existing',
  invalid: 'Invalid',
  skipped: 'Skipped',
  created: 'Created',
  updated: 'Updated',
  failed: 'Failed',
}

const CONTACT_STATUS: Record<string, string> = {
  ready: 'Ready',
  duplicate: 'Existing',
  invalid: 'Invalid',
  skipped: 'Skipped',
  created: 'Created',
  failed: 'Failed',
}

function companyReason(reason?: string): string {
  if (reason === 'name_match') return 'An Airtable Company has the same name; confirm which record to use.'
  if (reason === 'ambiguous') return 'A stable identifier matches more than one Airtable Company.'
  if (reason === 'conflict') return 'LinkedIn and website point to different Airtable Companies.'
  return reason ?? ''
}

function apiCompanyRow(row: UnifiedCompanyImportRow) {
  const { accountId: _accountId, sourceRowNumbers: _sourceRows, ...payload } = row
  return payload
}

function countByStatus(rows: Array<{ status: string }>) {
  return rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.status] = (counts[row.status] ?? 0) + 1
    return counts
  }, {})
}

export function UnifiedApolloCsvImport() {
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [metadata, setMetadata] = useState<ImportMetadata | null>(null)
  const [metadataBusy, setMetadataBusy] = useState(true)
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [addedBy, setAddedBy] = useState('')
  const [document, setDocument] = useState<CsvDocument | null>(null)
  const [contacts, setContacts] = useState<UnifiedContactImportRow[]>([])
  const [companies, setCompanies] = useState<UnifiedCompanyImportRow[]>([])
  const [companyPreview, setCompanyPreview] = useState<CompanyPreviewRowResult[] | null>(null)
  const [companyDecisions, setCompanyDecisions] = useState<Record<string, CompanyDecision>>({})
  const [openAccountId, setOpenAccountId] = useState<string | null>(null)
  const [companyOutcomes, setCompanyOutcomes] = useState<ImportRowOutcome[] | null>(null)
  const [contactPreview, setContactPreview] = useState<PreviewRowResult[] | null>(null)
  const [skippedContacts, setSkippedContacts] = useState<Set<number>>(new Set())
  const [contactOutcomes, setContactOutcomes] = useState<ImportRowOutcome[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadMetadata = useCallback(async () => {
    setMetadataBusy(true)
    setMetadataError(null)
    try {
      const [contactMetadata, companyMetadata] = await Promise.all([
        fetchImportMetadata(),
        fetchCompanyImportMetadata(),
      ])
      const companyChoices = new Set(companyMetadata.addedBy)
      const sharedAddedBy = contactMetadata.addedBy.filter((name) => companyChoices.has(name))
      if (!sharedAddedBy.length) {
        throw new Error('Contacts and Companies do not share any valid Airtable “Added by” choice.')
      }
      const next = { ...contactMetadata, addedBy: sharedAddedBy }
      setMetadata(next)
      setAddedBy((current) => (sharedAddedBy.includes(current) ? current : ''))
    } catch (reason) {
      setMetadataError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setMetadataBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadMetadata()
  }, [loadMetadata])

  const companyPreviewByRow = useMemo(
    () => new Map((companyPreview ?? []).map((result) => [result.rowNumber, result])),
    [companyPreview],
  )
  const companyByAccount = useMemo(
    () => new Map(companies.map((company) => [company.accountId, company])),
    [companies],
  )
  const contactPreviewByRow = useMemo(
    () => new Map((contactPreview ?? []).map((result) => [result.rowNumber, result])),
    [contactPreview],
  )
  const activeCompany = openAccountId ? companyByAccount.get(openAccountId) ?? null : null
  const activeCompanyPreview = activeCompany
    ? companyPreviewByRow.get(activeCompany.rowNumber) ?? null
    : null

  const unresolvedCompanies = useMemo(
    () =>
      companies.filter((company) => {
        const result = companyPreviewByRow.get(company.rowNumber)
        return result?.status === 'company_action' && !companyDecisions[company.accountId]
      }),
    [companies, companyDecisions, companyPreviewByRow],
  )

  const accountCompanyIds = useMemo(() => {
    const result = new Map<string, string>()
    if (!companyOutcomes) return result
    const outcomeByRow = new Map(companyOutcomes.map((outcome) => [outcome.rowNumber, outcome]))
    for (const company of companies) {
      const outcome = outcomeByRow.get(company.rowNumber)
      if (
        outcome?.companyId &&
        (outcome.status === 'created' ||
          outcome.status === 'updated' ||
          outcome.status === 'duplicate')
      ) {
        result.set(company.accountId, outcome.companyId)
      }
    }
    return result
  }, [companies, companyOutcomes])

  const step = contactOutcomes
    ? 5
    : companyOutcomes && contactPreview
      ? 4
      : companyPreview
        ? 3
        : document
          ? 2
          : 1

  const reset = () => {
    setDocument(null)
    setContacts([])
    setCompanies([])
    setCompanyPreview(null)
    setCompanyDecisions({})
    setOpenAccountId(null)
    setCompanyOutcomes(null)
    setContactPreview(null)
    setSkippedContacts(new Set())
    setContactOutcomes(null)
    setError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const chooseFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      const parsed = await parseCsvFile(file)
      const built = buildUnifiedImportRows(parsed, parsed.mapping)
      setDocument(parsed)
      setContacts(built.contacts)
      setCompanies(built.companies)
      setCompanyPreview(null)
      setCompanyDecisions({})
      setCompanyOutcomes(null)
      setContactPreview(null)
      setContactOutcomes(null)
      setSkippedContacts(new Set())
    } catch (reason) {
      setDocument(null)
      setContacts([])
      setCompanies([])
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const startCompanyPreview = async () => {
    setBusy(true)
    setError(null)
    try {
      const response = await previewCompanies(companies.map(apiCompanyRow))
      setCompanyPreview(response.results)
      setCompanyDecisions({})
      setCompanyOutcomes(null)
      setContactPreview(null)
      setContactOutcomes(null)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const prepareContacts = async (nextCompanyOutcomes: ImportRowOutcome[]) => {
    const outcomeByRow = new Map(nextCompanyOutcomes.map((outcome) => [outcome.rowNumber, outcome]))
    const ids = new Map<string, string>()
    for (const company of companies) {
      const outcome = outcomeByRow.get(company.rowNumber)
      if (
        outcome?.companyId &&
        (outcome.status === 'created' ||
          outcome.status === 'updated' ||
          outcome.status === 'duplicate')
      ) {
        ids.set(company.accountId, outcome.companyId)
      }
    }
    const resolvable = contacts.filter((contact) => ids.has(contact.accountId))
    const response = resolvable.length
      ? await previewContacts(
          resolvable.map((contact) => ({
            ...contact,
            companyId: ids.get(contact.accountId)!,
          })),
          { forceCompanies: true },
        )
      : { results: [] as PreviewRowResult[] }
    const byRow = new Map(response.results.map((result) => [result.rowNumber, result]))
    const combined = contacts.map((contact) => {
      const preview = byRow.get(contact.rowNumber)
      if (preview) return preview
      const company = companyByAccount.get(contact.accountId)
      const companyOutcome = company ? outcomeByRow.get(company.rowNumber) : undefined
      return {
        rowNumber: contact.rowNumber,
        status: 'invalid' as const,
        reason: companyOutcome?.detail || 'Company was not resolved, so this Contact cannot be imported.',
      }
    })
    setContactPreview(combined)
    setSkippedContacts(new Set())
  }

  const commitCompanyStage = async () => {
    if (!addedBy || !companyPreview || unresolvedCompanies.length) return
    setBusy(true)
    setError(null)
    try {
      const committable: CompanyCommitInputRow[] = companies
        .filter((company) => {
          const preview = companyPreviewByRow.get(company.rowNumber)
          const decision = companyDecisions[company.accountId]
          return (
            preview?.status === 'ready' ||
            decision?.kind === 'create' ||
            decision?.kind === 'existing'
          )
        })
        .map((company) => {
          const decision = companyDecisions[company.accountId]
          return {
            ...apiCompanyRow(company),
            allowNameDuplicate: decision?.kind === 'create',
            existingCompanyId: decision?.kind === 'existing' ? decision.company.id : undefined,
          }
        })
      const response = committable.length
        ? await commitCompanies(addedBy, committable)
        : { results: [] }
      const committed = new Map(response.results.map((result) => [result.rowNumber, result]))
      const outcomes = companies.map<ImportRowOutcome>((company) => {
        const server = committed.get(company.rowNumber)
        if (server) {
          return {
            rowNumber: company.rowNumber,
            status: server.status,
            detail: server.error,
            companyId: server.companyId,
            companyName: company.companyName,
          }
        }
        const preview = companyPreviewByRow.get(company.rowNumber)
        const decision = companyDecisions[company.accountId]
        if (decision?.kind === 'existing') {
          return {
            rowNumber: company.rowNumber,
            status: 'duplicate',
            detail: `Using existing Company: ${decision.company.name}`,
            companyId: decision.company.id,
            companyName: company.companyName,
          }
        }
        if (decision?.kind === 'skip') {
          return {
            rowNumber: company.rowNumber,
            status: 'skipped',
            detail: 'Skipped by user',
            companyName: company.companyName,
          }
        }
        if (preview?.status === 'duplicate' && preview.company) {
          return {
            rowNumber: company.rowNumber,
            status: 'duplicate',
            detail: preview.reason,
            companyId: preview.company.id,
            companyName: company.companyName,
          }
        }
        if (preview?.status === 'duplicate') {
          return {
            rowNumber: company.rowNumber,
            status: 'failed',
            detail: preview.reason || 'Company was not resolved to an Airtable record.',
            companyName: company.companyName,
          }
        }
        return {
          rowNumber: company.rowNumber,
          status: preview?.status ?? 'failed',
          detail: companyReason(preview?.reason),
          companyName: company.companyName,
        }
      })
      setCompanyOutcomes(outcomes)
      await prepareContacts(outcomes)
      toast.success('Companies processed · Contacts are ready for review')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      toast.error(`Company import failed: ${message}`)
    } finally {
      setBusy(false)
    }
  }

  const commitContactStage = async () => {
    if (!addedBy || !contactPreview || !companyOutcomes) return
    setBusy(true)
    setError(null)
    try {
      const committable = contacts
        .filter((contact) => {
          const preview = contactPreviewByRow.get(contact.rowNumber)
          return preview?.status === 'ready' && !skippedContacts.has(contact.rowNumber)
        })
        .map((contact) => ({
          rowNumber: contact.rowNumber,
          personLinkedin: contact.personLinkedin,
          firstName: contact.firstName,
          fullName: contact.fullName,
          title: contact.title,
          companyId: accountCompanyIds.get(contact.accountId)!,
        }))
      const response = committable.length
        ? await commitContacts(addedBy, committable)
        : { results: [] }
      const committed = new Map(response.results.map((result) => [result.rowNumber, result]))
      const outcomes = contacts.map<ImportRowOutcome>((contact) => {
        const server = committed.get(contact.rowNumber)
        const companyId = accountCompanyIds.get(contact.accountId)
        if (server) {
          return {
            rowNumber: contact.rowNumber,
            status: server.status,
            detail: server.error,
            contactId: server.contactId,
            companyId,
            companyName: contact.companyName,
          }
        }
        if (skippedContacts.has(contact.rowNumber)) {
          return {
            rowNumber: contact.rowNumber,
            status: 'skipped',
            detail: 'Skipped by user',
            companyId,
            companyName: contact.companyName,
          }
        }
        const preview = contactPreviewByRow.get(contact.rowNumber)
        return {
          rowNumber: contact.rowNumber,
          status: preview?.status ?? 'failed',
          detail: preview?.reason,
          contactId: preview?.contactIds?.[0],
          companyId,
          companyName: preview?.company?.name ?? contact.companyName,
        }
      })
      setContactOutcomes(outcomes)
      const counts = countByStatus(outcomes)
      toast.success(
        `${counts.created ?? 0} Contacts created` +
          (counts.duplicate ? ` · ${counts.duplicate} existing` : '') +
          (counts.failed || counts.invalid ? ` · ${(counts.failed ?? 0) + (counts.invalid ?? 0)} failed` : ''),
      )
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      toast.error(`Contact import failed: ${message}`)
    } finally {
      setBusy(false)
    }
  }

  const retryFromAirtable = async () => {
    if (!document) return
    setBusy(true)
    setError(null)
    try {
      const response = await previewCompanies(companies.map(apiCompanyRow))
      setCompanyPreview(response.results)
      setCompanyDecisions({})
      setCompanyOutcomes(null)
      setContactPreview(null)
      setContactOutcomes(null)
      setSkippedContacts(new Set())
      toast.success('Airtable was refreshed · already-created records will be reused')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const retryContacts = async () => {
    if (!companyOutcomes) return
    setBusy(true)
    setError(null)
    try {
      await prepareContacts(companyOutcomes)
      setContactOutcomes(null)
      toast.success('Contacts were refreshed · existing records will be skipped')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const companyCounts = countByStatus(companyOutcomes ?? companyPreview ?? [])
  const contactCounts = countByStatus(contactOutcomes ?? contactPreview ?? [])
  const failedCompanies = (companyOutcomes ?? []).some(
    (row) =>
      ['failed', 'invalid'].includes(row.status) ||
      (['created', 'duplicate'].includes(row.status) && !row.companyId),
  )
  const failedContacts = (contactOutcomes ?? []).some((row) =>
    ['failed', 'invalid'].includes(row.status),
  )

  return (
    <>
      <header className="csv-page-header">
        <div>
          <h1>Apollo CSV Import</h1>
          <div className="muted small">
            One Apollo People export creates missing Airtable Companies first, then links and imports Contacts.
          </div>
        </div>
        {(document || companyPreview || contactOutcomes) && (
          <button className="btn sm" onClick={reset} disabled={busy}>
            <RotateCcw size={14} /> Start over
          </button>
        )}
      </header>

      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        accept=".csv,text/csv"
        disabled={!addedBy || metadataBusy || !!metadataError || busy}
        onChange={(event) => void chooseFile(event.target.files?.[0])}
      />

      <ol className="csv-import-steps" aria-label="Import progress">
        {['Set up', 'Review file', 'Companies', 'Contacts', 'Results'].map((label, index) => {
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

      {!contactOutcomes && (
        <section className="card csv-setup-card">
          <div className="card-head">
            <div>
              <h2>1. Choose who is importing</h2>
              <div className="muted small">
                The value must be available in both Airtable Companies and Contacts.
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

      {!document && (
        <section className={`card csv-upload-card${addedBy ? '' : ' disabled'}`}>
          <FileSpreadsheet size={32} aria-hidden="true" />
          <h2>Upload one Apollo People CSV</h2>
          <p className="muted">
            Requires Apollo Account Id · up to 500 Contacts · maximum 5 MB. Email, phone, funding,
            revenue, intent, and other unmapped columns are ignored.
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

      {document && !companyPreview && (
        <section className="card csv-mapping-card">
          <div className="card-head">
            <div>
              <h2>2. Review the file</h2>
              <div className="muted small">
                {document.fileName} · {contacts.length} Contacts · {companies.length} unique Companies · {document.headers.length} columns
              </div>
            </div>
            <button className="btn ghost sm" onClick={() => fileRef.current?.click()} disabled={busy}>
              Choose another file
            </button>
          </div>
          {document.warnings.map((warning) => (
            <div className="csv-warning-line" key={warning}><AlertTriangle size={14} /> {warning}</div>
          ))}
          <div className="csv-mapping-grid">
            {TARGET_FIELDS.map((target) => (
              <div className="csv-map-row" key={target}>
                <span>{TARGET_LABELS[target]}</span>
                <span aria-hidden="true">←</span>
                <span className="csv-map-value">{document.mapping[target] || 'Not mapped'}</span>
              </div>
            ))}
            <div className="csv-map-row">
              <span>Company grouping</span><span aria-hidden="true">←</span><span className="csv-map-value">Apollo Account Id</span>
            </div>
          </div>
          <div className="csv-import-footer">
            <div><strong>{companies.length}</strong> Companies will be processed before <strong>{contacts.length}</strong> Contacts.</div>
            <button className="btn accent" onClick={() => void startCompanyPreview()} disabled={busy}>
              {busy ? <RefreshCw size={16} className="spin" /> : <Search size={16} />}
              Preview Companies
            </button>
          </div>
        </section>
      )}

      {companyPreview && !companyOutcomes && (
        <>
          <section className="card csv-company-actions">
            <div className="card-head">
              <div>
                <h2>3. Resolve Companies</h2>
                <div className="muted small">
                  New Companies will be created. Choosing an existing Company fills only its blank Airtable fields from Apollo.
                </div>
              </div>
              <span className="badge status-running">{unresolvedCompanies.length} unresolved</span>
            </div>
            <div className="csv-company-action-list">
              {companies.map((company) => {
                const preview = companyPreviewByRow.get(company.rowNumber)
                const decision = companyDecisions[company.accountId]
                const needsDecision = preview?.status === 'company_action'
                return (
                  <div className="csv-company-action-row" key={company.accountId}>
                    {needsDecision ? <AlertTriangle size={18} /> : <Building2 size={18} />}
                    <div className="csv-company-action-main">
                      <strong>{company.companyName}</strong>
                      <span className="muted small">
                        {company.sourceRowNumbers.length} Contact{company.sourceRowNumbers.length === 1 ? '' : 's'} · {COMPANY_STATUS[preview?.status ?? 'failed']}
                      </span>
                      {preview?.reason && <span className="muted small">{companyReason(preview.reason)}</span>}
                      {decision?.kind === 'create' && <span className="csv-resolution success">Create new Company</span>}
                      {decision?.kind === 'existing' && <span className="csv-resolution skipped">Use {decision.company.name} · fill blank fields</span>}
                      {decision?.kind === 'skip' && <span className="csv-resolution skipped">Skip this group</span>}
                    </div>
                    {needsDecision && (
                      <div className="csv-row-actions">
                        {preview?.canCreate && (
                          <button
                            className="btn accent sm"
                            onClick={() => setCompanyDecisions((current) => ({ ...current, [company.accountId]: { kind: 'create' } }))}
                          >
                            Create new
                          </button>
                        )}
                        <button className="btn sm" onClick={() => setOpenAccountId(company.accountId)}>
                          <Search size={14} /> Choose existing
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
          <div className="csv-import-footer">
            <div>
              <strong>{companyCounts.ready ?? 0}</strong> new · <strong>{companyCounts.duplicate ?? 0}</strong> existing
              {unresolvedCompanies.length > 0 && <span className="muted"> · resolve {unresolvedCompanies.length} first</span>}
            </div>
            <button
              className="btn accent"
              disabled={busy || unresolvedCompanies.length > 0}
              onClick={() => void commitCompanyStage()}
            >
              {busy ? <RefreshCw size={16} className="spin" /> : <Upload size={16} />}
              Process Companies
            </button>
          </div>
        </>
      )}

      {companyOutcomes && contactPreview && !contactOutcomes && (
        <>
          <section className="card csv-preview-card">
            <div className="card-head">
              <div>
                <h2>4. Review Contacts</h2>
                <div className="muted small">
                  Every ready Contact already carries the exact Airtable Company ID resolved above.
                </div>
              </div>
              <div className="csv-summary-chips">
                <span className="badge status-done">{contactCounts.ready ?? 0} ready</span>
                <span className="badge">{contactCounts.duplicate ?? 0} existing</span>
                <span className="badge status-error">{contactCounts.invalid ?? 0} blocked</span>
              </div>
            </div>
            <div className="table-scroll csv-table-scroll">
              <table className="data-table csv-preview-table">
                <thead><tr><th>Row</th><th>Contact</th><th>Company</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {contacts.map((contact) => {
                    const preview = contactPreviewByRow.get(contact.rowNumber)
                    const skipped = skippedContacts.has(contact.rowNumber)
                    return (
                      <tr key={contact.rowNumber}>
                        <td>{contact.rowNumber}</td>
                        <td><strong>{contact.fullName}</strong><div className="muted small">{contact.title}</div></td>
                        <td>{preview?.company?.name ?? contact.companyName}</td>
                        <td>
                          <span className={`csv-status ${skipped ? 'skipped' : preview?.status ?? 'invalid'}`}>
                            {skipped ? 'Skipped' : CONTACT_STATUS[preview?.status ?? 'invalid']}
                          </span>
                          {preview?.reason && <div className="muted small">{preview.reason}</div>}
                        </td>
                        <td>
                          {preview?.status === 'ready' && (
                            <button
                              className="btn ghost sm"
                              onClick={() => setSkippedContacts((current) => {
                                const next = new Set(current)
                                next.has(contact.rowNumber) ? next.delete(contact.rowNumber) : next.add(contact.rowNumber)
                                return next
                              })}
                            >
                              <SkipForward size={13} /> {skipped ? 'Restore' : 'Skip'}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
          <div className="csv-import-footer">
            <div><strong>{(contactCounts.ready ?? 0) - skippedContacts.size}</strong> Contacts ready to create.</div>
            <button className="btn accent" disabled={busy} onClick={() => void commitContactStage()}>
              {busy ? <RefreshCw size={16} className="spin" /> : <Users size={16} />}
              Import Contacts
            </button>
          </div>
        </>
      )}

      {contactOutcomes && companyOutcomes && document && (
        <section className="card csv-results-card">
          <div className="card-head">
            <div>
              <h2>Import results</h2>
              <div className="muted small">
                Companies: {companyCounts.created ?? 0} created, {companyCounts.updated ?? 0} updated, {companyCounts.duplicate ?? 0} existing · Contacts: {contactCounts.created ?? 0} created, {contactCounts.duplicate ?? 0} existing
              </div>
            </div>
            <CheckCircle2 size={28} className="csv-result-icon" />
          </div>
          {(failedCompanies || failedContacts) && (
            <div className="csv-warning-line">
              <AlertTriangle size={14} /> Some rows were not imported. Refreshing adopts records that may already have been created.
            </div>
          )}
          <div className="csv-import-footer">
            <div>{failedCompanies ? 'Retry starts again from fresh Company state.' : failedContacts ? 'Retry rechecks Contacts before writing.' : 'All importable rows were processed.'}</div>
            <div className="csv-header-actions">
              <button
                className="btn"
                onClick={() => downloadUnifiedImportResults(document.fileName, contacts, companies, companyOutcomes, contactOutcomes)}
              >
                <Download size={15} /> Download report
              </button>
              {failedCompanies && (
                <button className="btn accent" disabled={busy} onClick={() => void retryFromAirtable()}>
                  <RefreshCw size={15} className={busy ? 'spin' : ''} /> Retry import
                </button>
              )}
              {!failedCompanies && failedContacts && (
                <button className="btn accent" disabled={busy} onClick={() => void retryContacts()}>
                  <RefreshCw size={15} className={busy ? 'spin' : ''} /> Retry Contacts
                </button>
              )}
              <button className="btn ghost" onClick={reset} disabled={busy}><RotateCcw size={15} /> New import</button>
            </div>
          </div>
        </section>
      )}

      {activeCompany && activeCompanyPreview && (
        <CompanyResolutionModal
          sourceCompany={activeCompany.companyName}
          affectedRows={activeCompany.sourceRowNumbers.length}
          suggestions={activeCompanyPreview.suggestions ?? []}
          subjectLabel="lead"
          onSelect={(company) => {
            setCompanyDecisions((current) => ({
              ...current,
              [activeCompany.accountId]: { kind: 'existing', company },
            }))
            setOpenAccountId(null)
          }}
          onSkip={() => {
            setCompanyDecisions((current) => ({
              ...current,
              [activeCompany.accountId]: { kind: 'skip' },
            }))
            setOpenAccountId(null)
          }}
          onClose={() => setOpenAccountId(null)}
        />
      )}
    </>
  )
}
