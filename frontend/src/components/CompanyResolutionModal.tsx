import { useEffect, useState } from 'react'
import { Building2, Search, X } from 'lucide-react'
import type { AirtableCompany } from '../lib/importApi'
import { searchAirtableCompanies } from '../lib/importApi'

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
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

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

  return (
    <div className="pipe-modal-overlay csv-company-overlay" onClick={onClose}>
      <div
        className="pipe-modal csv-company-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="csv-company-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="pipe-modal-head">
          <div>
            <div id="csv-company-title">Choose the Airtable company</div>
            <div className="muted small">
              Apollo company: <strong>{sourceCompany || 'Unnamed company'}</strong>
              {' · '}
              {affectedRows}{' '}
              {affectedRows === 1 ? subjectLabel : subjectLabel === 'company' ? 'companies' : 'leads'}
            </div>
          </div>
          <button className="conv-close" onClick={onClose} aria-label="Close company picker">
            <X size={16} />
          </button>
        </div>

        <label className="csv-company-search">
          <Search size={16} aria-hidden="true" />
          <input
            autoFocus
            type="search"
            value={query}
            placeholder="Search by company name, website, or LinkedIn"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        {error && <div className="csv-inline-error" role="alert">{error}</div>}

        <div className="csv-company-results" aria-busy={busy}>
          {busy && <div className="muted small csv-company-empty">Searching Airtable…</div>}
          {!busy && results.length === 0 && (
            <div className="csv-company-empty">
              <Building2 size={24} aria-hidden="true" />
              <div>No matching Companies found.</div>
              <div className="muted small">
                Try the company’s domain or LinkedIn URL, or skip {affectedRows === 1 ? `this ${subjectLabel}` : `these ${subjectLabel === 'company' ? 'companies' : 'leads'}`}.
              </div>
            </div>
          )}
          {!busy &&
            results.map((company) => (
              <button
                type="button"
                className="csv-company-option"
                key={company.id}
                onClick={() => onSelect(company)}
              >
                <Building2 size={18} aria-hidden="true" />
                <span className="csv-company-option-main">
                  <strong>{company.name || 'Unnamed company'}</strong>
                  <span className="muted small">
                    {[company.website, company.linkedin].filter(Boolean).join(' · ') || 'No website or LinkedIn stored'}
                  </span>
                </span>
                <span className="csv-company-pick">Select</span>
              </button>
            ))}
        </div>

        <div className="pipe-modal-actions">
          <button className="btn ghost sm" onClick={onClose}>Cancel</button>
          <button className="btn danger sm" onClick={onSkip}>
            Skip {affectedRows === 1 ? `this ${subjectLabel}` : `all ${affectedRows} ${subjectLabel === 'company' ? 'companies' : 'leads'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
