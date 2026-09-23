import { useEffect, useState } from 'react'
import { Building2 } from 'lucide-react'
import type { AirtableCompany } from '../lib/importApi'
import { searchAirtableCompanies } from '../lib/importApi'
import { Button, Dialog, InlineError, TextField, UpdatingNote } from '../ui'

export function CompanyResolutionModal({
  sourceCompany,
  affectedRows,
  suggestions,
  onSelect,
  onSkip,
  onClose,
  subjectLabel = 'lead',
}: {
  sourceCompany: string
  affectedRows: number
  suggestions: AirtableCompany[]
  onSelect: (company: AirtableCompany) => void
  onSkip: () => void
  onClose: () => void
  subjectLabel?: 'lead' | 'company'
}) {
  const [query, setQuery] = useState(sourceCompany)
  const [results, setResults] = useState<AirtableCompany[]>(suggestions)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setResults(suggestions)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setBusy(true)
      setError(null)
      try {
        const companies = await searchAirtableCompanies(trimmed)
        if (!cancelled) setResults(companies)
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason))
          setResults([])
        }
      } finally {
        if (!cancelled) setBusy(false)
      }
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, suggestions])

  const plural = subjectLabel === 'company' ? 'companies' : 'leads'
  return (
    <Dialog
      title="Choose the Airtable company"
      description={<>
        Apollo company: <strong>{sourceCompany || 'Unnamed company'}</strong>
        {' · '}
        {affectedRows}{' '}
        {affectedRows === 1 ? subjectLabel : plural}
      </>}
      closeLabel="Close company picker"
      onRequestClose={onClose}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={onSkip}>
          Skip {affectedRows === 1 ? `this ${subjectLabel}` : `all ${affectedRows} ${plural}`}
        </Button>
      </>}
    >
      <div className="flex flex-col gap-app-md">
        <TextField
          label="Search Airtable companies"
          labelHidden
          type="search"
          value={query}
          placeholder="Search by company name, website, or LinkedIn"
          onChange={(event) => setQuery(event.target.value)}
        />

        {error && <InlineError title="Could not search Airtable." message={error} />}

        <div className="min-h-[180px] flex flex-col gap-1.5" aria-busy={busy || undefined}>
          {busy && (
            <div className="min-h-[180px] flex items-center justify-center">
              <UpdatingNote>Searching Airtable…</UpdatingNote>
            </div>
          )}
          {!busy && results.length === 0 && (
            <div className="min-h-[180px] flex flex-col items-center justify-center gap-1 text-center">
              <Building2 size={24} aria-hidden="true" className="text-app-text-muted" />
              <div>No matching Companies found.</div>
              <div className="text-app-meta text-app-text-muted">
                Try the company’s domain or LinkedIn URL, or skip {affectedRows === 1 ? `this ${subjectLabel}` : `these ${plural}`}.
              </div>
            </div>
          )}
          {!busy &&
            results.map((company) => (
              <Button
                key={company.id}
                variant="secondary"
                block
                className="h-auto min-h-control py-2.5 grid grid-cols-[24px_minmax(0,1fr)_auto] gap-2.5 items-center text-left font-normal"
                onClick={() => onSelect(company)}
              >
                <Building2 size={18} aria-hidden="true" className="text-app-accent" />
                <span className="min-w-0 flex flex-col gap-0.5">
                  <strong>{company.name || 'Unnamed company'}</strong>
                  <span className="text-app-meta text-app-text-muted truncate">
                    {[company.website, company.linkedin].filter(Boolean).join(' · ') || 'No website or LinkedIn stored'}
                  </span>
                </span>
                <span className="text-app-accent text-app-meta font-semibold">Select</span>
              </Button>
            ))}
        </div>
      </div>
    </Dialog>
  )
}
