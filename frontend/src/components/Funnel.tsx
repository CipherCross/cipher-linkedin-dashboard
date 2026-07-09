import { Fragment } from 'react'
import type { Lead } from '../lib/types'
import { num, pct } from '../lib/format'
import { useData } from '../lib/DataContext'
import { PIPELINE_CHECKPOINTS, checkpointCount, reachByLead, stageColor } from '../lib/pipeline'

/** Vertical funnel coloured by the shared status ramp (lead → invite → accept →
 *  reply). The conversion rate between two stages rides the connector between
 *  their bars, so the drop-off reads top-to-bottom instead of as a column of
 *  grey percentages off to the side.
 *
 *  With `showPipeline`, a "Manual pipeline" section is appended showing the
 *  happy-path checkpoints reached in the manual CRM overlay (Interested →
 *  Client). "Reached" combines each lead's current stage with the deepest stage
 *  it ever touched (from pipeline_events), so a lead that advanced then went cold
 *  still counts. The section renders nothing if no lead has ever been staged. */
export function Funnel({ leads, showPipeline }: { leads: Lead[]; showPipeline?: boolean }) {
  const { data } = useData()
  const total = leads.length
  const invited = leads.filter((l) => l.invited_at).length
  const accepted = leads.filter((l) => l.connected_at).length
  const replied = leads.filter((l) => l.replied_at).length
  const pending = leads.filter((l) => l.invited_at && !l.connected_at).length

  const stages = [
    { label: 'Leads', count: total, color: 'var(--text-muted)', of: null as number | null, verb: '' },
    { label: 'Invited', count: invited, color: 'var(--accent)', of: total, verb: 'invited' },
    { label: 'Accepted', count: accepted, color: 'var(--success)', of: invited, verb: 'accepted' },
    { label: 'Replied', count: replied, color: 'var(--warning)', of: accepted, verb: 'replied' },
  ]

  // How far each lead reached in the manual pipeline (current stage ∪ event
  // history), scoped to the leads passed in (events are filtered to these ids).
  const reach = showPipeline ? reachByLead(leads, data?.pipelineEvents ?? []) : null
  const pipelineRows =
    reach && reach.size > 0
      ? PIPELINE_CHECKPOINTS.map((cp) => ({ ...cp, count: checkpointCount(reach, cp) }))
      : null

  return (
    <div className="card">
      <h2>Funnel</h2>
      <div className="funnel">
        {stages.map((s, i) => (
          <Fragment key={s.label}>
            {i > 0 && (
              <div className="funnel-conv">
                <span className="funnel-conv-rate">
                  {s.of && s.of > 0 ? pct(s.count, s.of) : '—'}
                </span>
                <span className="funnel-conv-verb">{s.verb}</span>
              </div>
            )}
            <div className="funnel-row">
              <span className="funnel-label">{s.label}</span>
              <div className="funnel-track">
                <div
                  className="funnel-bar"
                  style={{
                    width: total > 0 ? `${Math.max((100 * s.count) / total, s.count > 0 ? 2 : 0)}%` : 0,
                    background: s.color,
                  }}
                />
              </div>
              <span className="funnel-count">{num(s.count)}</span>
            </div>
          </Fragment>
        ))}
      </div>
      <div className="muted small" style={{ marginTop: 12 }}>
        {num(pending)} invites still pending (sent, not yet accepted)
      </div>

      {pipelineRows && (
        <>
          <div className="funnel-section-label">Manual pipeline</div>
          <div className="funnel">
            {pipelineRows.map((r) => (
              <div className="funnel-row" key={r.id}>
                <span className="funnel-label">{r.label}</span>
                <div className="funnel-track">
                  <div
                    className="funnel-bar"
                    style={{
                      width:
                        replied > 0
                          ? `${Math.max((100 * r.count) / replied, r.count > 0 ? 2 : 0)}%`
                          : 0,
                      background: stageColor(r.id),
                    }}
                  />
                </div>
                <span className="funnel-count">{num(r.count)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
