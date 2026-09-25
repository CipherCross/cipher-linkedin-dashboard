import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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
import {
  Badge, Button, InlineError, PageHeader, Panel, SectionHeader, SelectField, Table, TableFrame,
  UpdatingNote, type Tone,
} from '../ui'

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

// Status → tone for the Badge that carries each word. Complete strings, one owner.
const STATUS_TONE: Record<string, Tone> = {
  ready: 'info',
  company_action: 'warning',
  duplicate: 'neutral',
  invalid: 'danger',
  skipped: 'neutral',
  created: 'success',
  updated: 'success',
  failed: 'danger',
}

const STEP_CLASS = {
  active: 'flex items-center gap-app-sm px-app-md py-app-sm border rounded-control text-app-meta font-semibold bg-app-accent-subtle border-app-accent-border text-app-text',
  done: 'flex items-center gap-app-sm px-app-md py-app-sm border rounded-control text-app-meta font-semibold bg-app-surface border-app-border text-app-success',
  todo: 'flex items-center gap-app-sm px-app-md py-app-sm border rounded-control text-app-meta font-semibold bg-app-surface border-app-border text-app-text-muted',
} as const

const STEP_NUMBER_CLASS = {
  active: 'inline-flex items-center justify-center size-6 shrink-0 rounded-full border tabular-nums bg-app-accent border-app-accent text-app-on-accent',
  done: 'inline-flex items-center justify-center size-6 shrink-0 rounded-full border tabular-nums border-app-success-border text-app-success',
  todo: 'inline-flex items-center justify-center size-6 shrink-0 rounded-full border tabular-nums border-app-border-strong',
} as const

/** One stage of the importer: a framed section with its heading. */
function Stage({ title, description, aside, className = '', children }: {
  title: ReactNode
  description?: ReactNode
  aside?: ReactNode
  className?: string
  children?: ReactNode
}) {
  return (
    <Panel className={`mb-section ${className}`.trim()}>
      <SectionHeader title={title} description={description} actions={aside} />
      {children}
    </Panel>
  )
}

