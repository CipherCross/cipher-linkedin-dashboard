import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  cellInt,
  cellText,
  companyRow,
  contactRow,
  fieldNames,
  modifiedSinceFormula,
  syncAirtable,
  websiteDomain,
} from '../api/_lib/airtableSync'
import { AIRTABLE_IDS, AirtableError, type AirtablePage, type AirtableTableSchema } from '../api/_lib/airtable'
import {
  AIRTABLE_MIRROR_COMMANDS,
  AIRTABLE_MIRROR_OPERATIONS,
  clearManualLinkOperation,
  refreshLinksOperation,
  setManualLinkOperation,
  upsertContactsOperation,
} from '../api/_lib/data/operations/airtableMirror'
import type { ActorContext, DataStore } from '../api/_lib/data/contracts'

const ACTOR = { kind: 'system', actorId: '00000000-0000-0000-0000-000000000000', tenantId: 'primary', role: 'system' } as unknown as ActorContext

const SCHEMA: AirtableTableSchema[] = [
  {
    id: AIRTABLE_IDS.companiesTable,
    name: 'Companies',
    fields: [
      { id: AIRTABLE_IDS.companies.name, name: 'Company Name', type: 'singleLineText' },
      { id: AIRTABLE_IDS.companies.website, name: 'Website', type: 'url' },
      { id: AIRTABLE_IDS.companies.country, name: 'HQ country', type: 'singleLineText' },
      { id: AIRTABLE_IDS.companies.employees, name: '# Employees', type: 'number' },
      { id: AIRTABLE_IDS.companies.foundedYear, name: 'Founded Year', type: 'number' },
      { id: AIRTABLE_IDS.companies.approveStatus, name: 'Approve Status', type: 'singleSelect' },
      { id: 'fldAINICHE0000000', name: 'AI Niche', type: 'multipleSelects' },
    ],
  },
  {
    id: AIRTABLE_IDS.contactsTable,
    name: 'Contacts',
    fields: [
      { id: AIRTABLE_IDS.contacts.personaLinkedin, name: 'Persona LinkedIn', type: 'url' },
      { id: AIRTABLE_IDS.contacts.fullName, name: 'Full Name', type: 'singleLineText' },
      { id: AIRTABLE_IDS.contacts.company, name: 'Company', type: 'multipleRecordLinks' },
      { id: 'fldREADINESS00000', name: 'Readiness', type: 'singleSelect' },
    ],
  },
]

const rec = (n: number) => `rec${String(n).padStart(14, '0')}`

interface StoredState {
  cursor: string | null
  run_started_at: string | null
  pending_offset: string | null
}

function fakeStore() {
  const state = new Map<string, StoredState>()
  const upserts: { operation: string; base: string; rows: unknown[] }[] = []
  let refreshes = 0
  const execute = async (command: { operation: string; params?: Record<string, unknown> }) => {
    const p = command.params ?? {}
    if (command.operation === AIRTABLE_MIRROR_COMMANDS.saveSyncState) {
      state.set(`${p.baseKey}/${p.tableKey}`, {
        cursor: (p.cursor as string | null) ?? null,
        run_started_at: (p.runStartedAt as string | null) ?? null,
        pending_offset: (p.pendingOffset as string | null) ?? null,
      })
      return undefined
    }
    if (command.operation === AIRTABLE_MIRROR_COMMANDS.upsertCompanies
      || command.operation === AIRTABLE_MIRROR_COMMANDS.upsertContacts) {
      const rows = JSON.parse(String(p.rows)) as unknown[]
      upserts.push({ operation: command.operation, base: String(p.baseKey), rows })
      return rows.length
    }
    if (command.operation === AIRTABLE_MIRROR_COMMANDS.refreshLinks) {
      refreshes += 1
      return { leads: 10, matched: 8, changed: 2, linked: 8 }
    }
    throw new Error(`unexpected ${command.operation}`)
  }
  const store = {
    query: async (_actor: ActorContext, request: { operation: string; params?: Record<string, unknown> }) => {
      expect(request.operation).toBe(AIRTABLE_MIRROR_OPERATIONS.syncState)
      const row = state.get(`${request.params?.baseKey}/${request.params?.tableKey}`)
      return { items: row ? [{ ...row, last_run_at: null, last_error: null, rows_upserted: 0 }] : [], nextCursor: null, hasMore: false }
    },
    transaction: async (actor: ActorContext, work: (tx: unknown) => Promise<unknown>) =>
      work({ actor, execute, query: async () => ({ items: [], nextCursor: null, hasMore: false }) }),
  } as unknown as DataStore
  return { store, state, upserts, refreshes: () => refreshes }
}

