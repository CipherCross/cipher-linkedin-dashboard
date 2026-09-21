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
    <div className="pipe-modal-overlay" onClick={onClose}>
      <div
        className="pipe-modal w-[min(720px,100%)] max-h-[min(760px,calc(100vh-40px))]"
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

        <label className="flex items-center gap-app-sm px-2.5 border border-app-border rounded-md bg-app-surface-2 focus-within:border-app-accent focus-within:shadow-[0_0_0_3px_var(--accent-subtle)] [&_input]:flex-1 [&_input]:border-0 [&_input]:pl-0 [&_input]:bg-transparent [&_input]:shadow-none!">
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

        <div className="min-h-[180px] max-h-[440px] overflow-y-auto flex flex-col gap-[6px]" aria-busy={busy}>
          {busy && <div className="muted small min-h-[180px] flex flex-col items-center justify-center gap-[5px] text-center [&_svg]:text-app-text-muted">Searching Airtable…</div>}
          {!busy && results.length === 0 && (
            <div className="min-h-[180px] flex flex-col items-center justify-center gap-[5px] text-center [&_svg]:text-app-text-muted">
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
                className="w-full grid grid-cols-[24px_minmax(0,1fr)_auto] gap-2.5 items-center text-left p-2.5 border border-app-border rounded-md bg-app-surface-2 text-app-text cursor-pointer hover:border-app-accent-border hover:bg-app-surface-3 [&>svg]:text-app-accent"
                key={company.id}
                onClick={() => onSelect(company)}
              >
                <Building2 size={18} aria-hidden="true" />
                <span className="min-w-0 flex flex-col gap-0.5">
                  <strong>{company.name || 'Unnamed company'}</strong>
                  <span className="muted small">
                    {[company.website, company.linkedin].filter(Boolean).join(' · ') || 'No website or LinkedIn stored'}
                  </span>
                </span>
                <span className="text-app-accent text-[length:var(--text-xs)] font-semibold">Select</span>
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
