import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Building2, ExternalLink, Users } from 'lucide-react'
import {
  AccountIdentity, Button, EmptyState, ExternalLinkButton, InlineError, PageHeader, Panel,
  SectionHeader, Table, TableFrame, TableToolbar, UpdatingNote,
} from '../ui'
import { KpiGrid, KpiTile } from '../components/KpiTile'
import { RowOpenButton } from '../components/RowOpenButton'
import { LeadMilestoneBadge, LeadReplyBadges, LeadReplyIdentity } from '../components/leads-and-replies/LeadReplyIdentity'
import { useData } from '../lib/DataContext'
import { useConversation } from '../lib/ConversationContext'
import { withLeadEdits } from '../lib/leadEdits'
import { accountLabeller } from '../lib/leads'
import { num, shortDate } from '../lib/format'
import { businessDateKey } from '../lib/followUps'
import { fetchNeonLeadsSearchPage } from '../lib/dashboardReads'
import { baseLabel, fetchCompanyDetail, locationLine, percent } from '../lib/companies'
import type { CompanyDetail as CompanyDetailRow } from '../lib/companies'
import type { LeadsSearchPage } from '../lib/types'

const PAGE_SIZE = 50

const externalHref = (value: string) => (/^https?:\/\//i.test(value) ? value : `https://${value}`)
const isUrl = (value: string) => /^https?:\/\/\S+$/i.test(value.trim())

/** A long text shown as a few lines, with "More" to read it all. */
function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col items-start gap-app-xs">
      <p className={`m-0 whitespace-pre-wrap [overflow-wrap:anywhere] ${open ? '' : 'line-clamp-4'}`}>{text}</p>
      <Button variant="ghost" size="sm" className="px-0" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Less' : 'More'}
      </Button>
    </div>
  )
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** One object inside an Airtable value: an attachment, a collaborator, a button. */
function objectLabel(value: Record<string, unknown>): { label: string; href?: string } {
  const label = [value.filename, value.name, value.label, value.email, value.text]
    .find((v) => typeof v === 'string' && v) as string | undefined
  const href = typeof value.url === 'string' ? value.url : undefined
  return { label: label ?? href ?? JSON.stringify(value), href }
}

/** Every Airtable field type, rendered as text a person can read. */
export function FieldValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return <span className="text-app-text-muted">—</span>
  }
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>
  if (typeof value === 'number') return <span className="tabular-nums">{value.toLocaleString('en-US')}</span>
  if (typeof value === 'string') {
    if (isUrl(value)) {
      return <a className="text-app-accent [overflow-wrap:anywhere]" href={value} target="_blank" rel="noreferrer">{value}</a>
    }
    return value.length > 240 || value.split('\n').length > 4
      ? <LongText text={value} />
      : <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</span>
  }
  if (Array.isArray(value)) {
    if (value.every(isPrimitive)) return <span className="[overflow-wrap:anywhere]">{value.map(String).join(', ')}</span>
    return (
      <ul className="m-0 pl-0 list-none flex flex-col gap-app-xs">
        {value.map((item, index) => <li key={index}><FieldValue value={item} /></li>)}
      </ul>
    )
  }
  if (typeof value === 'object') {
    const { label, href } = objectLabel(value as Record<string, unknown>)
    return href
      ? <a className="text-app-accent [overflow-wrap:anywhere]" href={href} target="_blank" rel="noreferrer">{label}</a>
      : <span className="[overflow-wrap:anywhere]">{label}</span>
  }
  return <>{String(value)}</>
}

/**
 * `#/companies/:base/:recordId` — one Airtable company: who it is (every
 * Airtable field), how its people responded, and the people themselves. A row
 * opens the conversation, as on Leads.
 */