describe('cell helpers', () => {
  it('turn Airtable cells into text and numbers', () => {
    expect(cellText(['SaaS', { name: 'Fintech' }, null])).toBe('SaaS, Fintech')
    expect(cellText({ state: 'generated', value: 'AI text' })).toBe('AI text')
    expect(cellText('  ')).toBeNull()
    expect(cellInt('1,200')).toBe(1200)
    expect(cellInt('51-200')).toBe(51)
    expect(cellInt(42.6)).toBe(43)
    expect(cellInt('n/a')).toBeNull()
    expect(websiteDomain('https://www.Acme.com/about?x=1')).toBe('acme.com')
    expect(websiteDomain('not a site')).toBeNull()
  })

  it('reads typed columns by pinned field ID and by name, and keeps every field', () => {
    const names = fieldNames(SCHEMA[0])
    const row = companyRow({
      id: rec(1),
      createdTime: '2026-01-02T03:04:05.000Z',
      fields: {
        'Company Name': 'Acme',
        Website: 'https://acme.io',
        'HQ country': 'Germany',
        '# Employees': 120,
        'Founded Year': 1492,
        'Approve Status': 'Approved',
        'AI Niche': ['Agents', 'RAG'],
        Unpinned: 'kept',
      },
    }, names)
    expect(row).toMatchObject({
      record_id: rec(1), name: 'Acme', domain: 'acme.io', hq_country: 'Germany', employees: 120,
      founded_year: null, approve_status: 'Approved', ai_niche: 'Agents, RAG',
      airtable_modified: '2026-01-02T03:04:05.000Z',
    })
    expect(row.fields.Unpinned).toBe('kept')
  })

  it('takes a contact\'s first linked company record', () => {
    const row = contactRow({
      id: rec(2),
      fields: { 'Persona LinkedIn': 'https://linkedin.com/in/x', Company: [rec(9), rec(8)], Readiness: 'Hot' },
    }, fieldNames(SCHEMA[1]))
    expect(row).toMatchObject({ company_record_id: rec(9), persona_url: 'https://linkedin.com/in/x', readiness: 'Hot' })
  })

  it('builds the incremental formula with an overlap, and none without a cursor', () => {
    expect(modifiedSinceFormula(null)).toBeUndefined()
    expect(modifiedSinceFormula('2026-11-12T10:00:00.000Z'))
      .toBe('IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE("2026-11-12T09:55:00.000Z"))')
  })
})

