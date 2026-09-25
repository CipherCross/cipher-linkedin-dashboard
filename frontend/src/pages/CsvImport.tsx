import { useState } from 'react'
import { PageHeader, Tabs } from '../ui'
import { CompaniesImport } from './CsvImportCompanies'
import { LeadsImport } from './CsvImportLeads'

// Two uploads that do not depend on each other, in either order:
//   Companies → DB        new companies go to DB for approval in Airtable;
//   Leads → Contacts      leads are linked to Companies records you confirm.
// Both tabs stay mounted, so switching never discards a loaded file.

type ImportTab = 'companies' | 'leads'

const TABS: Array<{ id: ImportTab; label: string }> = [
  { id: 'companies', label: 'Companies → DB' },
  { id: 'leads', label: 'Leads → Contacts' },
]

export function CsvImport() {
  const [tab, setTab] = useState<ImportTab>('companies')
  return (
    <>
      <PageHeader
        title="CSV import"
        description="Upload companies to the Airtable DB table for approval, or leads to Contacts linked to approved Companies."
      />
      <Tabs label="Import type" items={TABS} value={tab} onChange={setTab} className="mb-section" />
      <div role="tabpanel" aria-label="Companies → DB" hidden={tab !== 'companies'}>
        <CompaniesImport />
      </div>
      <div role="tabpanel" aria-label="Leads → Contacts" hidden={tab !== 'leads'}>
        <LeadsImport />
      </div>
    </>
  )
}
