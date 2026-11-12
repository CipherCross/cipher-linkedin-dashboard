import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Building2, Filter, Globe2, Link2, RefreshCw, SearchX, UserX } from 'lucide-react'
import {
  ActiveFilters, Badge, Button, Dialog, EmptyState, FilterCount, FilterDialog, InlineError,
  Panel, PageHeader, SectionHeader, SegmentedControl, SelectField, SortHeader, Table,
  TableFrame, TableToolbar, Tabs, TextField, Toolbar, UpdatingNote,
} from '../ui'
import type { ActiveFilter } from '../ui'
import { COPY } from '../ui/labels'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import { accountLabeller } from '../lib/leads'
import { num, shortDate } from '../lib/format'
import { AIRTABLE_BASES } from '../lib/airtableBases'
import {
  COMPANY_SIZE_OPTIONS, baseLabel, companyHref, countryName, fetchCompaniesPage, fetchCountriesFunnel,
  fetchUnlinkedLeads, linkLeadToCompany, locationLine, percent, runAirtableSync,
} from '../lib/companies'
import type {
  CompaniesPage, CompanyRow, CountriesFunnel, CountryAxis, UnlinkedLead, UnlinkedPage,
} from '../lib/companies'

const PAGE_SIZE = 50

type TabId = 'companies' | 'countries' | 'unlinked'
const TAB_IDS: TabId[] = ['companies', 'countries', 'unlinked']

type SortKey = 'name' | 'country' | 'employees' | 'leads' | 'invited' | 'accept_rate' | 'replied' | 'p3' | 'last_activity'
const SORT_KEYS: SortKey[] = ['name', 'country', 'employees', 'leads', 'invited', 'accept_rate', 'replied', 'p3', 'last_activity']

/** Filters that live in the sheet and are committed together on Apply. */
const SHEET_KEYS = ['inst', 'industry', 'size', 'approve', 'base', 'reply'] as const

function sizeLabel(employees: number | null): string {
  return employees == null ? '—' : num(employees)
}

/** Writes URL params: a value of '' / 'all' / null deletes the key, and any
 *  change returns the list to its first page. */
function useParamWriter() {
  const [params, setParams] = useSearchParams()
  const replaceAll = (next: URLSearchParams) => setParams(next, { replace: true })
  const write = (updates: Record<string, string | null>, keepPage = false) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === '' || value === 'all') next.delete(key)
        else next.set(key, value)
      }
      if (!keepPage) next.delete('page')
      return next
    }, { replace: true })
  }
  return { params, write, replaceAll }
}

/** Search typed into local state, committed to `q` 250ms after the last key. */
function useDebouncedQuery(q: string, commit: (value: string) => void) {
  const [input, setInput] = useState(q)
  useEffect(() => { setInput(q) }, [q])
  useEffect(() => {
    const id = setTimeout(() => {
      if (input.trim() !== q) commit(input.trim())
    }, 250)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input])
  return [input, setInput] as const
}

/**
 * `#/companies` — the Airtable companies the team writes to, the funnel per
 * country, and the people not yet linked to a company. Every number is per
 * person; every rate is over invited people (replies lag invites, so a young
 * cohort is flagged as maturing rather than compared as if it were complete).
 */
