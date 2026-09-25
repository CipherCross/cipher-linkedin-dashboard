import { useMemo, useState } from 'react'
import { CheckCircle2, Download, RefreshCw, RotateCcw, Upload } from 'lucide-react'
import { downloadCsvReport, parseCompanyCsvFile } from '../lib/csvImport'
import type { CompanyCsvDocument } from '../lib/csvImport'
import {
  commitCompanies,
  fetchCompanyImportMetadata,
  previewCompanies,
} from '../lib/importApi'
import type {
  CompanyCommitResponse,
  CompanyLocation,
  CompanyPreviewResult,
} from '../lib/importApi'
import { useToast } from '../lib/ToastContext'
import {
  Badge, Button, Checkbox, InlineError, SectionHeader, Table, TableFrame, UpdatingNote, type Tone,
} from '../ui'
import {
  AddedByField,
  CsvUploadCard,
  Notice,
  Stage,
  StageActions,
  messageOf,
  plural,
  useImportMetadata,
} from './CsvImportShared'

// Companies export → Airtable DB. New companies land in DB with
// `Initial status = New`; SDRs approve them in Airtable and its automations
// copy approved rows into Companies. This tab never writes Companies.

type RowStatus = CompanyPreviewResult['status'] | 'created' | 'failed' | 'excluded'

