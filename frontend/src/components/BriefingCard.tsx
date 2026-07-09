import { useState } from 'react'
import { ChevronDown, ChevronRight, Sunrise } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import type { Briefing, BriefingAction, BriefingChange, BriefingRisk } from '../lib/types'

// Severity → existing badge color classes (see styles.css).
const SEV_CLS: Record<BriefingRisk['severity'], string> = {
  high: 'badge risk',
  med: 'badge status-running',
  low: 'badge senti neu',
}

// Ukrainian display labels for the severity/priority codes (the stored values
// stay high/med/low so the rest of the code and the API contract are unchanged).
const LEVEL_UK: Record<BriefingRisk['severity'], string> = {
  high: 'високий',
  med: 'середній',
  low: 'низький',
}

const ACTION_CLS: Record<BriefingAction['priority'], string> = {
  high: 'badge risk',
  med: 'badge senti neu',
  low: 'badge senti neu',
}

// Day-over-day trend → glyph + color class (mirrors slack.ts TREND_EMOJI).
const TREND: Record<NonNullable<BriefingChange['trend']>, { icon: string; cls: string }> = {
  up: { icon: '▲', cls: 'badge senti pos' },
  down: { icon: '▼', cls: 'badge senti neg' },
  flat: { icon: '▬', cls: 'badge senti neu' },
  new: { icon: '✚', cls: 'badge senti ref' },
  resolved: { icon: '✓', cls: 'badge senti pos' },
}
const TREND_DEFAULT = { icon: '•', cls: 'badge senti neu' }

/** Ukrainian relative time (ago() in CampaignTable is English-only). */
function agoUk(ts: string | null): string {
  if (!ts) return '—'
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60_000)
  if (mins < 1) return 'щойно'
  if (mins < 60) return `${mins} хв тому`
  if (mins < 48 * 60) return `${Math.round(mins / 60)} год тому`
  return `${Math.round(mins / 1440)} дн тому`
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000)

// The pipeline now runs across multiple invocations (see frontend/api/briefing.ts) —
// each POST advances one stage and reports back the job's status. Map that status to
// the busy label the button already showed before the split.
const STAGE_LABEL: Record<string, string> = {
  pending: 'Аналізую…',
  investigating: 'Аналізую…',
  investigated: 'Перевіряю…',
  verifying: 'Перевіряю…',
  verified: 'Формую…',
  structuring: 'Формую…',
}

/** The Morning Briefing: a daily AI-generated digest of the whole pipeline,
 *  generated server-side by /api/briefing (also runs on a cron + posts to Slack).
 *  Shows the latest briefing — including what CHANGED since the previous one — and
 *  lets the team regenerate it or flip back to read the previous day's briefing. */
