import { useEffect, useState } from 'react'
import { Building2 } from 'lucide-react'
import type { AirtableCompany } from '../lib/importApi'
import { searchAirtableCompanies } from '../lib/importApi'
import { Badge, Button, Dialog, InlineError, TextField, UpdatingNote } from '../ui'

const isRejected = (company: AirtableCompany) => company.approveStatus.trim().toLowerCase() === 'rejected'

/**
 * Picks the Companies record a group of leads is linked to. It lists the
 * group's candidates and searches Companies by name, domain or LinkedIn. A
 * Rejected record is shown but cannot be chosen.
 */
export function CompanyResolutionModal({
  sourceCompany,
  affectedRows,
  suggestions,
  onSelect,
  onClose,
}: {
  sourceCompany: string
  affectedRows: number
  suggestions: AirtableCompany[]
  onSelect: (company: AirtableCompany) => void
  onClose: () => void
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
        if (!cancelled) {
          const found = new Set(companies.map((company) => company.id))
          setResults([...suggestions.filter((company) => !found.has(company.id)), ...companies])
        }
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason))
          setResults(suggestions)
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

  return (
    <Dialog
      title="Choose the Airtable company"
      description={<>
        CSV company: <strong>{sourceCompany || 'Unnamed company'}</strong>
        {' · '}
        {affectedRows} {affectedRows === 1 ? 'lead' : 'leads'}
      </>}
      closeLabel="Close company picker"
      onRequestClose={onClose}
      footer={<Button variant="secondary" onClick={onClose}>Cancel</Button>}
    >
      <div className="flex flex-col gap-app-md">
        <TextField
          label="Search Airtable companies"
          labelHidden
          type="search"
          value={query}
          placeholder="Search Companies by name, website, or LinkedIn"
          onChange={(event) => setQuery(event.target.value)}
        />

        {error && <InlineError title="Could not search Airtable." message={error} />}

        <div className="min-h-[180px] flex flex-col gap-app-sm" aria-busy={busy || undefined}>
          {busy && (
            <div className="min-h-[180px] flex items-center justify-center">
              <UpdatingNote>Searching Airtable…</UpdatingNote>
            </div>
          )}
          {!busy && results.length === 0 && (
            <div className="min-h-[180px] flex flex-col items-center justify-center gap-app-xs text-center">
              <Building2 size={24} aria-hidden="true" className="text-app-text-muted" />
              <div>No matching Companies found.</div>
              <div className="text-app-meta text-app-text-muted">
                Try the company’s domain or LinkedIn URL. A company that is still in DB cannot be linked until it is approved.
              </div>
            </div>
          )}
          {!busy &&
            results.map((company) => {
              const rejected = isRejected(company)
              return (
                <Button
                  key={company.id}
                  variant="secondary"
                  block
                  disabled={rejected}
                  className="h-auto min-h-control py-app-sm grid grid-cols-[24px_minmax(0,1fr)_auto] gap-inline items-center text-left font-normal"
                  onClick={() => onSelect(company)}
                >
                  <Building2 size={18} aria-hidden="true" className="text-app-accent" />
                  <span className="min-w-0 flex flex-col gap-0.5">
                    <strong>{company.name || 'Unnamed company'}</strong>
                    <span className="text-app-meta text-app-text-muted truncate">
                      {[company.website, company.linkedin].filter(Boolean).join(' · ') || 'No website or LinkedIn stored'}
                    </span>
                  </span>
                  {rejected
                    ? <Badge tone="danger">Rejected</Badge>
                    : <span className="text-app-accent text-app-meta font-semibold">Select</span>}
                </Button>
              )
            })}
        </div>
      </div>
    </Dialog>
  )
}
