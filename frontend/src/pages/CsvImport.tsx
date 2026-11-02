import { useState } from 'react'
import { AIRTABLE_BASES, DEFAULT_AIRTABLE_BASE, isAirtableBase } from '../lib/airtableBases'
import type { AirtableBaseId } from '../lib/airtableBases'
import { PageHeader, SegmentedControl, Tabs } from '../ui'
import { CompaniesImport } from './CsvImportCompanies'
import { LeadsImport } from './CsvImportLeads'
import { TeamStats } from './CsvImportStats'

// Two uploads that do not depend on each other, in either order:
//   Companies → DB        new companies go to DB for approval in Airtable;
//   Leads → Contacts      leads are linked to Companies records you confirm.
// Both run against the Airtable base picked in the header (Web 2 Mob or
// Fintech (Arabic)); each base has its own DB, Companies and Contacts.
// A base's tabs mount the first time it is picked and then stay mounted, as
// both tabs do, so switching base or tab never discards a loaded file.
//
// Team stats is read-only: who added how many records to the picked base (or
// all bases), and how many are approved. It is one instance that follows the
// header's base, mounted the first time its tab opens so an import alone never
// reads it, then kept mounted like the others.

type ImportTab = 'companies' | 'leads' | 'stats'

const TABS: Array<{ id: ImportTab; label: string }> = [
  { id: 'companies', label: 'Companies → DB' },
  { id: 'leads', label: 'Leads → Contacts' },
  { id: 'stats', label: 'Team stats' },
]

const BASE_ITEMS = AIRTABLE_BASES.map((base) => ({ id: base.id as AirtableBaseId, label: base.label }))
const BASE_KEY = 'csv-import-base'

function rememberedBase(): AirtableBaseId {
  try {
    const stored = window.localStorage.getItem(BASE_KEY)
    return isAirtableBase(stored) ? stored : DEFAULT_AIRTABLE_BASE
  } catch {
    return DEFAULT_AIRTABLE_BASE
  }
}

export function CsvImport() {
  const [base, setBase] = useState<AirtableBaseId>(rememberedBase)
  const [opened, setOpened] = useState<AirtableBaseId[]>(() => [base])
  const [tab, setTab] = useState<ImportTab>('companies')
  const [statsOpened, setStatsOpened] = useState(false)

  const chooseTab = (next: ImportTab) => {
    setTab(next)
    if (next === 'stats') setStatsOpened(true)
  }

  const chooseBase = (next: AirtableBaseId) => {
    setBase(next)
    setOpened((current) => (current.includes(next) ? current : [...current, next]))
    try { window.localStorage.setItem(BASE_KEY, next) } catch { /* per-viewer only */ }
  }

  return (
    <>
      <PageHeader
        title="CSV import"
        description="Upload companies to the Airtable DB table for approval, or leads to Contacts linked to approved Companies, and see who added what."
        context={<SegmentedControl label="Airtable base" items={BASE_ITEMS} value={base} onChange={chooseBase} />}
      />
      <Tabs label="Import type" items={TABS} value={tab} onChange={chooseTab} className="mb-section" />
      {opened.map((id) => (
        <div key={id} hidden={id !== base}>
          <div role="tabpanel" aria-label="Companies → DB" hidden={tab !== 'companies'}>
            <CompaniesImport base={id} />
          </div>
          <div role="tabpanel" aria-label="Leads → Contacts" hidden={tab !== 'leads'}>
            <LeadsImport base={id} />
          </div>
        </div>
      ))}
      {statsOpened && (
        <div role="tabpanel" aria-label="Team stats" hidden={tab !== 'stats'}>
          <TeamStats base={base} />
        </div>
      )}
    </>
  )
}
