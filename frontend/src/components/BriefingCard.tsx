import { useState } from 'react'
import { useData } from '../lib/DataContext'
import { ago } from './CampaignTable'
import type { BriefingRisk } from '../lib/types'

// Severity → existing badge color classes (see styles.css).
const SEV_CLS: Record<BriefingRisk['severity'], string> = {
  high: 'badge risk',
  med: 'badge status-running',
  low: 'badge senti neu',
}

/** The Morning Briefing: a daily AI-generated digest of the whole pipeline,
 *  generated server-side by /api/briefing (also runs on a cron + posts to Slack).
 *  This card shows the latest stored briefing and lets the team regenerate it. */
export function BriefingCard() {
  const { data, refetch } = useData()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState(false)

  const briefing = data?.briefing ?? null

  async function refresh() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/briefing', { method: 'POST' })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      refetch()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card briefing-card">
      <div className="briefing-head">
        <div>
          <h2 className="briefing-title">📣 Morning briefing</h2>
          {briefing ? (
            <div className="muted small">
              {briefing.briefing_date}
              {briefing.created_at ? ` · generated ${ago(briefing.created_at)}` : ''}
              {briefing.model ? ` · ${briefing.model}` : ''}
            </div>
          ) : (
            <div className="muted small">
              No briefing yet — generate one to see today's pipeline at a glance.
            </div>
          )}
        </div>
        <button className="btn-accent" onClick={refresh} disabled={busy}>
          {busy ? 'Analyzing…' : briefing ? 'Refresh briefing' : 'Generate briefing'}
        </button>
      </div>

      {err && <div className="banner">{err}</div>}

      {briefing && (
        <>
          {briefing.headline && <div className="briefing-headline">{briefing.headline}</div>}
          {briefing.summary && <p className="briefing-summary">{briefing.summary}</p>}

          {briefing.actions?.length > 0 && (
            <div className="briefing-actions">
              <div className="briefing-label">Today’s actions</div>
              <ol>
                {briefing.actions.map((a, i) => (
                  <li key={i}>
                    <span className={`badge ${a.priority === 'high' ? 'risk' : 'senti neu'}`}>
                      {a.priority}
                    </span>{' '}
                    {a.text}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {briefing.risks?.length > 0 && (
            <div className="briefing-risks">
              <div className="briefing-label">Risks</div>
              <ul>
                {briefing.risks.map((r, i) => (
                  <li key={i}>
                    <span className={SEV_CLS[r.severity]} title={r.kind}>
                      {r.severity}
                    </span>{' '}
                    {r.text}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {briefing.sections?.length > 0 && (
            <>
              <button
                className="briefing-details-toggle"
                onClick={() => setShowDetails((s) => !s)}
              >
                <span className="coach-digest-caret">{showDetails ? '▾' : '▸'}</span>
                {showDetails ? 'Hide details' : `Details (${briefing.sections.length})`}
              </button>
              {showDetails && (
                <div className="briefing-sections">
                  {briefing.sections.map((s, i) => (
                    <div className="briefing-section" key={i}>
                      <div className="briefing-section-title">{s.title}</div>
                      <div className="small">{s.body}</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