describe('syncAirtable', () => {
  const only = (base: string) => (candidate: string) => candidate === base

  it('reads companies then contacts to the end, advances the cursor and refreshes links', async () => {
    const fake = fakeStore()
    const calls: string[] = []
    const fetchPage = async (_base: string, table: string, options: { formula?: string; offset?: string | null } = {}): Promise<AirtablePage> => {
      calls.push(`${table}:${options.offset ?? '-'}:${options.formula ? 'inc' : 'full'}`)
      if (table === AIRTABLE_IDS.companiesTable && !options.offset) return { records: [{ id: rec(1), fields: {} }], offset: 'p2' }
      if (table === AIRTABLE_IDS.companiesTable) return { records: [{ id: rec(2), fields: {} }], offset: null }
      return { records: [{ id: rec(3), fields: {} }], offset: null }
    }
    const result = await syncAirtable(
      { store: fake.store, actor: ACTOR, fetchPage: fetchPage as never, fetchSchema: async () => SCHEMA, configured: only('web2mob'), now: () => Date.parse('2026-11-12T10:00:00Z') },
      { budgetMs: 10_000 },
    )
    expect(calls).toEqual([`${AIRTABLE_IDS.companiesTable}:-:full`, `${AIRTABLE_IDS.companiesTable}:p2:full`, `${AIRTABLE_IDS.contactsTable}:-:full`])
    expect(result.done).toBe(true)
    expect(result.bases.find((b) => b.base === 'web2mob')).toMatchObject({ companies: { upserted: 2, done: true }, contacts: { upserted: 1, done: true } })
    expect(result.bases.find((b) => b.base === 'fintech_arabic')).toEqual({ base: 'fintech_arabic', configured: false })
    expect(fake.state.get('web2mob/companies')).toEqual({ cursor: '2026-11-12T10:00:00.000Z', run_started_at: null, pending_offset: null })
    expect(result.links).toMatchObject({ matched: 8 })
    expect(fake.refreshes()).toBe(1)
  })

  it('stops at the budget with the offset saved and resumes from it under the same cursor', async () => {
    const fake = fakeStore()
    fake.state.set('web2mob/companies', { cursor: '2026-11-01T00:00:00.000Z', run_started_at: null, pending_offset: null })
    let clock = 0
    const offsets: (string | null | undefined)[] = []
    const fetchPage = async (_base: string, table: string, options: { formula?: string; offset?: string | null } = {}): Promise<AirtablePage> => {
      if (table !== AIRTABLE_IDS.companiesTable) return { records: [], offset: null }
      offsets.push(options.offset)
      expect(options.formula).toContain('2026-10-31T23:55:00.000Z')
      clock += 6_000
      return { records: [{ id: rec(offsets.length), fields: {} }], offset: `p${offsets.length + 1}` }
    }
    const deps = { store: fake.store, actor: ACTOR, fetchPage: fetchPage as never, fetchSchema: async () => SCHEMA, configured: only('web2mob'), now: () => clock }
    const first = await syncAirtable(deps, { budgetMs: 10_000 })
    expect(first.done).toBe(false)
    expect(fake.state.get('web2mob/companies')).toMatchObject({ cursor: '2026-11-01T00:00:00.000Z', pending_offset: 'p3' })

    const resumed = await syncAirtable(deps, { budgetMs: 5_000, full: true })
    expect(offsets).toEqual([null, 'p2', 'p3'])
    expect(resumed.done).toBe(false)
  })

  it('restarts a table from its cursor when Airtable expired the offset', async () => {
    const fake = fakeStore()
    fake.state.set('web2mob/companies', { cursor: null, run_started_at: '2026-11-12T09:00:00.000Z', pending_offset: 'old' })
    const offsets: (string | null | undefined)[] = []
    const fetchPage = async (_base: string, table: string, options: { offset?: string | null } = {}): Promise<AirtablePage> => {
      if (table !== AIRTABLE_IDS.companiesTable) return { records: [], offset: null }
      offsets.push(options.offset)
      if (options.offset === 'old') throw new AirtableError('LIST_RECORDS_ITERATOR_NOT_AVAILABLE', 422)
      return { records: [], offset: null }
    }
    const result = await syncAirtable(
      { store: fake.store, actor: ACTOR, fetchPage: fetchPage as never, fetchSchema: async () => SCHEMA, configured: only('web2mob'), now: () => 0 },
      { budgetMs: 10_000 },
    )
    expect(offsets).toEqual(['old', null])
    expect(result.done).toBe(true)
    expect(fake.state.get('web2mob/companies')?.cursor).toBe('2026-11-12T09:00:00.000Z')
  })

  it('reports an Airtable failure per base, skips its contacts and keeps the cursor', async () => {
    const fake = fakeStore()
    const fetchPage = async (): Promise<AirtablePage> => { throw new AirtableError('NOT_AUTHORIZED', 403) }
    const result = await syncAirtable(
      { store: fake.store, actor: ACTOR, fetchPage: fetchPage as never, fetchSchema: async () => SCHEMA, configured: only('web2mob'), now: () => 0 },
      { budgetMs: 10_000 },
    )
    const base = result.bases.find((b) => b.base === 'web2mob')
    expect(base?.companies?.error).toContain('NOT_AUTHORIZED')
    expect(base?.contacts).toEqual({ upserted: 0, done: false })
    expect(result.done).toBe(false)
    expect(fake.state.get('web2mob/companies')?.cursor).toBeNull()
  })
})

describe('mirror SQL', () => {
  const ctx = { actor: { actorId: '11111111-1111-1111-1111-111111111111' } as ActorContext }

  it('derives the contact slug in SQL with the shared normalization', () => {
    expect(upsertContactsOperation.build({ ...ctx, params: { baseKey: 'web2mob', rows: '[]' } }).text)
      .toContain('public.linkedin_slug(r.persona_url)')
  })

  it('refreshes links through the step 031 definer function and reads its counts', () => {
    expect(refreshLinksOperation.build({ ...ctx, params: undefined }).text)
      .toBe('SELECT public.refresh_lead_company_links() AS result')
    expect(refreshLinksOperation.mapResult?.([{ result: { leads: 9204, matched: 6260, changed: 6260, linked: 6260 } }], 1))
      .toEqual({ leads: 9204, matched: 6260, changed: 6260, linked: 6260 })
  })

  it('keeps the link rule in step 031: manual links survive, newest contact wins, nothing is deleted', () => {
    const sql = readFileSync(new URL('../../postgres/tenant-baseline/v1/031_lead_company_link_refresh.sql', import.meta.url), 'utf8')
    expect(sql).toContain("where link.method = 'contact_slug'")
    expect(sql).toContain('c.airtable_modified desc nulls last')
    expect(sql).not.toMatch(/\bdelete\b/i)
  })

  it('records the acting member on a manual link and clears only manual links', () => {
    const set = setManualLinkOperation.build({ ...ctx, params: { instanceId: 'nb', profileUrl: 'u', baseKey: 'web2mob', recordId: rec(1) } })
    expect(set.values).toEqual(['nb', 'u', 'web2mob', rec(1), '11111111-1111-1111-1111-111111111111'])
    expect(set.text).toContain('tm.user_id = $5::uuid')
    expect(clearManualLinkOperation.build({ ...ctx, params: { instanceId: 'nb', profileUrl: 'u' } }).text)
      .toContain("method = 'manual'")
  })
})
