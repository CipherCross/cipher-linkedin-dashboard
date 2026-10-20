import { useEffect, useId, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { coachContextClient, type CoachContextClient, type CoachContextView } from '../../lib/coachContext'
import { Button, ExternalLinkButton, InlineError, relativeTime } from '../../ui'
import { Skeleton } from '../Skeleton'

function Heading({ children }: { children: string }) {
  return (
    <h3 className="m-0 text-app-meta font-semibold uppercase tracking-[var(--tracking-caps)] text-app-text-muted">
      {children}
    </h3>
  )
}

/** A long text shown as a few lines, with "More" to read it all. */
function Excerpt({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 220
  return (
    <div className="flex flex-col items-start gap-app-xs">
      <p className={`m-0 text-app-table whitespace-pre-wrap [overflow-wrap:anywhere] ${!open && long ? 'line-clamp-4' : ''}`}>
        {text}
      </p>
      {long && (
        <Button variant="ghost" size="sm" className="px-0" onClick={() => setOpen((v) => !v)}>
          {open ? 'Less' : 'More'}
        </Button>
      )}
    </div>
  )
}

/**
 * What the coach knows about this lead beyond the thread: their LinkedIn
 * profile (synced from Linked Helper), their company (Apollo data in our CRM)
 * and its website — and, one click away, exactly what the coach reads.
 * Opening it fills stale caches, so the first open of a conversation can take
 * a few seconds.
 */
export function LeadInsights({
  lead,
  client = coachContextClient,
}: {
  lead: { instance_id: string; profile_url: string; company?: string | null }
  client?: Pick<CoachContextClient, 'context'>
}) {
  const [view, setView] = useState<CoachContextView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [showRaw, setShowRaw] = useState(false)
  const rawId = useId()

  useEffect(() => {
    let cancelled = false
    setView(null)
    setError(null)
    client.context({ instance_id: lead.instance_id, profile_url: lead.profile_url, company: lead.company ?? null })
      .then((v) => { if (!cancelled) setView(v) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [lead.instance_id, lead.profile_url, lead.company, client, attempt])

  if (error) {
    return <InlineError title="Lead context could not load." message={error} onRetry={() => setAttempt((n) => n + 1)} />
  }
  if (!view) {
    return (
      <div className="flex flex-col gap-stack" aria-busy="true" aria-label="Loading lead context">
        <Skeleton width="40%" height={13} />
        <Skeleton width="90%" height={13} />
        <Skeleton width="75%" height={13} />
      </div>
    )
  }

  const p = view.profile
  const c = view.company
  const w = view.website
  const jobs = (p?.positions ?? []).filter((j) => j.title || j.company)

  return (
    <div className="flex flex-col gap-section">
      <section className="flex flex-col gap-stack" aria-label="Profile">
        <Heading>Profile</Heading>
        {p ? (
          <>
            {(p.current_title || p.current_company) && (
              <p className="m-0 text-app-table font-semibold">{[p.current_title, p.current_company].filter(Boolean).join(' at ')}</p>
            )}
            {p.location && <p className="m-0 text-app-meta text-app-text-muted">{p.location}</p>}
            {jobs.length > 1 && (
              <ul className="m-0 pl-app-lg text-app-meta text-app-text-secondary flex flex-col gap-app-xs">
                {jobs.slice(1, 4).map((j, i) => (
                  <li key={i}>{[j.title, j.company].filter(Boolean).join(' at ')}{j.start_year ? ` (${j.start_year}–${j.end_year ?? 'now'})` : ''}</li>
                ))}
              </ul>
            )}
            {p.about && <Excerpt text={p.about} />}
            {p.skills.length > 0 && <p className="m-0 text-app-meta text-app-text-muted">Skills: {p.skills.slice(0, 12).join(', ')}</p>}
          </>
        ) : (
          <p className="m-0 text-app-meta text-app-text-muted">
            Not synced yet — the notebook sends profiles of people who replied on its next sync.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-stack" aria-label="Company">
        <Heading>Company</Heading>
        {c ? (
          <>
            <p className="m-0 text-app-table font-semibold">{c.company_name ?? lead.company ?? 'Company'}</p>
            <p className="m-0 text-app-meta text-app-text-muted">
              {[c.industry, c.employees && `${c.employees} employees`, c.country, c.founded_year && `founded ${c.founded_year}`].filter(Boolean).join(' · ')}
            </p>
            {c.description && <Excerpt text={c.description} />}
            {c.website && (
              <ExternalLinkButton
                variant="ghost"
                size="sm"
                className="self-start px-0"
                href={/^https?:\/\//i.test(c.website) ? c.website : `https://${c.website}`}
                target="_blank"
                rel="noreferrer"
                icon={<ExternalLink aria-hidden="true" />}
              >
                {c.website.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')}
              </ExternalLinkButton>
            )}
            {w && (
              <p className="m-0 text-app-meta text-app-text-muted" title={relativeTime(w.fetched_at).title}>
                {w.usable ? `Website read ${relativeTime(w.fetched_at).label}` : `Website not readable${w.error ? ` — ${w.error}` : ''}`}
              </p>
            )}
          </>
        ) : (
          <p className="m-0 text-app-meta text-app-text-muted">
            {view.company_checked_at ? 'Not found in the CRM (Apollo imports).' : 'Not checked yet.'}
          </p>
        )}
      </section>

      {!view.our_company_configured && (
        <p className="m-0 text-app-meta text-app-text-muted">
          The coach doesn’t know what we sell yet — add “Our company” on the Playbook page.
        </p>
      )}

      {view.as_the_coach_sees_it && (
        <div className="flex flex-col gap-stack">
          <Button
            variant="ghost"
            size="sm"
            className="self-start px-0 text-app-text-muted"
            aria-expanded={showRaw}
            aria-controls={rawId}
            icon={showRaw ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            onClick={() => setShowRaw((v) => !v)}
          >
            What the coach reads
          </Button>
          {showRaw && (
            <pre id={rawId} className="lead-insights-raw">{view.as_the_coach_sees_it}</pre>
          )}
        </div>
      )}
    </div>
  )
}