export function CompanyDetail() {
  const { base = '', recordId = '' } = useParams()
  const { data, leadEdits } = useData()
  const { openConversation } = useConversation()
  const [company, setCompany] = useState<CompanyDetailRow | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setCompany(undefined)
    fetchCompanyDetail(base, recordId)
      .then((row) => { if (!cancelled) setCompany(row) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [base, recordId, attempt])

  const [page, setPage] = useState(0)
  const [leads, setLeads] = useState<LeadsSearchPage | null>(null)
  const [leadsLoading, setLeadsLoading] = useState(false)
  const [leadsError, setLeadsError] = useState<string | null>(null)
  const [leadsAttempt, setLeadsAttempt] = useState(0)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { setPage(0) }, [base, recordId])
  useEffect(() => {
    let cancelled = false
    setLeadsLoading(true)
    setLeadsError(null)
    const startedAt = Date.now()
    fetchNeonLeadsSearchPage({
      inst: 'all', camp: 'all', stage: 'all', risk: 'all', pipe: 'all', who: 'all', gender: 'all',
      agebucket: 'all', follow: 'all', repliedSince: null, sentiment: null, intent: null, q: '',
      sort: 'last_action_at', dir: 'desc', today: businessDateKey(), page, pageSize: PAGE_SIZE,
      companyBase: base, companyRecordId: recordId,
    })
      .then((next) => { if (!cancelled) { setLeads(next); setFetchedAt(startedAt) } })
      .catch((e) => { if (!cancelled) setLeadsError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLeadsLoading(false) })
    return () => { cancelled = true }
  }, [base, recordId, page, leadsAttempt])

  const fields = useMemo(
    () => Object.entries(company?.fields ?? {}).sort(([a], [b]) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    [company],
  )

  const breadcrumb = [{ label: 'Companies', to: '/companies' }, { label: company?.name ?? 'Company' }]

  if (error) {
    return (
      <>
        <PageHeader title="Company" breadcrumb={breadcrumb} />
        <InlineError title="This company could not load." detail={error} onRetry={() => setAttempt((n) => n + 1)} />
      </>
    )
  }
  if (company === undefined) {
    return (
      <>
        <PageHeader title="Company" breadcrumb={breadcrumb} />
        <UpdatingNote>Loading the company…</UpdatingNote>
      </>
    )
  }
  if (company === null) {
    return (
      <>
        <PageHeader title="Company not found" breadcrumb={breadcrumb} />
        <EmptyState
          icon={Building2}
          title="This company is not in the synced Airtable data"
          hint="It may have been deleted in Airtable, or the link is wrong. Sync from Airtable on the Companies page to refresh."
        />
      </>
    )
  }

  const instanceLabel = accountLabeller(data?.instances)
  const campaignName = (id: string) => data?.campaigns.find((c) => c.campaign_id === id)?.campaign_name ?? id
  const rows = (leads?.items ?? []).map((item) => ({ item, lead: withLeadEdits(item.lead, leadEdits, fetchedAt) }))
  const total = leads?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const replyRate = company.invited > 0 ? company.replied / company.invited : null
  const maturingShare = company.invited > 0 ? company.maturing / company.invited : 0
  const description = [
    company.country_name ?? company.hq_country,
    company.industry,
    company.employees != null ? `${num(company.employees)} employees` : null,
    company.founded_year ? `founded ${company.founded_year}` : null,
    baseLabel(company.base_key),
  ].filter(Boolean).join(' · ')

  return (
    <>
      <PageHeader
        title={company.name || 'Unnamed company'}
        breadcrumb={breadcrumb}
        description={description || undefined}
        actions={(
          <>
            {company.website && (
              <ExternalLinkButton variant="secondary" href={externalHref(company.website)} target="_blank" rel="noreferrer" icon={<ExternalLink aria-hidden="true" />}>
                Website
              </ExternalLinkButton>
            )}
            {company.linkedin_url && (
              <ExternalLinkButton variant="secondary" href={externalHref(company.linkedin_url)} target="_blank" rel="noreferrer" icon={<ExternalLink aria-hidden="true" />}>
                LinkedIn
              </ExternalLinkButton>
            )}
          </>
        )}
      />

      <KpiGrid>
        <KpiTile label="People" value={num(company.leads)} sub={`${num(company.accounts)} ${company.accounts === 1 ? 'account' : 'accounts'}`} />
        <KpiTile label="Invited" value={num(company.invited)} sub={maturingShare >= 0.3 ? `${percent(maturingShare)} under 21 days — still maturing` : undefined} />
        <KpiTile label="Accepted" value={percent(company.accept_rate)} sub={`${num(company.accepted_of_invited)} of ${num(company.invited)} invited`} />
        <KpiTile label="Replied" value={num(company.replied)} sub={replyRate != null ? `${percent(replyRate)} of invited` : undefined} />
        <KpiTile label="P3" value={num(company.p3)} sub="buying intent" />
        <KpiTile label="Last activity" value={shortDate(company.last_activity)} />
      </KpiGrid>

      {leadsError && (
        <InlineError title="This company's leads could not load." detail={leadsError} onRetry={() => setLeadsAttempt((n) => n + 1)} />
      )}
      <TableFrame
        scrollLabel="Leads at this company"
        className="mb-section"
        scrollRef={scrollRef}
        busy={leadsLoading}
        toolbar={(
          <TableToolbar count={<>
            {num(total)} {total === 1 ? 'lead' : 'leads'} at this company
            {leadsLoading && <> <UpdatingNote /></>}
          </>} />
        )}
        hint={pages > 1 ? (
          <div className="flex justify-center items-center gap-app-lg">
            <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => { setPage(page - 1); scrollRef.current?.scrollTo({ top: 0 }) }}>← Previous</Button>
            <span>Page {page + 1} of {pages}</span>
            <Button variant="secondary" size="sm" disabled={page >= pages - 1} onClick={() => { setPage(page + 1); scrollRef.current?.scrollTo({ top: 0 }) }}>Next →</Button>
          </div>
        ) : undefined}
      >
        <Table caption="Leads at this company">
          <thead>
            <tr>
              <th scope="col">Lead</th>
              <th scope="col">Reply</th>
              <th scope="col">Account / campaign</th>
              <th scope="col">Milestone</th>
              <th scope="col">Location</th>
              <th scope="col">Latest activity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, lead }) => (
              <tr
                key={lead.id}
                className="ui-table__row--identity relative cursor-pointer"
                onClick={() => openConversation(lead)}
              >
                <td onClick={(event) => event.stopPropagation()}>
                  <RowOpenButton label={`Open conversation with ${lead.full_name || 'lead'}`} onOpen={() => openConversation(lead)} />
                  <LeadReplyIdentity lead={lead} showSnippet={false} showBadges={false} />
                </td>
                <td>
                  {item.reply?.sentiment || item.highestIntent ? (
                    <div className="flex items-center gap-app-xs whitespace-nowrap">
                      <LeadReplyBadges reply={item.reply} highestIntent={item.highestIntent} />
                    </div>
                  ) : <span className="text-app-text-muted">—</span>}
                </td>
                <td>
                  <AccountIdentity name={instanceLabel(lead.instance_id)} secondary={campaignName(lead.campaign_id)} title={campaignName(lead.campaign_id)} />
                </td>
                <td><LeadMilestoneBadge lead={lead} /></td>
                <td className="max-w-[220px] truncate" title={lead.location ?? undefined}>{locationLine(lead.location, lead.country_code) ?? '—'}</td>
                <td className="whitespace-nowrap text-app-text-muted">{shortDate(lead.last_action_at)}</td>
              </tr>
            ))}
            {rows.length === 0 && !leadsLoading && !leadsError && (
              <tr>
                <td colSpan={6}>
                  <EmptyState icon={Users} title="No leads are linked to this company" hint="Leads link by their Airtable contact, or by hand from Unlinked leads." />
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </TableFrame>

      <Panel className="mb-section" aria-labelledby="company-airtable-fields">
        <SectionHeader
          id="company-airtable-fields"
          title="Airtable fields"
          description={`Every field of this record in ${baseLabel(company.base_key)}${company.synced_at ? `, synced ${shortDate(company.synced_at)}` : ''}.`}
        />
        {fields.length === 0 ? (
          <p className="m-0 text-app-meta text-app-text-muted">No fields were synced for this company.</p>
        ) : (
          <dl className="m-0 grid grid-cols-[minmax(140px,240px)_minmax(0,1fr)] gap-x-group gap-y-stack text-app-table" data-company-fields="">
            {fields.map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="text-app-text-muted [overflow-wrap:anywhere]">{name}</dt>
                <dd className="m-0 min-w-0"><FieldValue value={value} /></dd>
              </div>
            ))}
          </dl>
        )}
      </Panel>
    </>
  )
}