const STATUS: Record<RowStatus, { label: string; tone: Tone }> = {
  ready: { label: 'New', tone: 'info' },
  name_match: { label: 'Name match', tone: 'warning' },
  duplicate: { label: 'Duplicate', tone: 'neutral' },
  invalid: { label: 'Invalid', tone: 'danger' },
  created: { label: 'Added to DB', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  excluded: { label: 'Not selected', tone: 'neutral' },
}

export function locationLabel(location: CompanyLocation): string {
  if (location.table === 'File') return `This file · row ${location.rowNumber}`
  return `${location.table} · ${location.status || 'No status'}`
}

const whereFound = (matches?: CompanyLocation[]) => (matches ?? []).map(locationLabel).join(', ')

interface Outcome {
  rowNumber: number
  status: RowStatus
  domain: string
  detail: string
  matches?: CompanyLocation[]
  recordId?: string
}

export function CompaniesImport() {
  const toast = useToast()
  const metadata = useImportMetadata(fetchCompanyImportMetadata)
  const [addedBy, setAddedBy] = useState('')
  const [document, setDocument] = useState<CompanyCsvDocument | null>(null)
  const [preview, setPreview] = useState<CompanyPreviewResult[] | null>(null)
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [committed, setCommitted] = useState<CompanyCommitResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const previewByRow = useMemo(
    () => new Map((preview ?? []).map((result) => [result.rowNumber, result])),
    [preview],
  )
  const selectable = (preview ?? []).filter((result) => result.status === 'ready' || result.status === 'name_match')
  const selected = selectable.filter((result) => !excluded.has(result.rowNumber))

  const runPreview = async (doc: CompanyCsvDocument) => {
    setBusy(true)
    setError(null)
    try {
      const response = await previewCompanies(doc.rows)
      setPreview(response.results)
      setExcluded(new Set())
      setCommitted(null)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const chooseFile = async (file: File) => {
    setError(null)
    try {
      const parsed = await parseCompanyCsvFile(file)
      setDocument(parsed)
      setPreview(null)
      setCommitted(null)
      await runPreview(parsed)
    } catch (reason) {
      setDocument(null)
      setError(messageOf(reason))
    }
  }

  const reset = () => {
    setDocument(null)
    setPreview(null)
    setExcluded(new Set())
    setCommitted(null)
    setError(null)
  }

  const commit = async () => {
    if (!document || !addedBy || !selected.length) return
    setBusy(true)
    setError(null)
    try {
      const wanted = new Set(selected.map((result) => result.rowNumber))
      const response = await commitCompanies(addedBy, document.rows.filter((row) => wanted.has(row.rowNumber)))
      setCommitted(response)
      toast.success(
        `${plural(response.counts.created, 'company', 'companies')} added to DB` +
          (response.counts.duplicate ? ` · ${response.counts.duplicate} duplicates skipped` : '') +
          (response.counts.failed ? ` · ${response.counts.failed} failed` : ''),
      )
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (reason) {
      const message = messageOf(reason)
      setError(message)
      toast.error(`Company import failed: ${message}`)
    } finally {
      setBusy(false)
    }
  }

  const outcomes = useMemo<Outcome[]>(() => {
    if (!document || !preview) return []
    const commitByRow = new Map((committed?.results ?? []).map((result) => [result.rowNumber, result]))
    return document.rows.map((row) => {
      const server = commitByRow.get(row.rowNumber)
      const planned = previewByRow.get(row.rowNumber)
      if (server) {
        return {
          rowNumber: row.rowNumber,
          status: server.status,
          domain: server.domain,
          detail: server.error ?? '',
          matches: server.matches,
          recordId: server.recordId,
        }
      }
      const status: RowStatus =
        committed && (planned?.status === 'ready' || planned?.status === 'name_match')
          ? 'excluded'
          : planned?.status ?? 'invalid'
      return {
        rowNumber: row.rowNumber,
        status,
        domain: planned?.domain ?? '',
        detail: status === 'excluded' ? 'Unticked before import' : planned?.reason ?? '',
        matches: planned?.matches,
      }
    })
  }, [committed, document, preview, previewByRow])

  const nameOf = (rowNumber: number) =>
    document?.rows.find((row) => row.rowNumber === rowNumber)?.companyName ?? ''
  const duplicates = outcomes.filter((outcome) => outcome.status === 'duplicate')
  const problems = outcomes.filter((outcome) => outcome.status === 'failed' || outcome.status === 'invalid')
  const counts = outcomes.reduce<Record<string, number>>((summary, outcome) => {
    summary[outcome.status] = (summary[outcome.status] ?? 0) + 1
    return summary
  }, {})

  const downloadReport = () => {
    if (!document) return
    downloadCsvReport(
      document.fileName,
      'db-import-report',
      ['Source Row', 'Company', 'Domain', 'Status', 'Found In', 'Detail', 'DB Record ID'],
      outcomes.map((outcome) => [
        outcome.rowNumber,
        nameOf(outcome.rowNumber),
        outcome.domain,
        STATUS[outcome.status].label,
        whereFound(outcome.matches),
        outcome.detail,
        outcome.recordId ?? '',
      ]),
    )
  }

  const companyTable = (rows: Outcome[], caption: string, selectableRows: boolean) => (
    <TableFrame scrollLabel={caption} maxHeight={560}>
      <Table caption={caption} className="min-w-[1040px] [&_td]:align-top">
        <thead>
          <tr>
            {selectableRows && (
              <th className="ui-table__select" scope="col"><span className="sr-only">Include</span></th>
            )}
            <th scope="col">Row</th>
            <th scope="col">Company</th>
            <th scope="col">Domain</th>
            <th scope="col">Status</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((outcome) => {
            const canTick = outcome.status === 'ready' || outcome.status === 'name_match'
            return (
              <tr key={outcome.rowNumber}>
                {selectableRows && (
                  <td className="ui-table__select">
                    {canTick && (
                      <Checkbox
                        label={<span className="sr-only">Include {nameOf(outcome.rowNumber)}</span>}
                        checked={!excluded.has(outcome.rowNumber)}
                        onChange={() => setExcluded((current) => {
                          const next = new Set(current)
                          if (next.has(outcome.rowNumber)) next.delete(outcome.rowNumber)
                          else next.add(outcome.rowNumber)
                          return next
                        })}
                      />
                    )}
                  </td>
                )}
                <td className="tabular-nums">{outcome.rowNumber}</td>
                <td><strong>{nameOf(outcome.rowNumber) || 'Unnamed company'}</strong></td>
                <td>{outcome.domain || <span className="text-app-text-muted">—</span>}</td>
                <td><Badge tone={STATUS[outcome.status].tone}>{STATUS[outcome.status].label}</Badge></td>
                <td className="text-app-meta text-app-text-muted">
                  {outcome.detail}
                  {outcome.matches?.length ? (
                    <div>Found in {whereFound(outcome.matches)}{outcome.matches[0]?.name ? ` (${outcome.matches[0].name})` : ''}</div>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </Table>
    </TableFrame>
  )

  return (
    <>
      {error && (
        <div className="mb-section">
          <InlineError title={error} onRetry={() => setError(null)} retryLabel="Dismiss" />
        </div>
      )}

      {!committed && (
        <Stage
          title="Who is importing"
          description="Written to the DB “Added by” field on every new row."
        >
          <AddedByField state={metadata} value={addedBy} onChange={setAddedBy} tableLabel="DB" />
        </Stage>
      )}

      {!document && (
        <CsvUploadCard
          title="Upload a companies CSV"
          hint={<>New companies go to the Airtable DB table for approval, never straight into Companies. Up to 500 rows · maximum 5 MB. Revenue, growth, headcounts and other unmapped columns are ignored.</>}
          disabled={metadata.busy || !!metadata.error}
          onFile={(file) => void chooseFile(file)}
        />
      )}

      {document && !preview && busy && (
        <Stage title="Checking Airtable" description={`${document.fileName} · ${plural(document.rowCount, 'row')}`}>
          <UpdatingNote>Looking for these domains in DB and Companies…</UpdatingNote>
        </Stage>
      )}

      {document && !preview && !busy && (
        <Stage title="Could not check Airtable" description={document.fileName}>
          <StageActions summary="Nothing was written.">
            <Button variant="primary" icon={<RefreshCw aria-hidden="true" />} onClick={() => void runPreview(document)}>Try again</Button>
            <Button variant="ghost" icon={<RotateCcw aria-hidden="true" />} onClick={reset}>Choose another file</Button>
          </StageActions>
        </Stage>
      )}

      {document && preview && !committed && (
        <>
          <Stage
            title="Review companies"
            description={`${document.fileName} · ${plural(document.rowCount, 'row')}`}
            aside={
              <div className="flex items-center justify-end gap-inline flex-wrap">
                <Badge tone="info">{counts.ready ?? 0} new</Badge>
                {!!counts.name_match && <Badge tone="warning">{counts.name_match} name matches</Badge>}
                <Badge>{counts.duplicate ?? 0} duplicates</Badge>
                {!!counts.invalid && <Badge tone="danger">{counts.invalid} invalid</Badge>}
              </div>
            }
          >
            {!!counts.name_match && (
              <Notice>
                {plural(counts.name_match, 'company has', 'companies have')} the same name as an Airtable record but a different domain.
                They are still added unless you untick them.
              </Notice>
            )}
            {companyTable(outcomes, 'Companies in this file', true)}
          </Stage>
          <StageActions summary={<>
            <strong>{selected.length}</strong> of {document.rowCount} will be added to DB with Initial status <strong>New</strong>.
            {!addedBy && <span className="text-app-text-muted"> Select Added by first.</span>}
          </>}>
            <Button variant="ghost" icon={<RotateCcw aria-hidden="true" />} onClick={reset} disabled={busy}>Start over</Button>
            <Button
              variant="primary"
              icon={<Upload aria-hidden="true" />}
              loading={busy}
              disabled={!addedBy || !selected.length}
              onClick={() => void commit()}
            >
              Add {plural(selected.length, 'company', 'companies')} to DB
            </Button>
          </StageActions>
        </>
      )}

      {document && preview && committed && (
        <>
          <Stage
            title="Import results"
            description={`${plural(counts.created ?? 0, 'company', 'companies')} added to DB · ${plural(duplicates.length, 'duplicate')} skipped · ${plural(problems.length, 'row')} not imported`}
            aside={<CheckCircle2 size={28} aria-hidden="true" className="text-app-success shrink-0" />}
          >
            {duplicates.length > 0 && (
              <div className="mt-section">
                <SectionHeader level="subsection" title={`${plural(duplicates.length, 'company', 'companies')} skipped as duplicates`} />
                {companyTable(duplicates, 'Companies skipped as duplicates', false)}
              </div>
            )}
            {problems.length > 0 && (
              <div className="mt-section">
                <SectionHeader level="subsection" title={`${plural(problems.length, 'row')} not imported`} />
                {companyTable(problems, 'Rows not imported', false)}
              </div>
            )}
            {problems.some((outcome) => outcome.status === 'failed') && (
              <Notice>Some rows failed to write. Re-check looks them up again, so anything that did land shows as a duplicate.</Notice>
            )}
          </Stage>
          <StageActions summary="New rows wait in DB for an SDR to approve them in Airtable.">
            <Button icon={<Download aria-hidden="true" />} onClick={downloadReport}>Download report</Button>
            <Button icon={<RefreshCw aria-hidden="true" />} loading={busy} onClick={() => void runPreview(document)}>Re-check</Button>
            <Button variant="ghost" icon={<RotateCcw aria-hidden="true" />} onClick={reset} disabled={busy}>New upload</Button>
          </StageActions>
        </>
      )}
    </>
  )
}