/** The stage's primary action, kept in view at the bottom while its list scrolls. */
function StageActions({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-app-md z-[8] flex items-center justify-between gap-group px-pane py-app-md mt-app-md mb-section border border-app-border-strong rounded-control bg-app-surface shadow-[var(--shadow-overlay)] max-[700px]:items-start max-[700px]:flex-col">
      <div>{summary}</div>
      <div className="flex items-center gap-app-sm flex-wrap max-[700px]:w-full">{children}</div>
    </div>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-app-sm mb-app-sm p-app-md border border-app-warning-border rounded-control bg-app-warning-subtle text-app-warning text-app-table">
      <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  )
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
      <PageHeader
        title="Apollo CSV import"
        description="One Apollo People export creates the missing Airtable Companies first, then links and imports the Contacts."
        actions={(document || companyPreview || contactOutcomes) && (
          <Button variant="secondary" icon={<RotateCcw aria-hidden="true" />} onClick={reset} disabled={busy}>
            Start over
          </Button>
        )}
      />

      {/* The native file input stays hidden; the visible Choose buttons open it. */}
      {/* ui-exception(native-file-input-csv): hidden native file input behind the Choose buttons; verify: unifiedApolloCsvImport */}
      <input
        ref={fileRef}
        className="hidden"
        type="file"
        accept=".csv,text/csv"
        disabled={!addedBy || metadataBusy || !!metadataError || busy}
        onChange={(event) => void chooseFile(event.target.files?.[0])}
      />

      <ol className="list-none mt-0 mx-0 mb-section p-0 grid grid-cols-5 max-[700px]:grid-cols-2 gap-app-sm" aria-label="Import progress">
        {['Set up', 'Review file', 'Companies', 'Contacts', 'Results'].map((label, index) => {
          const number = index + 1
          const state = number === step ? 'active' : number < step ? 'done' : 'todo'
          return (
            <li key={label} className={STEP_CLASS[state]} aria-current={state === 'active' ? 'step' : undefined}>
              <span className={STEP_NUMBER_CLASS[state]}>
                {state === 'done' ? <CheckCircle2 size={16} aria-label="Done" /> : number}
              </span>
              {label}
            </li>
          )
        })}
      </ol>

      {error && (
        <div className="mb-section">
          <InlineError title={error} onRetry={() => setError(null)} retryLabel="Dismiss" />
        </div>
      )}

      {!contactOutcomes && (
        <Stage
          title="1. Choose who is importing"
          description="The value must be available in both Airtable Companies and Contacts."
        >
          {metadataBusy ? (
            <UpdatingNote>Loading Airtable choices…</UpdatingNote>
          ) : metadataError ? (
            <InlineError title="Could not load the Airtable choices." message={metadataError} onRetry={() => void loadMetadata()} />
          ) : (
            <SelectField
              className="max-w-[360px]"
              label="Added by"
              required
              value={addedBy}
              onChange={(event) => setAddedBy(event.target.value)}
            >
              <option value="">Select your name…</option>
              {metadata?.addedBy.map((name) => <option key={name}>{name}</option>)}
            </SelectField>
          )}
        </Stage>
      )}

      {!document && (
        <Panel className="csv-upload-card mb-section" data-disabled={addedBy ? undefined : ''}>
          <FileSpreadsheet size={32} aria-hidden="true" />
          <h2 className="m-0 text-app-section">Upload one Apollo People CSV</h2>
          <p className="max-w-[600px] m-0 mb-app-xs text-app-body text-app-text-muted">
            Requires Apollo Account Id · up to 500 Contacts · maximum 5 MB. Email, phone, funding,
            revenue, intent, and other unmapped columns are ignored.
          </p>
          <Button
            variant="primary"
            icon={<Upload aria-hidden="true" />}
            disabled={!addedBy || metadataBusy || !!metadataError}
            onClick={() => fileRef.current?.click()}
          >
            Choose CSV
          </Button>
          {!addedBy && <div className="text-app-meta text-app-text-muted">Select Added by first.</div>}
        </Panel>
      )}

      {document && !companyPreview && (
        <Stage
          title="2. Review the file"
          description={`${document.fileName} · ${contacts.length} Contacts · ${companies.length} unique Companies · ${document.headers.length} columns`}
          aside={
            <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
              Choose another file
            </Button>
          }
        >
          {document.warnings.map((warning) => <Notice key={warning}>{warning}</Notice>)}
          <dl className="m-0 my-group flex flex-col border border-app-border rounded-control overflow-hidden">
            {TARGET_FIELDS.map((target) => (
              <div className="csv-map-row" key={target}>
                <dt>{TARGET_LABELS[target]}</dt>
                <span aria-hidden="true">←</span>
                <dd className="m-0 text-app-text font-semibold">{document.mapping[target] || 'Not mapped'}</dd>
              </div>
            ))}
            <div className="csv-map-row">
              <dt>Company grouping</dt><span aria-hidden="true">←</span><dd className="m-0 text-app-text font-semibold">Apollo Account Id</dd>
            </div>
          </dl>
          <StageActions summary={<><strong>{companies.length}</strong> Companies will be processed before <strong>{contacts.length}</strong> Contacts.</>}>
            <Button variant="primary" icon={<Search aria-hidden="true" />} loading={busy} onClick={() => void startCompanyPreview()}>
              Preview Companies
            </Button>
          </StageActions>
        </Stage>
      )}

      {companyPreview && !companyOutcomes && (
        <>
          <Stage
            title="3. Resolve Companies"
            description="New Companies will be created. Choosing an existing Company fills only its blank Airtable fields from Apollo."
            aside={<Badge tone="warning">{unresolvedCompanies.length} unresolved</Badge>}
          >
            <ul className="m-0 p-0 list-none flex flex-col">
              {companies.map((company) => {
                const preview = companyPreviewByRow.get(company.rowNumber)
                const decision = companyDecisions[company.accountId]
                const needsDecision = preview?.status === 'company_action'
                return (
                  <li className="csv-company-action-row" key={company.accountId}>
                    {needsDecision
                      ? <AlertTriangle size={18} aria-hidden="true" className="text-app-warning" />
                      : <Building2 size={18} aria-hidden="true" className="text-app-text-muted" />}
                    <div className="min-w-0 flex flex-col gap-0.5">
                      <strong>{company.companyName}</strong>
                      <span className="text-app-meta text-app-text-muted">
                        {company.sourceRowNumbers.length} Contact{company.sourceRowNumbers.length === 1 ? '' : 's'} · {COMPANY_STATUS[preview?.status ?? 'failed']}
                      </span>
                      {preview?.reason && <span className="text-app-meta text-app-text-muted">{companyReason(preview.reason)}</span>}
                      {decision?.kind === 'create' && <Badge tone="success" className="w-fit mt-app-xs">Create new Company</Badge>}
                      {decision?.kind === 'existing' && <Badge className="w-fit mt-app-xs">Use {decision.company.name} · fill blank fields</Badge>}
                      {decision?.kind === 'skip' && <Badge className="w-fit mt-app-xs">Skip this group</Badge>}
                    </div>
                    {needsDecision && (
                      <div className="flex items-center gap-inline whitespace-nowrap max-[700px]:col-start-2 max-[700px]:flex-wrap">
                        {preview?.canCreate && (
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => setCompanyDecisions((current) => ({ ...current, [company.accountId]: { kind: 'create' } }))}
                          >
                            Create new
                          </Button>
                        )}
                        <Button size="sm" icon={<Search aria-hidden="true" />} onClick={() => setOpenAccountId(company.accountId)}>
                          Choose existing
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </Stage>
          <StageActions summary={<>
            <strong>{companyCounts.ready ?? 0}</strong> new · <strong>{companyCounts.duplicate ?? 0}</strong> existing
            {unresolvedCompanies.length > 0 && <span className="text-app-text-muted"> · resolve {unresolvedCompanies.length} first</span>}
          </>}>
            <Button
              variant="primary"
              icon={<Upload aria-hidden="true" />}
              loading={busy}
              disabled={unresolvedCompanies.length > 0}
              onClick={() => void commitCompanyStage()}
            >
              Process Companies
            </Button>
          </StageActions>
        </>
      )}

      {companyOutcomes && contactPreview && !contactOutcomes && (
        <>
          <Stage
            title="4. Review Contacts"
            description="Every ready Contact already carries the exact Airtable Company ID resolved above."
            aside={
              <div className="flex items-center justify-end gap-inline flex-wrap">
                <Badge tone="info">{contactCounts.ready ?? 0} ready</Badge>
                <Badge>{contactCounts.duplicate ?? 0} existing</Badge>
                <Badge tone="danger">{contactCounts.invalid ?? 0} blocked</Badge>
              </div>
            }
          >
            <TableFrame scrollLabel="Contacts to import" maxHeight={560}>
              <Table caption="Contacts to import" className="min-w-[1040px] [&_td]:align-top">
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Contact</th>
                    <th scope="col">Company</th>
                    <th scope="col">Status</th>
                    <th scope="col" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((contact) => {
                    const preview = contactPreviewByRow.get(contact.rowNumber)
                    const skipped = skippedContacts.has(contact.rowNumber)
                    const status = skipped ? 'skipped' : preview?.status ?? 'invalid'
                    return (
                      <tr key={contact.rowNumber}>
                        <td className="tabular-nums">{contact.rowNumber}</td>
                        <td><strong>{contact.fullName}</strong><div className="text-app-meta text-app-text-muted">{contact.title}</div></td>
                        <td>{preview?.company?.name ?? contact.companyName}</td>
                        <td>
                          <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
                            {skipped ? 'Skipped' : CONTACT_STATUS[preview?.status ?? 'invalid']}
                          </Badge>
                          {preview?.reason && <div className="text-app-meta text-app-text-muted mt-app-xs">{preview.reason}</div>}
                        </td>
                        <td className="text-right">
                          {preview?.status === 'ready' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={<SkipForward aria-hidden="true" />}
                              onClick={() => setSkippedContacts((current) => {
                                const next = new Set(current)
                                next.has(contact.rowNumber) ? next.delete(contact.rowNumber) : next.add(contact.rowNumber)
                                return next
                              })}
                            >
                              {skipped ? 'Restore' : 'Skip'}
                            </Button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </Table>
            </TableFrame>
          </Stage>
          <StageActions summary={<><strong>{(contactCounts.ready ?? 0) - skippedContacts.size}</strong> Contacts ready to create.</>}>
            <Button variant="primary" icon={<Users aria-hidden="true" />} loading={busy} onClick={() => void commitContactStage()}>
              Import Contacts
            </Button>
          </StageActions>
        </>
      )}

      {contactOutcomes && companyOutcomes && document && (
        <Stage
          title="Import results"
          description={`Companies: ${companyCounts.created ?? 0} created, ${companyCounts.updated ?? 0} updated, ${companyCounts.duplicate ?? 0} existing · Contacts: ${contactCounts.created ?? 0} created, ${contactCounts.duplicate ?? 0} existing`}
          aside={<CheckCircle2 size={28} aria-hidden="true" className="text-app-success shrink-0" />}
        >
          {(failedCompanies || failedContacts) && (
            <Notice>Some rows were not imported. Refreshing adopts records that may already have been created.</Notice>
          )}
          <StageActions summary={failedCompanies ? 'Retry starts again from fresh Company state.' : failedContacts ? 'Retry rechecks Contacts before writing.' : 'All importable rows were processed.'}>
            <Button
              icon={<Download aria-hidden="true" />}
              onClick={() => downloadUnifiedImportResults(document.fileName, contacts, companies, companyOutcomes, contactOutcomes)}
            >
              Download report
            </Button>
            {failedCompanies && (
              <Button variant="primary" icon={<RefreshCw aria-hidden="true" />} loading={busy} onClick={() => void retryFromAirtable()}>
                Retry import
              </Button>
            )}
            {!failedCompanies && failedContacts && (
              <Button variant="primary" icon={<RefreshCw aria-hidden="true" />} loading={busy} onClick={() => void retryContacts()}>
                Retry Contacts
              </Button>
            )}
            <Button variant="ghost" icon={<RotateCcw aria-hidden="true" />} onClick={reset} disabled={busy}>New import</Button>
          </StageActions>
        </Stage>
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