export function BriefingCard() {
  const { data, refetch } = useData()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [busyStage, setBusyStage] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [viewPrev, setViewPrev] = useState(false)
  // Collapsed by default — the briefing is long and Ukrainian; the KPI row above
  // is the primary content, so show only the headline + top action until expanded.
  const [expanded, setExpanded] = useState(false)

  const briefing = data?.briefing ?? null
  const prevBriefing = data?.prevBriefing ?? null
  const hasPrev = !!prevBriefing
  const showingPrev = viewPrev && hasPrev
  const active: Briefing | null = showingPrev ? prevBriefing : briefing
  // Structured key-metrics strip (label + value shown; note surfaced as a hover
  // tooltip). Optional — old rows / a briefing without metrics simply have none.
  const metrics = active?.metrics ?? []

  // The pipeline is split across invocations now — one POST advances one stage. Loop
  // calling it, showing the reported stage, until it's done/error or we give up. A slow
  // day that never finishes here still keeps advancing via the daily cron / a later click.
  async function refresh() {
    setBusy(true)
    setBusyStage(null)
    const MAX_ITER = 12
    const deadline = Date.now() + 4 * 60_000
    try {
      for (let i = 0; ; i++) {
        const res = await fetch('/api/briefing', { method: 'POST' })
        const j = await res.json().catch(() => ({}))
        if (!res.ok) {
          // A non-JSON body here usually means the platform killed the function before
          // it could return its own JSON error — surface that as "took too long" rather
          // than a raw parse error.
          throw new Error(j.error || `Брифінг не згенерувався (HTTP ${res.status}) — можливо, забракло часу; спробуйте ще раз.`)
        }
        if (j.status === 'done') {
          refetch()
          toast.success('Брифінг оновлено')
          return
        }
        if (j.status === 'error') {
          throw new Error(j.error || 'Брифінг не вдалося згенерувати.')
        }
        setBusyStage(j.status ?? null)
        if (i >= MAX_ITER || Date.now() > deadline) {
          throw new Error('Це триває довше, ніж очікувалось — спробуйте оновити сторінку за кілька хвилин.')
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setBusyStage(null)
    }
  }

  // "з учора" only when the previous briefing is literally the day before today's;
  // otherwise (a gap, or while viewing the previous one) use the neutral label.
  const changesTitle =
    !showingPrev &&
    briefing &&
    prevBriefing &&
    daysBetween(briefing.briefing_date, prevBriefing.briefing_date) === 1
      ? 'Зміни з учора'
      : 'Зміни з попереднього брифінгу'

  return (
    <div className="card briefing-card">
      <div className="briefing-head">
        <div>
          <h2 className="briefing-title">
            <Sunrise size={16} className="briefing-title-icon" />
            Ранковий брифінг{showingPrev ? ' — попередній' : ''}
          </h2>
          {active ? (
            <div className="muted small">
              {active.briefing_date}
              {active.created_at ? ` · згенеровано ${agoUk(active.created_at)}` : ''}
              {active.model ? ` · ${active.model}` : ''}
            </div>
          ) : (
            <div className="muted small">
              Брифінгу ще немає — згенеруйте, щоб побачити стан пайплайну за сьогодні.
            </div>
          )}
        </div>
        <div className="briefing-head-actions">
          {hasPrev && (
            <button className="briefing-prev-toggle" onClick={() => setViewPrev((v) => !v)}>
              {showingPrev ? 'До сьогодні →' : '← Попередній'}
            </button>
          )}
          {!showingPrev && (
            <button className="btn-accent" onClick={refresh} disabled={busy}>
              {busy
                ? STAGE_LABEL[busyStage ?? 'pending'] ?? 'Аналізую…'
                : briefing
                  ? 'Оновити брифінг'
                  : 'Згенерувати брифінг'}
            </button>
          )}
        </div>
      </div>

      {active && (
        <>
          {active.headline && <div className="briefing-headline">{active.headline}</div>}

          {/* Key-metrics strip: the day's headline numbers, always visible. Inline
              styles (no styles.css edits); rgba tints adapt to light/dark. */}
          {metrics.length > 0 && (
            <div
              className="briefing-metrics"
              style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '10px 0 4px' }}
            >
              {metrics.map((m, i) => (
                <div
                  key={i}
                  title={m.note || undefined}
                  style={{
                    flex: '1 1 110px',
                    minWidth: 100,
                    padding: '7px 10px',
                    borderRadius: 8,
                    background: 'rgba(127,127,127,0.10)',
                    border: '1px solid rgba(127,127,127,0.18)',
                  }}
                >
                  {/* Long composite values ("39.2% (335 із 855)") step the font
                      down instead of wrapping to a second line, which made the
                      chip row ragged. */}
                  <div
                    style={{
                      fontSize: m.value.length > 12 ? '0.92rem' : '1.05rem',
                      fontWeight: 600,
                      lineHeight: 1.2,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {m.value}
                  </div>
                  <div className="muted small" style={{ marginTop: 2 }}>
                    {m.label}
                    {m.note ? ' *' : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
          {metrics.some((m) => m.note) && (
            <div className="muted small" style={{ marginTop: 4 }}>
              * — наведіть курсор на картку, щоб побачити деталі
            </div>
          )}

          {/* Collapsed digest: headline (above) + the single top action. */}
          {!expanded && active.actions?.length > 0 && (
            <div className="briefing-top-action">
              <span className={ACTION_CLS[active.actions[0].priority]}>
                {LEVEL_UK[active.actions[0].priority]}
              </span>{' '}
              {active.actions[0].text}
            </div>
          )}

          <button
            className="briefing-details-toggle briefing-expand-toggle"
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {expanded ? 'Згорнути' : 'Показати весь брифінг'}
          </button>

          {expanded && (
          <>
          {active.summary && <p className="briefing-summary">{active.summary}</p>}

          {active.changes?.length > 0 && (
            <div className="briefing-changes">
              <div className="briefing-label">{changesTitle}</div>
              <ul>
                {active.changes.map((c, i) => {
                  const t = c.trend ? TREND[c.trend] : TREND_DEFAULT
                  return (
                    <li key={i}>
                      <span className={t.cls}>{t.icon}</span> {c.text}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {active.actions?.length > 0 && (
            <div className="briefing-actions">
              <div className="briefing-label">Дії на сьогодні</div>
              <ol>
                {active.actions.map((a, i) => (
                  <li key={i}>
                    <span className={ACTION_CLS[a.priority]}>{LEVEL_UK[a.priority]}</span>{' '}
                    {a.text}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {active.risks?.length > 0 && (
            <div className="briefing-risks">
              <div className="briefing-label">Ризики</div>
              <ul>
                {active.risks.map((r, i) => (
                  <li key={i}>
                    <span className={SEV_CLS[r.severity]} title={r.kind}>
                      {LEVEL_UK[r.severity]}
                    </span>{' '}
                    {r.text}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {active.sections?.length > 0 && (
            <>
              <button
                className="briefing-details-toggle"
                onClick={() => setShowDetails((s) => !s)}
              >
                {showDetails ? <ChevronDown size={14} className="coach-digest-caret" /> : <ChevronRight size={14} className="coach-digest-caret" />}
                {showDetails ? 'Сховати деталі' : `Деталі (${active.sections.length})`}
              </button>
              {showDetails && (
                <div className="briefing-sections">
                  {active.sections.map((s, i) => (
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
        </>
      )}
    </div>
  )
}
