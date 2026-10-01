import { Fragment, useMemo, useState } from 'react'
import {
  CheckCircle2, ChevronDown, ChevronRight, Download, ExternalLink, RefreshCw, RotateCcw, Search, Undo2, Users,
} from 'lucide-react'
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
  LeadRowResult,
} from '../lib/importApi'
import { useToast } from '../lib/ToastContext'
import {
  Badge, Button, ExternalLinkButton, Field, InlineError, Input, SectionHeader, Table, TableFrame, UpdatingNote, type Tone,
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
//
// An export names one company per lead even when the person has several
// current jobs, so a single lead can also be linked on its own. When the CSV
// company is in neither DB nor Companies and the headline names exactly one
// Companies record, the lead is linked to it automatically (with Undo); when
// the headline names several, the user picks one.
//
// The export's title is wrong just as often for such a lead: it names one job
// of several. Every lead's title can be edited before it is written, and a lead
// with more than one current job has no title until the SDR types the one for
// the company it is linked to; Create stays disabled until they do.

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

type LeadLink = { company: AirtableCompany; auto: boolean }

const TITLE_MAX = 200
const TITLE_LIST_ID = 'lead-import-titles'
const COMMON_TITLES = [
  'CEO', 'Co-Founder & CEO', 'Founder', 'President', 'Owner', 'Managing Director', 'General Manager',
  'COO', 'CTO', 'CFO', 'CMO', 'CRO', 'CPO', 'Chief Medical Officer',
  'VP of Sales', 'VP of Engineering', 'VP of Marketing', 'VP of Operations',
  'Head of Sales', 'Head of Engineering', 'Head of Product', 'Head of Marketing',
  'Director of Sales', 'Sales Director', 'Lead Sales Representative', 'Sales Representative',
  'Board Member', 'Advisor', 'Partner',
]

/** A lead whose export names one of several current jobs; its CSV title cannot be trusted. */
const needsTitle = (row: LeadImportRow | undefined) => (row?.currentJobs ?? 0) > 1
type Picker = { groupKey: string; rowNumber?: number }

/** Links made without a click: a not-uploaded company whose lead's headline names exactly one Companies record. */
function autoLinks(response: LeadPreviewResponse): Record<number, LeadLink> {
  const byRow = new Map(response.rows.map((row) => [row.rowNumber, row]))
  const links: Record<number, LeadLink> = {}
  for (const group of response.groups) {
    if (group.status !== 'not_uploaded') continue
    for (const rowNumber of group.rowNumbers) {
      const matches = byRow.get(rowNumber)?.headlineMatches ?? []
      if (matches.length === 1) links[rowNumber] = { company: matches[0], auto: true }
    }
  }
  return links
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
  const [leadLinks, setLeadLinks] = useState<Record<number, LeadLink>>({})
  /** Titles the SDR typed, by row; they survive Re-check because the file does not change. */
  const [titles, setTitles] = useState<Record<number, string>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [picker, setPicker] = useState<Picker | null>(null)
  const [committed, setCommitted] = useState<ContactCommitResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rowsByNumber = useMemo(
    () => new Map((document?.rows ?? []).map((row) => [row.rowNumber, row])),
    [document],
  )
  const resultByRow = useMemo(
    () => new Map<number, LeadRowResult>((preview?.rows ?? []).map((row) => [row.rowNumber, row])),
    [preview],
  )
  const groups = preview?.groups ?? []
  const pickerGroup = groups.find((group) => group.key === picker?.groupKey) ?? null
  const pickerLead = picker?.rowNumber ? rowsByNumber.get(picker.rowNumber) : undefined
  const skippedRows = (preview?.rows ?? []).filter((row) => row.status !== 'ready')
  const stateOf = (group: LeadGroup): GroupState => (confirmed[group.key] ? 'confirmed' : group.status)
  const canLink = (group: LeadGroup) => group.status !== 'declined'
  /** Leads that follow the group's company rather than a link of their own. */
  const groupRowsOf = (group: LeadGroup) => group.rowNumbers.filter((rowNumber) => !leadLinks[rowNumber])
  const headlineMatchesOf = (group: LeadGroup, rowNumber: number) => {
    const own = new Set([group.suggestion?.id, confirmed[group.key]?.id])
    return (resultByRow.get(rowNumber)?.headlineMatches ?? []).filter((company) => !own.has(company.id))
  }
  const singleDomainMatches = groups.filter(
    (group) => group.status === 'suggested' && group.method === 'domain' && !confirmed[group.key],
  )
  const toCreate = groups.filter(canLink).flatMap((group) =>
    group.rowNumbers.flatMap((rowNumber) => {
      const company = leadLinks[rowNumber]?.company ?? confirmed[group.key]
      return company ? [{ rowNumber, company }] : []
    }),
  )
  const titleOf = (rowNumber: number) => {
    const row = rowsByNumber.get(rowNumber)
    return titles[rowNumber] ?? (needsTitle(row) ? '' : row?.title ?? '')
  }
  const untitled = toCreate.filter(({ rowNumber }) => !titleOf(rowNumber).trim()).length
  const leadsToCreate = toCreate.length
  const companiesToLink = new Set(toCreate.map((item) => item.company.id)).size
  const autoLinked = Object.values(leadLinks).filter((link) => link.auto).length

  const runPreview = async (doc: LeadCsvDocument, recheck = false) => {
    setBusy(true)
    setError(null)
    try {
      const response = await previewLeads(doc.rows, { forceCompanies: recheck })
      setPreview(response)
      setConfirmed({})
      setLeadLinks(autoLinks(response))
      setExpanded({})
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
      setTitles({})
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
    setLeadLinks({})
    setTitles({})
    setExpanded({})
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

  const linkLead = (rowNumber: number, company: AirtableCompany) =>
    setLeadLinks((current) => ({ ...current, [rowNumber]: { company, auto: false } }))

  const unlinkLead = (rowNumber: number) =>
    setLeadLinks((current) => {
      const next = { ...current }
      delete next[rowNumber]
      return next
    })

  const setTitle = (rowNumber: number, value: string) =>
    setTitles((current) => ({ ...current, [rowNumber]: value }))

  const confirmAllDomainMatches = () =>
    setConfirmed((current) => {
      const next = { ...current }
      for (const group of singleDomainMatches) if (group.suggestion) next[group.key] = group.suggestion
      return next
    })

  const commit = async () => {
    if (!addedBy || !leadsToCreate || untitled) return
    setBusy(true)
    setError(null)
    try {
      const rows = toCreate.map(({ rowNumber, company }) => {
        const row = rowsByNumber.get(rowNumber) as LeadImportRow
        return {
          rowNumber,
          personLinkedin: row.personLinkedin,
          firstName: row.firstName,
          fullName: row.fullName,
          title: titleOf(rowNumber).trim(),
          companyId: company.id,
          companyWebsite: row.companyWebsite,
        }
      })
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

  const heldGroups = groups.filter(
    (group) => (group.status === 'pending' || group.status === 'not_uploaded') && groupRowsOf(group).length,
  )
  const declinedGroups = groups.filter((group) => group.status === 'declined')
  const unconfirmedGroups = groups.filter(
    (group) =>
      (group.status === 'suggested' || group.status === 'ambiguous') && !confirmed[group.key] && groupRowsOf(group).length,
  )
  const leadCount = (list: LeadGroup[]) => list.reduce((total, group) => total + groupRowsOf(group).length, 0)
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
      ['Source Row', 'Person LinkedIn', 'Full Name', 'CSV Title', 'Title', 'CSV Company', 'Company Status', 'Company Detail', 'Linked Company', 'Linked Company ID', 'Contact Status', 'Contact Detail', 'Contact ID'],
      document.rows.map((row) => {
        const group = groupByRow.get(row.rowNumber)
        const own = leadLinks[row.rowNumber]
        const linked = group && canLink(group) ? own?.company ?? confirmed[group.key] : undefined
        const companyStatus = own
          ? own.auto ? 'Linked from headline' : 'Linked for this lead'
          : group ? GROUP_STATUS[stateOf(group)].label : ''
        const server = commitByRow.get(row.rowNumber)
        const planned = rowResult.get(row.rowNumber)
        const contactStatus = server?.status
          ?? (planned && planned.status !== 'ready' ? ROW_STATUS[planned.status] : companyStatus)
        return [
          row.rowNumber,
          row.personLinkedin,
          row.fullName,
          row.title,
          titleOf(row.rowNumber).trim(),
          row.companyName,
          companyStatus,
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
              <td className="tabular-nums">{groupRowsOf(group).length}</td>
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
          hint={<>Each lead is linked to a Companies record you confirm. Leads whose company is still waiting in DB are held, not dropped. A lead can also be linked on its own when its CSV company is not the right one. Up to 500 rows · maximum 5 MB. Email, phone and profile summary are ignored; the headline is used only to suggest a company.</>}
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
            <datalist id={TITLE_LIST_ID}>
              {COMMON_TITLES.map((title) => <option key={title} value={title} />)}
            </datalist>
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
                      const ownLinks = group.rowNumbers.filter((rowNumber) => leadLinks[rowNumber]).length
                      const hinted = group.rowNumbers.some((rowNumber) => headlineMatchesOf(group, rowNumber).length)
                      const multiJob = canLink(group) && group.rowNumbers.some((rowNumber) => needsTitle(rowsByNumber.get(rowNumber)))
                      const open = expanded[group.key]
                        ?? (group.status === 'pending' || group.status === 'not_uploaded' || hinted || multiJob || ownLinks > 0)
                      return (
                        <Fragment key={group.key}>
                        <tr data-group={group.key}>
                          <td>
                            <strong>{group.companyName || 'Unnamed company'}</strong>
                            <div className="text-app-meta text-app-text-muted">{group.domain || group.linkedin || 'No domain'}</div>
                          </td>
                          <td>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="tabular-nums"
                              aria-expanded={open}
                              aria-label={`${open ? 'Hide' : 'Show'} ${plural(group.rowNumbers.length, 'lead')} of ${group.companyName || 'this company'}`}
                              icon={open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                              onClick={() => setExpanded((current) => ({ ...current, [group.key]: !open }))}
                            >
                              {group.rowNumbers.length}
                            </Button>
                          </td>
                          <td>
                            <Badge tone={GROUP_STATUS[state].tone}>{GROUP_STATUS[state].label}</Badge>
                            <div className="text-app-meta text-app-text-muted mt-app-xs">
                              {groupWhere(group) && <div>{groupWhere(group)}</div>}
                              {ownLinks > 0 && canLink(group) && (
                                <div>{ownLinks === group.rowNumbers.length ? 'Every lead' : plural(ownLinks, 'lead')} linked on its own</div>
                              )}
                              {!confirmed[group.key] && ownLinks < group.rowNumbers.length && group.reason}
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
                              <Button size="sm" variant="ghost" icon={<Search aria-hidden="true" />} onClick={() => setPicker({ groupKey: group.key })}>
                                {group.suggestion || confirmed[group.key] ? 'Change' : 'Choose'}
                              </Button>
                            )}
                          </td>
                        </tr>
                        {open && (
                          <tr data-leads={group.key}>
                            <td colSpan={5} className="pt-0">
                              <ul aria-label={`Leads of ${group.companyName || 'this company'}`} className="flex flex-col gap-app-sm pl-app-md border-l-2 border-app-border">
                                {group.rowNumbers.map((rowNumber) => {
                                  const lead = rowsByNumber.get(rowNumber)
                                  if (!lead) return null
                                  const own = leadLinks[rowNumber]
                                  const matches = headlineMatchesOf(group, rowNumber)
                                  const target = own?.company ?? confirmed[group.key] ?? group.suggestion
                                  const multi = needsTitle(lead)
                                  const title = titleOf(rowNumber)
                                  return (
                                    <li key={rowNumber} data-lead={rowNumber} className="flex items-start justify-between gap-app-md">
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-app-sm flex-wrap">
                                          <strong>{lead.fullName || lead.personLinkedin}</strong>
                                          {lead.currentJobs > 1 && <Badge tone="warning">{lead.currentJobs} current jobs</Badge>}
                                        </div>
                                        {lead.headline && (
                                          <div className="text-app-meta text-app-text-muted">{lead.headline}</div>
                                        )}
                                        {canLink(group) && (
                                          <Field
                                            className="mt-app-xs w-[360px] max-w-full"
                                            label="Title"
                                            required={multi}
                                            help={multi
                                              ? `${lead.currentJobs} current jobs — enter the title at ${target?.name || 'the linked company'}${lead.title ? ` (CSV says “${lead.title}”)` : ''}`
                                              : lead.title && title.trim() !== lead.title.trim() ? `CSV says “${lead.title}”` : undefined}
                                            error={!title.trim() && titles[rowNumber] !== undefined ? 'Enter a title' : undefined}
                                          >
                                            {(args) => (
                                              <Input
                                                {...args}
                                                list={TITLE_LIST_ID}
                                                maxLength={TITLE_MAX}
                                                placeholder={multi ? 'e.g. CTO, CEO, President' : undefined}
                                                value={title}
                                                onChange={(event) => setTitle(rowNumber, event.target.value)}
                                              />
                                            )}
                                          </Field>
                                        )}
                                        {own && (
                                          <div className="text-app-meta mt-app-xs">
                                            Linked to <strong>{own.company.name || 'Unnamed company'}</strong>
                                            <span className="text-app-text-muted">
                                              {' · '}{own.auto ? 'Found in headline' : 'Chosen for this lead'}
                                              {own.company.approveStatus && ` · Companies · ${own.company.approveStatus}`}
                                            </span>
                                          </div>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-app-xs shrink-0 flex-wrap justify-end">
                                        {canLink(group) && !own && matches.map((company) => (
                                          <Button key={company.id} size="sm" variant="secondary" onClick={() => linkLead(rowNumber, company)}>
                                            Use {company.name || 'Unnamed company'}
                                          </Button>
                                        ))}
                                        {own && (
                                          <Button size="sm" variant="ghost" icon={<Undo2 aria-hidden="true" />} onClick={() => unlinkLead(rowNumber)}>
                                            Undo
                                          </Button>
                                        )}
                                        {canLink(group) && (
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            icon={<Search aria-hidden="true" />}
                                            onClick={() => setPicker({ groupKey: group.key, rowNumber })}
                                          >
                                            {own ? 'Change' : 'Choose for this lead'}
                                          </Button>
                                        )}
                                        <ExternalLinkButton
                                          variant="ghost"
                                          size="sm"
                                          href={lead.personLinkedin}
                                          target="_blank"
                                          rel="noreferrer"
                                          icon={<ExternalLink aria-hidden="true" />}
                                        >
                                          LinkedIn
                                        </ExternalLinkButton>
                                      </div>
                                    </li>
                                  )
                                })}
                              </ul>
                            </td>
                          </tr>
                        )}
                        </Fragment>
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
            <strong>{leadsToCreate}</strong> {leadsToCreate === 1 ? 'lead' : 'leads'} in {plural(companiesToLink, 'company', 'companies')} will be created in Contacts
            {autoLinked > 0 && <> · <strong>{autoLinked}</strong> linked from headline</>}
            {leadCount(heldGroups) > 0 && <> · <strong>{leadCount(heldGroups)}</strong> held</>}
            {leadCount(declinedGroups) > 0 && <> · <strong>{leadCount(declinedGroups)}</strong> declined</>}
            {untitled > 0 && <span className="text-app-text-muted"> · Enter a title for {plural(untitled, 'lead')} first.</span>}
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
              disabled={!addedBy || !leadsToCreate || untitled > 0}
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
          affectedRows={groupRowsOf(pickerGroup).length}
          leadName={pickerLead ? pickerLead.fullName || pickerLead.personLinkedin : undefined}
          initialQuery={pickerLead ? headlineMatchesOf(pickerGroup, pickerLead.rowNumber)[0]?.name ?? '' : undefined}
          suggestions={
            pickerLead
              ? [...new Map(
                  [...headlineMatchesOf(pickerGroup, pickerLead.rowNumber), ...pickerGroup.candidates]
                    .map((company) => [company.id, company]),
                ).values()]
              : pickerGroup.candidates
          }
          onSelect={(company) => {
            if (pickerLead) linkLead(pickerLead.rowNumber, company)
            else confirm(pickerGroup, company)
            setPicker(null)
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  )
}