export function Companies() {
  const { params, replaceAll } = useParamWriter()
  const toast = useToast()
  const rawTab = params.get('tab')
  const tab: TabId = TAB_IDS.includes(rawTab as TabId) ? (rawTab as TabId) : 'companies'
  const [reloadKey, setReloadKey] = useState(0)
  const [sync, setSync] = useState<{ round: number; companies: number; contacts: number } | null>(null)

  const switchTab = (next: TabId) => {
    // Each tab owns its own filters; only the account carries over.
    const inst = params.get('inst')
    const fresh = new URLSearchParams()
    if (next !== 'companies') fresh.set('tab', next)
    if (inst) fresh.set('inst', inst)
    replaceAll(fresh)
  }

  async function runSync() {
    setSync({ round: 0, companies: 0, contacts: 0 })
    try {
      const summary = await runAirtableSync((round, result) => {
        setSync((prev) => ({
          round,
          companies: (prev?.companies ?? 0) + result.bases.reduce((n, b) => n + (b.companies?.upserted ?? 0), 0),
          contacts: (prev?.contacts ?? 0) + result.bases.reduce((n, b) => n + (b.contacts?.upserted ?? 0), 0),
        }))
      })
      const links = summary.links
      const parts = [
        `${num(summary.companies)} companies and ${num(summary.contacts)} contacts updated`,
        links ? `${num(links.matched)} of ${num(links.leads)} leads linked (${num(links.changed)} changed)` : null,
      ].filter(Boolean)
      if (summary.errors.length) toast.error(`Airtable sync finished with errors: ${summary.errors.join('; ')}`)
      if (summary.done) toast.success(`Synced from Airtable: ${parts.join('; ')}.`)
      else toast.info(`Airtable sync is not finished yet (${parts.join('; ')}). Sync again to continue.`)
    } catch (error) {
      toast.error(`Couldn't sync from Airtable: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSync(null)
      setReloadKey((key) => key + 1)
    }
  }

  return (
    <>
      <PageHeader
        title="Companies"
        description="Airtable companies the team writes to, how they respond, and where they are."
        context={sync ? (
          <UpdatingNote>
            Syncing from Airtable{sync.round ? ` — round ${sync.round}: ${num(sync.companies)} companies, ${num(sync.contacts)} contacts` : '…'}
          </UpdatingNote>
        ) : undefined}
        actions={(
          <Button
            variant="primary"
            icon={<RefreshCw aria-hidden="true" />}
            loading={sync !== null}
            onClick={() => void runSync()}
          >Sync from Airtable</Button>
        )}
      />
      <Tabs<TabId>
        label="Companies views"
        className="mb-section"
        value={tab}
        onChange={switchTab}
        items={[
          { id: 'companies', label: 'Companies' },
          { id: 'countries', label: 'Countries' },
          { id: 'unlinked', label: 'Unlinked leads' },
        ]}
      />
      {tab === 'companies' && <CompaniesTab reloadKey={reloadKey} />}
      {tab === 'countries' && <CountriesTab reloadKey={reloadKey} />}
      {tab === 'unlinked' && <UnlinkedTab reloadKey={reloadKey} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

function CompaniesTab({ reloadKey }: { reloadKey: number }) {
  const { data } = useData()
  const navigate = useNavigate()
  const { params, write } = useParamWriter()
  const scrollRef = useRef<HTMLDivElement>(null)

  const q = params.get('q') ?? ''
  const country = params.get('country') ?? 'all'
  const filters = Object.fromEntries(SHEET_KEYS.map((key) => [key, params.get(key) ?? 'all'])) as Record<typeof SHEET_KEYS[number], string>
  const rawSort = params.get('sort')
  const sort: SortKey = SORT_KEYS.includes(rawSort as SortKey) ? (rawSort as SortKey) : 'leads'
  const dir: 'asc' | 'desc' = params.get('dir') === 'asc' ? 'asc' : params.get('dir') === 'desc' ? 'desc' : sort === 'name' || sort === 'country' ? 'asc' : 'desc'
  const page = Math.max(0, (Number(params.get('page')) || 1) - 1)

  const [qInput, setQInput] = useDebouncedQuery(q, (value) => write({ q: value }))
  const [result, setResult] = useState<CompaniesPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [draft, setDraft] = useState<Record<string, string> | null>(null)

  const query = useMemo(() => ({
    q, country, ...filters, sort, dir, page, pageSize: PAGE_SIZE,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [q, country, sort, dir, page, ...SHEET_KEYS.map((key) => filters[key])])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchCompaniesPage(query)
      .then((next) => { if (!cancelled) setResult(next) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query, reloadKey, retry])

  const instanceLabel = accountLabeller(data?.instances)
  const facets = result?.facets
  const countryOptions = facets?.countries ?? []
  const sheetCount = SHEET_KEYS.filter((key) => filters[key] !== 'all').length

  const active: ActiveFilter[] = []
  if (q) active.push({ id: 'q', label: 'Search', value: q, onRemove: () => write({ q: null }) })
  if (country !== 'all') active.push({
    id: 'country', label: 'HQ country',
    value: country === 'unknown' ? 'Unknown' : countryOptions.find((o) => o.value === country)?.label ?? countryName(country) ?? country,
    onRemove: () => write({ country: null }),
  })
  if (filters.inst !== 'all') active.push({ id: 'inst', label: 'Account', value: instanceLabel(filters.inst), onRemove: () => write({ inst: null }) })
  if (filters.industry !== 'all') active.push({ id: 'industry', label: 'Industry', value: filters.industry, onRemove: () => write({ industry: null }) })
  if (filters.size !== 'all') active.push({ id: 'size', label: 'Size', value: COMPANY_SIZE_OPTIONS.find((o) => o.id === filters.size)?.label ?? filters.size, onRemove: () => write({ size: null }) })
  if (filters.approve !== 'all') active.push({ id: 'approve', label: 'Approve status', value: filters.approve, onRemove: () => write({ approve: null }) })
  if (filters.base !== 'all') active.push({ id: 'base', label: 'Base', value: baseLabel(filters.base), onRemove: () => write({ base: null }) })
  if (filters.reply !== 'all') active.push({ id: 'reply', label: 'Replies', value: filters.reply === 'yes' ? 'Has replies' : 'No replies', onRemove: () => write({ reply: null }) })
  const clearAll = () => write(Object.fromEntries(['q', 'country', ...SHEET_KEYS, 'sort', 'dir'].map((key) => [key, null])))

  const onSort = (key: SortKey) => {
    const nextDir = key === sort ? (dir === 'asc' ? 'desc' : 'asc') : key === 'name' || key === 'country' ? 'asc' : 'desc'
    write({ sort: key, dir: nextDir })
  }
  const sortHeader = (key: SortKey, label: string, numeric = false) => (
    <SortHeader
      key={key}
      label={label}
      className={numeric ? 'ui-table__num' : ''}
      active={key === sort}
      direction={dir}
      onSort={() => onSort(key)}
    />
  )

  const total = result?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const goPage = (n: number) => {
    write({ page: n <= 0 ? null : String(n + 1) }, true)
    scrollRef.current?.scrollTo({ top: 0 })
  }
  const rows = result?.items ?? []

  return (
    <>
      <Toolbar>
        <TextField
          className="ui-toolbar__search"
          label="Search companies"
          labelHidden
          type="search"
          placeholder="Company name or domain…"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
        />
        <SelectField label="HQ country" labelHidden value={country} onChange={(e) => write({ country: e.target.value })}>
          <option value="all">All countries</option>
          {country !== 'all' && !countryOptions.some((o) => o.value === country) && (
            <option value={country}>{countryName(country) ?? country}</option>
          )}
          {countryOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label} ({num(o.count)})</option>
          ))}
        </SelectField>
        <Button
          variant="secondary"
          icon={<Filter aria-hidden="true" />}
          aria-expanded={draft !== null}
          onClick={() => setDraft({ ...filters })}
        >{COPY.filters}<FilterCount count={sheetCount} /></Button>
      </Toolbar>

      {draft && (
        <FilterDialog
          description="These apply on top of the search and the country. Nothing changes until you apply."
          selectedCount={SHEET_KEYS.filter((key) => (draft[key] ?? 'all') !== 'all').length}
          onClearAll={() => setDraft(Object.fromEntries(SHEET_KEYS.map((key) => [key, 'all'])))}
          onCancel={() => setDraft(null)}
          onApply={() => {
            const next = draft
            setDraft(null)
            write(Object.fromEntries(SHEET_KEYS.map((key) => [key, next[key] ?? 'all'])))
          }}
        >
          <div className="flex flex-col gap-group">
            <SelectField label="Account" help="Counts only the people this account reached." value={draft.inst} onChange={(e) => setDraft({ ...draft, inst: e.target.value })}>
              <option value="all">All accounts</option>
              {(data?.instances ?? []).map((i) => <option key={i.id} value={i.id}>{instanceLabel(i.id)}</option>)}
            </SelectField>
            <SelectField label="Industry" value={draft.industry} onChange={(e) => setDraft({ ...draft, industry: e.target.value })}>
              <option value="all">Any industry</option>
              {draft.industry !== 'all' && !facets?.industries.some((o) => o.value === draft.industry) && (
                <option value={draft.industry}>{draft.industry}</option>
              )}
              {(facets?.industries ?? []).map((o) => <option key={o.value} value={o.value}>{o.label} ({num(o.count)})</option>)}
            </SelectField>
            <SelectField label="Size" value={draft.size} onChange={(e) => setDraft({ ...draft, size: e.target.value })}>
              <option value="all">Any size</option>
              {COMPANY_SIZE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.id === 'unknown' ? 'Unknown' : `${o.label} employees`}</option>)}
            </SelectField>
            <SelectField label="Approve status" value={draft.approve} onChange={(e) => setDraft({ ...draft, approve: e.target.value })}>
              <option value="all">Any status</option>
              {draft.approve !== 'all' && !facets?.approveStatuses.some((o) => o.value === draft.approve) && (
                <option value={draft.approve}>{draft.approve}</option>
              )}
              {(facets?.approveStatuses ?? []).map((o) => <option key={o.value} value={o.value}>{o.label} ({num(o.count)})</option>)}
            </SelectField>
            <SelectField label="Airtable base" value={draft.base} onChange={(e) => setDraft({ ...draft, base: e.target.value })}>
              <option value="all">All bases</option>
              {AIRTABLE_BASES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </SelectField>
            <SelectField label="Replies" value={draft.reply} onChange={(e) => setDraft({ ...draft, reply: e.target.value })}>
              <option value="all">Any</option>
              <option value="yes">At least one reply</option>
              <option value="no">No replies yet</option>
            </SelectField>
          </div>
        </FilterDialog>
      )}

      <ActiveFilters filters={active} onClearAll={clearAll} />

      {error && (
        <InlineError
          title="Companies could not load."
          message="The list below may be incomplete or out of date."
          detail={error}
          onRetry={() => setRetry((n) => n + 1)}
        />
      )}

      <TableFrame
        scrollLabel="Companies"
        className="[&_.ui-table-scroll]:max-h-[calc(100vh-360px)] [&_.ui-table-scroll]:min-h-[280px]"
        scrollRef={scrollRef}
        busy={loading}
        toolbar={(
          <TableToolbar
            count={<>
              {num(total)} of {num(result?.allTotal ?? 0)} companies with linked leads
              {loading && <> <UpdatingNote /></>}
            </>}
          />
        )}
        hint={pages > 1 ? (
          <div className="flex justify-center items-center gap-app-lg">
            <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => goPage(page - 1)}>← Previous</Button>
            <span>Page {page + 1} of {pages}</span>
            <Button variant="secondary" size="sm" disabled={page >= pages - 1} onClick={() => goPage(page + 1)}>Next →</Button>
          </div>
        ) : 'Counts are people; Accept % is accepted ÷ invited.'}
      >
        <Table caption="Companies">
          <thead>
            <tr>
              {sortHeader('name', 'Company')}
              {sortHeader('country', 'HQ country')}
              <th scope="col">Industry</th>
              {sortHeader('employees', 'Size', true)}
              <th scope="col">AI niche</th>
              {sortHeader('leads', 'Leads', true)}
              {sortHeader('invited', 'Invited', true)}
              {sortHeader('accept_rate', 'Accept %', true)}
              {sortHeader('replied', 'Replies', true)}
              {sortHeader('p3', 'P3', true)}
              {sortHeader('last_activity', 'Last activity')}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <CompanyTableRow key={`${row.base_key}:${row.record_id}`} row={row} onOpen={() => navigate(companyHref(row))} />
            ))}
            {rows.length === 0 && !loading && !error && (
              <tr>
                <td colSpan={11}>
                  {active.length > 0 ? (
                    <EmptyState
                      kind="no-match"
                      icon={SearchX}
                      title="No companies match these filters"
                      hint="Adjust or clear the filters to see more companies."
                      action={<Button variant="secondary" size="sm" onClick={clearAll}>{COPY.clearFilters}</Button>}
                    />
                  ) : (
                    <EmptyState
                      kind="empty"
                      icon={Building2}
                      title="No companies linked yet"
                      hint="Sync from Airtable to mirror the Companies and Contacts tables and link leads to their companies."
                    />
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </TableFrame>
    </>
  )
}

function CompanyTableRow({ row, onOpen }: { row: CompanyRow; onOpen: () => void }) {
  const href = companyHref(row)
  return (
    <tr className="ui-table__row--identity cursor-pointer" data-company={row.record_id} onClick={onOpen}>
      <td>
        <div className="min-w-0 max-w-[260px]">
          <Link
            className="text-app-text no-underline hover:text-app-accent hover:underline font-semibold"
            to={href}
            onClick={(event) => event.stopPropagation()}
          >
            {row.name || 'Unnamed company'}
          </Link>
          <div className="truncate text-app-meta text-app-text-muted">
            {[row.domain, baseLabel(row.base_key)].filter(Boolean).join(' · ')}
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap" title={row.hq_country ?? undefined}>
        {row.country_name ?? (row.hq_country ? <span className="text-app-text-muted">{row.hq_country}</span> : '—')}
      </td>
      <td className="max-w-[200px] truncate" title={row.industry ?? undefined}>{row.industry ?? '—'}</td>
      <td className="ui-table__num">{sizeLabel(row.employees)}</td>
      <td className="max-w-[200px] truncate" title={row.ai_niche ?? undefined}>{row.ai_niche ?? '—'}</td>
      <td className="ui-table__num">{num(row.leads)}</td>
      <td className="ui-table__num">{num(row.invited)}</td>
      <td className="ui-table__num">{percent(row.accept_rate)}</td>
      <td className="ui-table__num">{num(row.replied)}</td>
      <td className="ui-table__num">{num(row.p3)}</td>
      <td className="whitespace-nowrap text-app-text-muted">{shortDate(row.last_activity)}</td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------

function CountriesTab({ reloadKey }: { reloadKey: number }) {
  const { data } = useData()
  const { params, write } = useParamWriter()
  const axis: CountryAxis = params.get('axis') === 'company' ? 'company' : 'lead'
  const inst = params.get('inst') ?? 'all'
  const camp = params.get('camp') ?? 'all'
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const [result, setResult] = useState<CountriesFunnel | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchCountriesFunnel({ axis, inst, camp, from, to })
      .then((next) => { if (!cancelled) setResult(next) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [axis, inst, camp, from, to, reloadKey, retry])

  const instanceLabel = accountLabeller(data?.instances)
  const campaigns = (data?.campaigns ?? []).filter((c) => inst === 'all' || c.instance_id === inst)
  const rows = result && result.axis === axis ? result.rows : []
  const countryHref = (iso2: string | null) => axis === 'company'
    ? `/companies?country=${iso2 ?? 'unknown'}`
    : `/leads?country=${iso2 ?? 'unknown'}`

  return (
    <>
      <Toolbar>
        <SegmentedControl<CountryAxis>
          label="Country of"
          value={axis}
          onChange={(value) => write({ axis: value === 'lead' ? null : value })}
          items={[
            { id: 'lead', label: 'Lead location' },
            { id: 'company', label: 'Company HQ' },
          ]}
        />
        <SelectField label="Account" labelHidden value={inst} onChange={(e) => write({ inst: e.target.value, camp: null })}>
          <option value="all">All accounts</option>
          {(data?.instances ?? []).map((i) => <option key={i.id} value={i.id}>{instanceLabel(i.id)}</option>)}
        </SelectField>
        <SelectField label="Campaign" labelHidden value={camp} onChange={(e) => write({ camp: e.target.value })}>
          <option value="all">All campaigns</option>
          {campaigns.map((c) => <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_name}</option>)}
        </SelectField>
        <TextField label="Invited from (UTC)" labelHidden type="date" value={from} max={to || undefined} onChange={(e) => write({ from: e.target.value })} />
        <TextField label="Invited to (UTC)" labelHidden type="date" value={to} min={from || undefined} onChange={(e) => write({ to: e.target.value })} />
      </Toolbar>

      {error && (
        <InlineError title="The country funnel could not load." detail={error} onRetry={() => setRetry((n) => n + 1)} />
      )}

      <TableFrame
        scrollLabel="Funnel by country"
        className="mb-section"
        busy={loading}
        toolbar={(
          <TableToolbar
            count={<>
              {result ? `${num(result.totals.people ?? 0)} people · ${num(result.totals.invited ?? 0)} invited` : '—'}
              {(from || to) && ` · invited ${from || '…'} to ${to || '…'} UTC`}
              {loading && <> <UpdatingNote /></>}
            </>}
          />
        )}
        hint={axis === 'company' && result && result.unlinked_people > 0 ? (
          <span>
            {num(result.unlinked_people)} people are not linked to a company and are not counted here.{' '}
            <Link className="text-app-accent" to={`/companies?tab=unlinked${inst !== 'all' ? `&inst=${encodeURIComponent(inst)}` : ''}`}>See unlinked leads</Link>
          </span>
        ) : 'Rates are over invited people. Replies lag invites, so a country whose invites are mostly under 21 days old is marked Maturing.'}
      >
        <Table caption="Funnel by country">
          <thead>
            <tr>
              <th scope="col">Country</th>
              <th scope="col" className="ui-table__num">People</th>
              <th scope="col" className="ui-table__num">Invited</th>
              <th scope="col" className="ui-table__num">Accepted</th>
              <th scope="col" className="ui-table__num">Accept %</th>
              <th scope="col" className="ui-table__num">Replied</th>
              <th scope="col" className="ui-table__num">Reply %</th>
              <th scope="col" className="ui-table__num">P3</th>
              <th scope="col" className="ui-table__num">P3 %</th>
              <th scope="col" className="ui-table__num">Companies</th>
              <th scope="col">Cohort</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.iso2 ?? 'unknown'} data-country={row.iso2 ?? 'unknown'}>
                <td>
                  <Link className="text-app-text no-underline hover:text-app-accent hover:underline" to={countryHref(row.iso2)}>
                    {row.iso2 ? row.name : 'Unknown'}
                  </Link>
                  {row.region && <div className="text-app-meta text-app-text-muted">{row.region}</div>}
                </td>
                <td className="ui-table__num">{num(row.people)}</td>
                <td className="ui-table__num">{num(row.invited)}</td>
                <td className="ui-table__num">{num(row.accepted)}</td>
                <td className="ui-table__num">{percent(row.accept_rate)}</td>
                <td className="ui-table__num">{num(row.replied)}</td>
                <td className="ui-table__num">{percent(row.reply_rate)}</td>
                <td className="ui-table__num">{num(row.p3)}</td>
                <td className="ui-table__num">{percent(row.p3_rate)}</td>
                <td className="ui-table__num">{num(row.companies)}</td>
                <td className="whitespace-nowrap">
                  {row.maturing_flag ? (
                    <Badge tone="warning" title={`${percent(row.maturing_share)} of invites are under 21 days old — rates are still rising`}>
                      Maturing
                    </Badge>
                  ) : row.invited > 0 ? (
                    <span className="text-app-text-muted">Mature</span>
                  ) : <span className="text-app-text-muted">—</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && !error && (
              <tr>
                <td colSpan={11}>
                  <EmptyState
                    kind={inst !== 'all' || camp !== 'all' || from || to ? 'no-match' : 'empty'}
                    icon={Globe2}
                    title={axis === 'company' ? 'No linked companies in this scope' : 'No leads in this scope'}
                    hint={axis === 'company'
                      ? 'Sync from Airtable to link leads to their companies.'
                      : 'Widen the account, campaign or invite period.'}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </TableFrame>

      {result && result.axis === axis && result.unresolved.length > 0 && (
        <Panel className="mb-section" aria-labelledby="unresolved-places">
          <SectionHeader
            id="unresolved-places"
            level="subsection"
            title={axis === 'company' ? 'Unresolved HQ countries' : 'Unresolved locations'}
            description="The most common places that did not resolve to a country. They are counted in Unknown until an alias is added."
          />
          <ul className="m-0 pl-0 list-none flex flex-col gap-stack" data-unresolved="">
            {result.unresolved.map((place) => (
              <li key={place.value} className="flex justify-between gap-group text-app-table">
                <span className="[overflow-wrap:anywhere]">{place.value}</span>
                <span className="tabular-nums text-app-text-muted whitespace-nowrap">
                  {num(place.people)} {place.people === 1 ? 'person' : 'people'}
                  {axis === 'company' ? ` · ${num(place.companies)} ${place.companies === 1 ? 'company' : 'companies'}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Unlinked leads
// ---------------------------------------------------------------------------

function UnlinkedTab({ reloadKey }: { reloadKey: number }) {
  const { data } = useData()
  const toast = useToast()
  const { params, write } = useParamWriter()
  const scrollRef = useRef<HTMLDivElement>(null)
  const q = params.get('q') ?? ''
  const inst = params.get('inst') ?? 'all'
  const reach = params.get('reach') ?? 'all'
  const page = Math.max(0, (Number(params.get('page')) || 1) - 1)
  const [qInput, setQInput] = useDebouncedQuery(q, (value) => write({ q: value }))
  const [result, setResult] = useState<UnlinkedPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [linking, setLinking] = useState<UnlinkedLead | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchUnlinkedLeads({ inst, q, reach, page, pageSize: PAGE_SIZE })
      .then((next) => { if (!cancelled) setResult(next) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [inst, q, reach, page, reloadKey, retry])

  const instanceLabel = accountLabeller(data?.instances)
  const total = result?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const goPage = (n: number) => {
    write({ page: n <= 0 ? null : String(n + 1) }, true)
    scrollRef.current?.scrollTo({ top: 0 })
  }
  const filtered = Boolean(q || inst !== 'all' || reach !== 'all')
  const rows = result?.items ?? []

  return (
    <>
      <Toolbar>
        <TextField
          className="ui-toolbar__search"
          label="Search unlinked leads"
          labelHidden
          type="search"
          placeholder="Name, headline, company, location…"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
        />
        <SelectField label="Account" labelHidden value={inst} onChange={(e) => write({ inst: e.target.value })}>
          <option value="all">All accounts</option>
          {(data?.instances ?? []).map((i) => <option key={i.id} value={i.id}>{instanceLabel(i.id)}</option>)}
        </SelectField>
        <SelectField label="Reached" labelHidden value={reach} onChange={(e) => write({ reach: e.target.value })}>
          <option value="all">Anyone</option>
          <option value="invited">Invited</option>
          <option value="replied">Replied</option>
        </SelectField>
      </Toolbar>

      {error && (
        <InlineError title="Unlinked leads could not load." detail={error} onRetry={() => setRetry((n) => n + 1)} />
      )}

      <TableFrame
        scrollLabel="Unlinked leads"
        className="[&_.ui-table-scroll]:max-h-[calc(100vh-360px)] [&_.ui-table-scroll]:min-h-[280px]"
        scrollRef={scrollRef}
        busy={loading}
        toolbar={(
          <TableToolbar
            count={<>
              {num(total)} of {num(result?.allTotal ?? 0)} people without a company
              {loading && <> <UpdatingNote /></>}
            </>}
          />
        )}
        hint={pages > 1 ? (
          <div className="flex justify-center items-center gap-app-lg">
            <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => goPage(page - 1)}>← Previous</Button>
            <span>Page {page + 1} of {pages}</span>
            <Button variant="secondary" size="sm" disabled={page >= pages - 1} onClick={() => goPage(page + 1)}>Next →</Button>
          </div>
        ) : 'The LinkedIn company is the person’s current employer, shown as a hint only.'}
      >
        <Table caption="Unlinked leads">
          <thead>
            <tr>
              <th scope="col">Lead</th>
              <th scope="col">LinkedIn company</th>
              <th scope="col">Location</th>
              <th scope="col">Reached</th>
              <th scope="col">Campaigns</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((lead) => (
              <tr key={`${lead.instance_id}|${lead.profile_url}`} className="ui-table__row--identity" data-unlinked={lead.profile_url}>
                <td>
                  <div className="min-w-0 max-w-[280px]">
                    <a className="text-app-text no-underline hover:text-app-accent hover:underline" href={lead.profile_url} target="_blank" rel="noreferrer">
                      {lead.full_name || 'LinkedIn contact'}
                    </a>
                    <div className="truncate text-app-meta text-app-text-muted" title={lead.headline ?? undefined}>
                      {[lead.headline, instanceLabel(lead.instance_id)].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </td>
                <td className="max-w-[200px] truncate text-app-text-secondary" title={lead.company ?? undefined}>{lead.company ?? '—'}</td>
                <td className="max-w-[220px] truncate" title={lead.location ?? undefined}>{locationLine(lead.location, lead.country_code) ?? '—'}</td>
                <td className="whitespace-nowrap">
                  {lead.replied ? <Badge tone="success">Replied</Badge> : lead.invited ? <Badge>Invited</Badge> : <span className="text-app-text-muted">Queued</span>}
                </td>
                <td className="max-w-[220px] truncate text-app-text-muted" title={lead.campaigns.join(', ')}>{lead.campaigns.join(', ') || '—'}</td>
                <td className="whitespace-nowrap">
                  <Button size="sm" variant="secondary" icon={<Link2 aria-hidden="true" />} onClick={() => setLinking(lead)}>
                    Link to company
                  </Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && !error && (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    kind={filtered ? 'no-match' : 'empty'}
                    icon={UserX}
                    title={filtered ? 'No unlinked leads match these filters' : 'Every lead is linked to a company'}
                    hint={filtered ? 'Adjust or clear the search and filters.' : undefined}
                    action={filtered ? (
                      <Button variant="secondary" size="sm" onClick={() => write({ q: null, inst: null, reach: null })}>{COPY.clearFilters}</Button>
                    ) : undefined}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </TableFrame>

      {linking && (
        <LinkCompanyDialog
          lead={linking}
          onClose={() => setLinking(null)}
          onLinked={(name) => {
            toast.success(`${linking.full_name || 'Lead'} linked to ${name}.`)
            setLinking(null)
            setRetry((n) => n + 1)
          }}
        />
      )}
    </>
  )
}

/**
 * Search every synced Airtable company and link this person to one by hand.
 * A manual link is kept when the sync refreshes the slug-matched links.
 */
export function LinkCompanyDialog({
  lead, onClose, onLinked,
}: {
  lead: Pick<UnlinkedLead, 'instance_id' | 'profile_url' | 'full_name' | 'company'>
  onClose: () => void
  onLinked: (companyName: string) => void
}) {
  const toast = useToast()
  const [q, setQ] = useState(lead.company ?? '')
  const [debounced, setDebounced] = useState(q.trim())
  const [result, setResult] = useState<CompanyRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(id)
  }, [q])

  useEffect(() => {
    if (!debounced) { setResult(null); setError(null); return }
    let cancelled = false
    setError(null)
    fetchCompaniesPage({ scope: 'all', q: debounced, sort: 'name', dir: 'asc', pageSize: 20 })
      .then((page) => { if (!cancelled) setResult(page.items) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [debounced])

  async function link(company: CompanyRow) {
    setSaving(company.record_id)
    try {
      await linkLeadToCompany({
        instance_id: lead.instance_id,
        profile_url: lead.profile_url,
        base_key: company.base_key,
        record_id: company.record_id,
      })
      onLinked(company.name || 'the company')
    } catch (e) {
      toast.error(`Couldn't link the lead: ${e instanceof Error ? e.message : String(e)}`)
      setSaving(null)
    }
  }

  return (
    <Dialog
      title={`Link ${lead.full_name || 'this lead'} to a company`}
      description="Search the companies synced from every Airtable base. A manual link is kept when the sync refreshes links."
      onRequestClose={onClose}
      busy={saving !== null}
      busyMessage="Linking the lead…"
      size="md"
    >
      <div className="flex flex-col gap-group">
        <TextField
          label="Search companies"
          type="search"
          placeholder="Company name or domain"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          help={lead.company ? `LinkedIn shows “${lead.company}” as the current company.` : undefined}
        />
        {error && <InlineError title="Companies could not load." detail={error} />}
        {!debounced && <p className="m-0 text-app-meta text-app-text-muted">Type a company name or domain to search.</p>}
        {debounced && result && result.length === 0 && (
          <EmptyState kind="no-match" icon={SearchX} title="No companies match" hint="Check the spelling, or sync from Airtable if the company was added recently." />
        )}
        {result && result.length > 0 && (
          <ul className="m-0 pl-0 list-none flex flex-col" aria-label="Matching companies">
            {result.map((company) => (
              <li key={`${company.base_key}:${company.record_id}`} className="flex items-center justify-between gap-group py-app-sm border-b border-app-border last:border-b-0">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{company.name || 'Unnamed company'}</div>
                  <div className="text-app-meta text-app-text-muted truncate">
                    {[company.domain, company.country_name ?? company.hq_country, baseLabel(company.base_key)].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={saving === company.record_id}
                  disabled={saving !== null && saving !== company.record_id}
                  onClick={() => void link(company)}
                  aria-label={`Link to ${company.name || 'this company'}`}
                >Link</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
