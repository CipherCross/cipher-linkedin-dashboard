/**
 * The Companies page's reads (ledger step 030): what the endpoint accepts and
 * refuses for each, and the SQL each operation builds, inspected as text.
 *
 * The funnel rules these pin are AGENTS.md's: a person is
 * `(instance_id, profile_url)` deduplicated across campaigns, P3 is the durable
 * inbound `intent_level = 'p3'` label, and every country rate is over invited
 * people with young invite cohorts flagged as maturing.
 *
 * No database and no network.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  readCompaniesSearch,
  readCompaniesUnlinked,
  readCompanyDetail,
  readCountriesFunnel,
  readOptionalCountry,
} from '../api/activity-daily.js'
import {
  COMPANIES_OPERATIONS,
  COUNTRIES_OPERATIONS,
  MATURING_DAYS,
  companiesSearchPageOperation,
  companiesUnlinkedOperation,
  companyDetailOperation,
  countriesFunnelOperation,
  leadCompanyLinkOperation,
} from '../api/_lib/data/operations/companies.js'
import { buildApplicationRegistry, APPLICATION_QUERY_OPERATIONS } from '../api/_lib/data/operations/index.js'
import { runAirtableSync, type AirtableSyncRound } from '../src/lib/companies'

const url = (query: string) => new URL(`https://dashboard.test/api/activity-daily?${query}`)

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the builders only read `params`
const build = (operation: { build: (context: any) => { text: string; values?: readonly unknown[] } }, params: Record<string, unknown> = {}) =>
  operation.build({ params })

describe('the Companies page parameter readers', () => {
  it('reads a companies page with every filter and safe defaults', () => {
    expect(readCompaniesSearch(url(''))).toEqual({
      scope: 'linked', instanceId: null, query: null, country: null, industry: null, size: null,
      approveStatus: null, base: null, hasReply: null, sort: 'leads', direction: 'desc',
      pageSize: '50', page: '0',
    })
    expect(readCompaniesSearch(url(
      'scope=all&instance_id=notebook-1&q=acme&country=pt&industry=Fintech&size=51-200'
      + '&approve=Approve&base=web2mob&reply=yes&sort=accept_rate&dir=asc&page_size=20&page=3',
    ))).toEqual({
      scope: 'all', instanceId: 'notebook-1', query: 'acme', country: 'PT', industry: 'Fintech',
      size: '51-200', approveStatus: 'Approve', base: 'web2mob', hasReply: 'yes',
      sort: 'accept_rate', direction: 'asc', pageSize: '20', page: '3',
    })
  })

  it('refuses values outside the vocabulary rather than matching nothing', () => {
    expect(() => readCompaniesSearch(url('scope=everything'))).toThrow(/scope/)
    expect(() => readCompaniesSearch(url('size=10-20'))).toThrow(/size/)
    expect(() => readCompaniesSearch(url('sort=domain'))).toThrow(/sort/)
    expect(() => readCompaniesSearch(url('base=Web%202%20Mob'))).toThrow(/base/)
    expect(() => readCompaniesSearch(url('page_size=500'))).toThrow(/page_size/)
    expect(() => readCompaniesSearch(url('reply=maybe'))).toThrow(/reply/)
  })

  it('reads a country as ISO alpha-2 or unknown', () => {
    expect(readOptionalCountry(url('country=us'))).toBe('US')
    expect(readOptionalCountry(url('country=Unknown'))).toBe('unknown')
    expect(readOptionalCountry(url('country=all'))).toBeNull()
    expect(() => readOptionalCountry(url('country=Portugal'))).toThrow(/alpha-2/)
    expect(() => readOptionalCountry(url('country=U1'))).toThrow(/alpha-2/)
  })

  it('requires a base and an Airtable record id for one company', () => {
    expect(readCompanyDetail(url('base=web2mob&record_id=recAAAAAAAAAAAAAA')))
      .toEqual({ base: 'web2mob', recordId: 'recAAAAAAAAAAAAAA' })
    expect(() => readCompanyDetail(url('record_id=recAAAAAAAAAAAAAA'))).toThrow(/base is required/)
    expect(() => readCompanyDetail(url('base=web2mob'))).toThrow(/record_id is required/)
    expect(() => readCompanyDetail(url('base=web2mob&record_id=rec123'))).toThrow(/record id/)
  })

  it('reads the unlinked list', () => {
    expect(readCompaniesUnlinked(url('instance_id=notebook-1&q=ada&reach=replied&page=2')))
      .toEqual({ instanceId: 'notebook-1', query: 'ada', reach: 'replied', pageSize: '50', page: '2' })
    expect(() => readCompaniesUnlinked(url('reach=accepted'))).toThrow(/reach/)
  })

  it('turns the inclusive invite days into a half-open UTC window', () => {
    expect(readCountriesFunnel(url('axis=company&instance_id=notebook-1&camp=notebook-1%3A4&invited_from=2026-10-01&invited_to=2026-10-31')))
      .toEqual({
        axis: 'company', instanceId: 'notebook-1', campaignId: 'notebook-1:4',
        invitedFrom: '2026-10-01T00:00:00.000Z', invitedTo: '2026-11-01T00:00:00.000Z',
      })
    expect(readCountriesFunnel(url(''))).toEqual({
      axis: 'lead', instanceId: null, campaignId: null, invitedFrom: null, invitedTo: null,
    })
    expect(() => readCountriesFunnel(url('axis=region'))).toThrow(/axis/)
    expect(() => readCountriesFunnel(url('invited_from=2026-10-05&invited_to=2026-10-01'))).toThrow(/after/)
    expect(() => readCountriesFunnel(url('invited_from=2026-02-30'))).toThrow(/calendar day/)
  })
})

describe('the Companies operations', () => {
  it('are registered and listed as application queries', () => {
    const names = [...Object.values(COMPANIES_OPERATIONS), ...Object.values(COUNTRIES_OPERATIONS)]
    expect(buildApplicationRegistry()).toBeTruthy()
    for (const name of names) expect(APPLICATION_QUERY_OPERATIONS).toContain(name)
  })

  it('counts people, not campaign rows, and P3 from the durable inbound label', () => {
    for (const operation of [companiesSearchPageOperation, companyDetailOperation, countriesFunnelOperation]) {
      const sql = build(operation).text.toLowerCase()
      expect(sql).toContain('group by l.instance_id, l.profile_url')
      expect(sql).toContain("m.direction = 'in' and m.intent_level = 'p3'")
      expect(sql).not.toContain('assigned_to')
      expect(sql).not.toContain('linked_by')
    }
  })

  it('binds the companies page parameters in order', () => {
    const statement = build(companiesSearchPageOperation, {
      scope: 'all', instanceId: 'n1', query: 'acme', country: 'PT', industry: 'Fintech', size: '11-50',
      approveStatus: 'Approve', base: 'web2mob', hasReply: 'no', sort: 'name', direction: 'asc',
      pageSize: '20', page: '1',
    })
    expect(statement.values).toEqual([
      'all', 'n1', 'acme', 'PT', 'Fintech', '11-50', 'Approve', 'web2mob', 'no', 'name', 'asc', '20', '1',
    ])
    expect(build(companiesSearchPageOperation).values).toEqual([
      'linked', null, null, null, null, null, null, null, null, 'leads', 'desc', '50', '0',
    ])
    const sql = statement.text.toLowerCase()
    // Linked scope keeps companies with at least one linked person; facets come
    // from the scoped set so filtering never empties its own option lists.
    expect(sql).toContain("$1::text = 'all' or coalesce(s.leads, 0) > 0")
    expect(sql).toContain("($4::text = 'unknown' and s.country_code is null)")
    expect(sql).toContain("($6::text = '5000+' and s.employees > 5000)")
    expect(sql).toContain('from scoped s')
    expect(sql).toContain('page_order > ($13::int * $12::int)')
    expect(sql).toContain("'approvestatuses'")
    // Accept % is accepted among invited over invited.
    expect(sql).toContain('s.accepted_of_invited::numeric / s.invited')
  })

  it('reads one company with every Airtable field', () => {
    const statement = build(companyDetailOperation, { base: 'web2mob', recordId: 'recAAAAAAAAAAAAAA' })
    expect(statement.values).toEqual(['web2mob', 'recAAAAAAAAAAAAAA'])
    expect(statement.text).toContain('to_jsonb(c)')
    expect(statement.text).toContain(`interval '${MATURING_DAYS} days'`)
  })

  it('lists only people with no link, scoped by instance', () => {
    const statement = build(companiesUnlinkedOperation, { instanceId: 'n1', query: 'ada', reach: 'invited', pageSize: '10', page: '0' })
    expect(statement.values).toEqual(['n1', 'ada', 'invited', '10', '0'])
    const sql = statement.text.toLowerCase()
    expect(sql).toContain('not exists')
    expect(sql).toContain('k.instance_id = l.instance_id and k.profile_url = l.profile_url')
  })

  it('reads one conversation by instance and profile, and maps the link', () => {
    const statement = build(leadCompanyLinkOperation, { instanceId: 'n1', profileUrl: 'https://www.linkedin.com/in/ada' })
    expect(statement.values).toEqual(['n1', 'https://www.linkedin.com/in/ada'])
    expect(statement.text).toContain('l.instance_id = $1::text AND l.profile_url = $2::text')
    expect(leadCompanyLinkOperation.mapRow!({
      location: 'Lisbon', country_code: 'PT', country_name: 'Portugal',
      base_key: 'web2mob', company_record_id: 'recAAAAAAAAAAAAAA', company_name: 'Acme', method: 'manual',
    })).toEqual({
      location: 'Lisbon', country_code: 'PT', country_name: 'Portugal',
      company_link: { base_key: 'web2mob', record_id: 'recAAAAAAAAAAAAAA', name: 'Acme', method: 'manual' },
    })
    expect(leadCompanyLinkOperation.mapRow!({
      location: null, country_code: null, country_name: null, base_key: null, company_record_id: null, company_name: null, method: null,
    }).company_link).toBeNull()
  })

  it('places people by axis, keeps an Unknown row, and rates over invited people', () => {
    const statement = build(countriesFunnelOperation, {
      axis: 'company', instanceId: null, campaignId: 'n1:4',
      invitedFrom: '2026-10-01T00:00:00.000Z', invitedTo: '2026-11-01T00:00:00.000Z',
    })
    expect(statement.values).toEqual(['company', null, 'n1:4', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'])
    const sql = statement.text.toLowerCase()
    expect(sql).toContain("case when $1::text = 'company' then ac.country_code::text else c.country_code end")
    expect(sql).toContain("where $1::text = 'lead' or k.instance_id is not null")
    expect(sql).toContain("'unknown'")
    expect(sql).toContain('g.invited_at is not null and g.replied_at is not null')
    expect(sql).toContain('g.replied::numeric / g.invited')
    expect(sql).toContain(`interval '${MATURING_DAYS} days'`)
    expect(sql).toContain('limit 20')
    expect(sql).toContain("'unlinked_people'")
  })
})

describe('the Airtable sync loop', () => {
  const round = (done: boolean, upserted: number, error?: string): AirtableSyncRound => ({
    done,
    bases: [{ base: 'web2mob', companies: { upserted, done }, contacts: { upserted: upserted * 2, done }, ...(error ? { error } : {}) }],
    links: { leads: 100, matched: 87, changed: upserted },
  })

  it('repeats while the server says it is not done, and sums the rounds', async () => {
    const sync = vi.fn()
      .mockResolvedValueOnce(round(false, 10))
      .mockResolvedValueOnce(round(false, 5))
      .mockResolvedValueOnce(round(true, 1))
    const seen: number[] = []
    const summary = await runAirtableSync((n) => seen.push(n), sync)
    expect(sync).toHaveBeenCalledTimes(3)
    expect(seen).toEqual([1, 2, 3])
    expect(summary).toEqual({
      rounds: 3, done: true, companies: 16, contacts: 32,
      links: { leads: 100, matched: 87, changed: 1 }, errors: [],
    })
  })

  it('stops at the first round that reports an error instead of retrying it', async () => {
    const sync = vi.fn()
      .mockResolvedValueOnce(round(false, 10))
      .mockResolvedValueOnce(round(false, 5, 'rate limited'))
      .mockResolvedValueOnce(round(true, 1))
    const summary = await runAirtableSync(undefined, sync)
    expect(sync).toHaveBeenCalledTimes(2)
    expect(summary).toMatchObject({ rounds: 2, done: false, errors: ['web2mob: rate limited'] })
  })

  it('stops after ten rounds and says it is not finished', async () => {
    const sync = vi.fn(async () => round(false, 1))
    const summary = await runAirtableSync(undefined, sync)
    expect(sync).toHaveBeenCalledTimes(10)
    expect(summary.done).toBe(false)
  })

  it('fails the run when a round fails', async () => {
    const sync = vi.fn().mockResolvedValueOnce(round(false, 1)).mockRejectedValueOnce(new Error('HTTP 500'))
    await expect(runAirtableSync(undefined, sync)).rejects.toThrow('HTTP 500')
  })
})
