import { useMemo, useState } from 'react'
import { CheckCircle2, Download, RefreshCw, RotateCcw, Search, Undo2, Users } from 'lucide-react'
import { CompanyResolutionModal } from '../components/CompanyResolutionModal'
import { downloadCsvReport, parseLeadCsvFile } from '../lib/csvImport'
import type { LeadCsvDocument, LeadImportRow } from '../lib/csvImport'
import {
  commitContacts,
  fetchContactImportMetadata,
  previewLeads,
} from '../lib/importApi'
import type {
  AirtableCompany,
  ContactCommitResponse,
  DbMatch,
  LeadGroup,
  LeadPreviewResponse,
} from '../lib/importApi'
import { useToast } from '../lib/ToastContext'
import {
  Badge, Button, InlineError, SectionHeader, Table, TableFrame, UpdatingNote, type Tone,
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

// Leads export → Airtable Contacts. Leads are grouped by company, and every
// group must be linked to a Companies record the user confirms: a suggestion
// is preselected, never written until confirmed. Companies still waiting in DB
// hold their leads until an SDR approves them; Re-check runs the preview again
// on the file already loaded.

type GroupState = LeadGroup['status'] | 'confirmed'

const GROUP_STATUS: Record<GroupState, { label: string; tone: Tone }> = {
  confirmed: { label: 'Confirmed', tone: 'success' },
  suggested: { label: 'Suggested', tone: 'info' },
  ambiguous: { label: 'Choose company', tone: 'warning' },
  pending: { label: 'Pending approval', tone: 'warning' },
  declined: { label: 'Declined', tone: 'danger' },
  not_uploaded: { label: 'Company not uploaded', tone: 'neutral' },
}

const METHOD_LABEL = { domain: 'Domain match', linkedin: 'LinkedIn match', name: 'Name match' } as const

const ROW_STATUS: Record<string, string> = {
  invalid: 'Invalid',
  duplicate: 'Repeated in file',
  existing: 'Already in Contacts',
}

const dbStatus = (match: DbMatch) =>
  `DB · ${match.status || 'No status'}${match.addedToCompanies ? ' · added to Companies' : ''}`

function groupWhere(group: LeadGroup): string {
  if (group.status === 'declined') {
    return group.declinedBy === 'DB' ? 'DB · Rejected' : 'Companies · Rejected'
  }
  if (group.status === 'pending') return [...new Set(group.db.map(dbStatus))].join(', ')
  return ''
}

export function LeadsImport() {
  const toast = useToast()
  const metadata = useImportMetadata(fetchContactImportMetadata)
  const [addedBy, setAddedBy] = useState('')
  const [document, setDocument] = useState<LeadCsvDocument | null>(null)
  const [preview, setPreview] = useState<LeadPreviewResponse | null>(null)
  const [confirmed, setConfirmed] = useState<Record<string, AirtableCompany>>({})
  const [pickerKey, setPickerKey] = useState<string | null>(null)
  const [committed, setCommitted] = useState<ContactCommitResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rowsByNumber = useMemo(
    () => new Map((document?.rows ?? []).map((row) => [row.rowNumber, row])),
    [document],
  )
  const groups = preview?.groups ?? []
  const pickerGroup = groups.find((group) => group.key === pickerKey) ?? null
  const skippedRows = (preview?.rows ?? []).filter((row) => row.status !== 'ready')
  const stateOf = (group: LeadGroup): GroupState => (confirmed[group.key] ? 'confirmed' : group.status)
  const canLink = (group: LeadGroup) => group.status !== 'declined'
  const singleDomainMatches = groups.filter(
    (group) => group.status === 'suggested' && group.method === 'domain' && !confirmed[group.key],
  )
  const confirmedGroups = groups.filter((group) => confirmed[group.key])
  const leadsToCreate = confirmedGroups.reduce((total, group) => total + group.rowNumbers.length, 0)

  const runPreview = async (doc: LeadCsvDocument, recheck = false) => {
    setBusy(true)
    setError(null)
    try {
      const response = await previewLeads(doc.rows, { forceCompanies: recheck })
      setPreview(response)
      setConfirmed({})
      setCommitted(null)
      if (recheck) toast.success('Re-checked against Airtable · created contacts now show as existing')
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const chooseFile = async (file: File) => {
    setError(null)
    try {
      const parsed = await parseLeadCsvFile(file)
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
    setConfirmed({})
    setCommitted(null)
    setError(null)
  }

  const confirm = (group: LeadGroup, company: AirtableCompany) =>
    setConfirmed((current) => ({ ...current, [group.key]: company }))

  const unconfirm = (group: LeadGroup) =>
    setConfirmed((current) => {
      const next = { ...current }
      delete next[group.key]
      return next
    })

  const confirmAllDomainMatches = () =>
    setConfirmed((current) => {
      const next = { ...current }
      for (const group of singleDomainMatches) if (group.suggestion) next[group.key] = group.suggestion
      return next
    })

  const commit = async () => {
    if (!addedBy || !leadsToCreate) return
    setBusy(true)
    setError(null)
    try {
      const rows = confirmedGroups.flatMap((group) =>
        group.rowNumbers.map((rowNumber) => {
          const row = rowsByNumber.get(rowNumber) as LeadImportRow
          return {
            rowNumber,
            personLinkedin: row.personLinkedin,
            firstName: row.firstName,
            fullName: row.fullName,
            title: row.title,
            companyId: confirmed[group.key].id,
            companyWebsite: row.companyWebsite,
          }
        }),
      )
      const response = await commitContacts(addedBy, rows)
      setCommitted(response)
      toast.success(
        `${plural(response.counts.created, 'contact')} created` +
          (response.counts.duplicate ? ` · ${response.counts.duplicate} existing` : '') +
          (response.counts.failed ? ` · ${response.counts.failed} failed` : ''),
      )
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (reason) {
      const message = messageOf(reason)
      setError(message)
      toast.error(`Contact import failed: ${message}`)
    } finally {
      setBusy(false)
    }
  }

  const heldGroups = groups.filter((group) => group.status === 'pending' || group.status === 'not_uploaded')
  const declinedGroups = groups.filter((group) => group.status === 'declined')
  const unconfirmedGroups = groups.filter(
    (group) => (group.status === 'suggested' || group.status === 'ambiguous') && !confirmed[group.key],
  )
  const leadCount = (list: LeadGroup[]) => list.reduce((total, group) => total + group.rowNumbers.length, 0)
  const commitByRow = new Map((committed?.results ?? []).map((result) => [result.rowNumber, result]))
  const failedRows = (committed?.results ?? []).filter((result) => result.status === 'failed')

  const downloadReport = () => {
    if (!document || !preview) return
    const groupByRow = new Map<number, LeadGroup>()
    for (const group of groups) for (const rowNumber of group.rowNumbers) groupByRow.set(rowNumber, group)
    const rowResult = new Map(preview.rows.map((row) => [row.rowNumber, row]))
    downloadCsvReport(
      document.fileName,
      'contacts-import-report',
      ['Source Row', 'Person LinkedIn', 'Full Name', 'CSV Company', 'Company Status', 'Company Detail', 'Linked Company', 'Linked Company ID', 'Contact Status', 'Contact Detail', 'Contact ID'],
      document.rows.map((row) => {
        const group = groupByRow.get(row.rowNumber)
        const linked = group ? confirmed[group.key] : undefined
        const server = commitByRow.get(row.rowNumber)
        const planned = rowResult.get(row.rowNumber)
        const contactStatus = server?.status
          ?? (planned && planned.status !== 'ready' ? ROW_STATUS[planned.status] : group ? GROUP_STATUS[stateOf(group)].label : '')
        return [
          row.rowNumber,
          row.personLinkedin,
          row.fullName,
          row.companyName,
          group ? GROUP_STATUS[stateOf(group)].label : '',
          group ? [groupWhere(group), group.reason].filter(Boolean).join(' · ') : '',
          linked?.name ?? '',
          linked?.id ?? '',
          contactStatus,
          server?.error ?? planned?.reason ?? '',
          server?.contactId ?? planned?.contactIds?.[0] ?? '',
        ]
      }),
    )
  }

  const groupList = (list: LeadGroup[], caption: string) => (
    <TableFrame scrollLabel={caption} maxHeight={320}>
      <Table caption={caption} className="min-w-[720px] [&_td]:align-top">
        <thead>
          <tr>
            <th scope="col">Company</th>
            <th scope="col">Leads</th>
            <th scope="col">Where</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {list.map((group) => (
            <tr key={group.key}>
              <td><strong>{group.companyName || 'Unnamed company'}</strong><div className="text-app-meta text-app-text-muted">{group.domain}</div></td>
              <td className="tabular-nums">{group.rowNumbers.length}</td>
              <td>{groupWhere(group) || GROUP_STATUS[group.status].label}</td>
              <td className="text-app-meta text-app-text-muted">{group.reason}</td>
            </tr>
          ))}
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
          description="Written to the Contacts “Added by” field on every new contact."
        >
          <AddedByField state={metadata} value={addedBy} onChange={setAddedBy} tableLabel="Contacts" />
        </Stage>
      )}

      {!document && (
        <CsvUploadCard
          title="Upload a leads CSV"
          hint={<>Each lead is linked to a Companies record you confirm. Leads whose company is still waiting in DB are held, not dropped. Up to 500 rows · maximum 5 MB. Email, phone and profile columns are ignored.</>}
          disabled={metadata.busy || !!metadata.error}
          onFile={(file) => void chooseFile(file)}
        />
      )}

      {document && !preview && busy && (
        <Stage title="Checking Airtable" description={`${document.fileName} · ${plural(document.rowCount, 'lead')}`}>
          <UpdatingNote>Matching companies in Companies and DB…</UpdatingNote>
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
            title="Confirm companies"
            description={`${document.fileName} · ${plural(document.rowCount, 'lead')} · ${plural(groups.length, 'company', 'companies')}`}
            aside={
              <Button
                size="sm"
                icon={<CheckCircle2 aria-hidden="true" />}
                disabled={!singleDomainMatches.length}
                onClick={confirmAllDomainMatches}
              >
                Confirm all single domain matches ({singleDomainMatches.length})
              </Button>
            }
          >
            {groups.length === 0 && <Notice>No lead in this file can be imported.</Notice>}
            {groups.length > 0 && (
              <TableFrame scrollLabel="Companies to confirm" maxHeight={560}>
                <Table caption="Companies to confirm" className="min-w-[1040px] [&_td]:align-top">
                  <thead>
                    <tr>
                      <th scope="col">CSV company</th>
                      <th scope="col">Leads</th>
                      <th scope="col">Status</th>
                      <th scope="col">Airtable company</th>
                      <th scope="col" aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => {
                      const state = stateOf(group)
                      const linked = confirmed[group.key] ?? group.suggestion
                      return (
                        <tr key={group.key} data-group={group.key}>
                          <td>
                            <strong>{group.companyName || 'Unnamed company'}</strong>
                            <div className="text-app-meta text-app-text-muted">{group.domain || group.linkedin || 'No domain'}</div>
                          </td>
                          <td className="tabular-nums">{group.rowNumbers.length}</td>
                          <td>
                            <Badge tone={GROUP_STATUS[state].tone}>{GROUP_STATUS[state].label}</Badge>
                            <div className="text-app-meta text-app-text-muted mt-app-xs">
                              {groupWhere(group) && <div>{groupWhere(group)}</div>}
                              {!confirmed[group.key] && group.reason}
                            </div>
                          </td>
                          <td>
                            {linked ? (
                              <>
                                <strong>{linked.name || 'Unnamed company'}</strong>
                                <div className="text-app-meta text-app-text-muted">
                                  {[
                                    confirmed[group.key] && confirmed[group.key].id !== group.suggestion?.id
                                      ? 'Chosen manually'
                                      : group.method && METHOD_LABEL[group.method],
                                    linked.website,
                                    linked.approveStatus && `Companies · ${linked.approveStatus}`,
                                  ].filter(Boolean).join(' · ')}
                                </div>
                              </>
                            ) : (
                              <span className="text-app-text-muted">
                                {group.status === 'ambiguous' ? `${group.candidates.length} candidates` : '—'}
                              </span>
                            )}
                          </td>
                          <td className="text-right whitespace-nowrap">
                            {canLink(group) && !confirmed[group.key] && group.suggestion && (
                              <Button size="sm" variant="primary" onClick={() => confirm(group, group.suggestion!)}>
                                Confirm
                              </Button>
                            )}
                            {confirmed[group.key] && (
                              <Button size="sm" variant="ghost" icon={<Undo2 aria-hidden="true" />} onClick={() => unconfirm(group)}>
                                Undo
                              </Button>
                            )}
                            {canLink(group) && (
                              <Button size="sm" variant="ghost" icon={<Search aria-hidden="true" />} onClick={() => setPickerKey(group.key)}>
                                {group.suggestion || confirmed[group.key] ? 'Change' : 'Choose'}
                              </Button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </Table>
              </TableFrame>
            )}

            {skippedRows.length > 0 && (
              <div className="mt-section">
                <SectionHeader level="subsection" title={`${plural(skippedRows.length, 'lead')} will not be imported`} />
                <TableFrame scrollLabel="Leads that will not be imported" maxHeight={240}>
                  <Table caption="Leads that will not be imported" className="min-w-[720px]">
                    <thead>
                      <tr>
                        <th scope="col">Row</th>
                        <th scope="col">Lead</th>
                        <th scope="col">Status</th>
                        <th scope="col">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {skippedRows.map((row) => (
                        <tr key={row.rowNumber}>
                          <td className="tabular-nums">{row.rowNumber}</td>
                          <td>{rowsByNumber.get(row.rowNumber)?.fullName || rowsByNumber.get(row.rowNumber)?.personLinkedin}</td>
                          <td><Badge tone={row.status === 'invalid' ? 'danger' : 'neutral'}>{ROW_STATUS[row.status]}</Badge></td>
                          <td className="text-app-meta text-app-text-muted">{row.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </TableFrame>
              </div>
            )}
          </Stage>
          <StageActions summary={<>
            <strong>{leadsToCreate}</strong> {leadsToCreate === 1 ? 'lead' : 'leads'} in {plural(confirmedGroups.length, 'confirmed company', 'confirmed companies')} will be created in Contacts
            {leadCount(heldGroups) > 0 && <> · <strong>{leadCount(heldGroups)}</strong> held</>}
            {leadCount(declinedGroups) > 0 && <> · <strong>{leadCount(declinedGroups)}</strong> declined</>}
            {!addedBy && <span className="text-app-text-muted"> · Select Added by first.</span>}
          </>}>
            <Button variant="ghost" icon={<RotateCcw aria-hidden="true" />} onClick={reset} disabled={busy}>Start over</Button>
            <Button icon={<RefreshCw aria-hidden="true" />} disabled={busy} onClick={() => void runPreview(document, true)}>
              Re-check
            </Button>
            <Button
              variant="primary"
              icon={<Users aria-hidden="true" />}
              loading={busy}
              disabled={!addedBy || !leadsToCreate}
              onClick={() => void commit()}
            >
              Create {plural(leadsToCreate, 'contact')}
            </Button>
          </StageActions>
        </>
      )}

      {document && preview && committed && (
        <>
          <Stage
            title="Import results"
            description={`${plural(committed.counts.created, 'contact')} created · ${committed.counts.duplicate} existing · ${committed.counts.failed} failed`}
            aside={<CheckCircle2 size={28} aria-hidden="true" className="text-app-success shrink-0" />}
          >
            {heldGroups.length > 0 && (
              <div className="mt-section">
                <SectionHeader
                  level="subsection"
                  title={`${plural(leadCount(heldGroups), 'lead')} held — ${plural(heldGroups.length, 'company', 'companies')} awaiting approval`}
                  description="Ask an SDR to approve these companies in DB. Once Airtable moves them into Companies, press Re-check."
                />
                {groupList(heldGroups, 'Companies awaiting approval')}
              </div>
            )}
            {declinedGroups.length > 0 && (
              <div className="mt-section">
                <SectionHeader
                  level="subsection"
                  title={`${plural(leadCount(declinedGroups), 'lead')} skipped — ${plural(declinedGroups.length, 'company', 'companies')} declined`}
                />
                {groupList(declinedGroups, 'Declined companies')}
              </div>
            )}
            {unconfirmedGroups.length > 0 && (
              <Notice>
                {plural(leadCount(unconfirmedGroups), 'lead')} in {plural(unconfirmedGroups.length, 'company', 'companies')} were not confirmed and were not imported. Re-check to confirm them.
              </Notice>
            )}
            {failedRows.length > 0 && (
              <Notice>
                {plural(failedRows.length, 'contact')} failed: {failedRows.slice(0, 3).map((row) => `row ${row.rowNumber} (${row.error})`).join('; ')}
                {failedRows.length > 3 ? '…' : ''} Re-check before trying again; anything that did land shows as existing.
              </Notice>
            )}
          </Stage>
          <StageActions summary="Re-check runs the preview again on this file; created contacts show as existing.">
            <Button icon={<Download aria-hidden="true" />} onClick={downloadReport}>Download report</Button>
            <Button variant="primary" icon={<RefreshCw aria-hidden="true" />} loading={busy} onClick={() => void runPreview(document, true)}>
              Re-check
            </Button>
            <Button variant="ghost" icon={<RotateCcw aria-hidden="true" />} onClick={reset} disabled={busy}>New upload</Button>
          </StageActions>
        </>
      )}

      {pickerGroup && (
        <CompanyResolutionModal
          sourceCompany={pickerGroup.companyName}
          affectedRows={pickerGroup.rowNumbers.length}
          suggestions={pickerGroup.candidates}
          onSelect={(company) => {
            confirm(pickerGroup, company)
            setPickerKey(null)
          }}
          onClose={() => setPickerKey(null)}
        />
      )}
    </>
  )
}
