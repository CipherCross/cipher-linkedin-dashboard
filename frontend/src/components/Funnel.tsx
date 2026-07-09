import { Fragment } from 'react'
import type { Lead } from '../lib/types'
import { num, pct } from '../lib/format'
import { useData } from '../lib/DataContext'
import { PIPELINE_CHECKPOINTS, checkpointCount, reachByLead, stageColor } from '../lib/pipeline'

/** One continuous vertical funnel. The automated milestones (Leads → Invited →
 *  Accepted → Replied), computed client-side from lead timestamps, flow straight
 *  into the manual-pipeline checkpoints (Interested → … → Client) without a break
 *  in the bar sequence. The conversion rate between two consecutive stages rides
 *  the connector between their bars, so drop-off reads top-to-bottom.
 *
 *  With `showPipeline`, the manual half is appended. "Reached" combines each
 *  lead's current stage with the deepest stage it ever touched (from
 *  pipeline_events), so a lead that advanced then went cold still counts. The
 *  manual half is visually distinguished (tinted rows + a labelled divider) and
 *  self-hides entirely when no lead has ever been staged — so it is a no-op in
 *  prod until the team starts using the pipeline board. */

interface FunnelRow {
  key: string
  label: string
  count: number
  color: string
  /** Base for the conversion connector above this row (previous stage count);
   *  null on the first row (Leads), which has no connector. */
  base: number | null
  /** Verb describing the transition into this stage (rides the connector). */
  verb: string
  /** Manual-pipeline row — gets the distinct visual treatment. */
  pipeline?: boolean
  /** First manual row — its connector renders the "Manual pipeline" divider. */
  boundary?: boolean
}

// Short verbs for the manual checkpoints, keyed by checkpoint id — parallel to
// the automated "invited / accepted / replied" transitions.
const PIPELINE_VERB: Record<string, string> = {
  interested: 'interested',
  negotiations_call: 'to negotiations',
  call_booked: 'call booked',
  call_done: 'call done',
  proposal_presented: 'proposal sent',
  client: 'became clients',
}

export function Funnel({ leads, showPipeline }: { leads: Lead[]; showPipeline?: boolean }) {
  const { data } = useData()
  const total = leads.length
  const invited = leads.filter((l) => l.invited_at).length
  const accepted = leads.filter((l) => l.connected_at).length
  const replied = leads.filter((l) => l.replied_at).length
  const pending = leads.filter((l) => l.invited_at && !l.connected_at).length

  // How far each lead reached in the manual pipeline (current stage ∪ event
  // history), scoped to the leads passed in (events are filtered to these ids).
  const reach = showPipeline ? reachByLead(leads, data?.pipelineEvents ?? []) : null
  const pipelineRows =
    reach && reach.size > 0
      ? PIPELINE_CHECKPOINTS.map((cp) => ({ ...cp, count: checkpointCount(reach, cp) }))
      : null

  const rows: FunnelRow[] = [
    { key: 'leads', label: 'Leads', count: total, color: 'var(--text-muted)', base: null, verb: '' },
    { key: 'invited', label: 'Invited', count: invited, color: 'var(--accent)', base: total, verb: 'invited' },
    { key: 'accepted', label: 'Accepted', count: accepted, color: 'var(--success)', base: invited, verb: 'accepted' },
    { key: 'replied', label: 'Replied', count: replied, color: 'var(--warning)', base: accepted, verb: 'replied' },
  ]

  if (pipelineRows) {
    let prev = replied
    pipelineRows.forEach((r, i) => {
      rows.push({
        key: r.id,
        label: r.label,
        count: r.count,
        color: stageColor(r.id),
        base: prev,
        verb: PIPELINE_VERB[r.id] ?? '',
        pipeline: true,
        boundary: i === 0,
      })
      prev = r.count
    })
  }

  // Overall Lead → Client conversion (only when pipeline data exists).
  const clients = pipelineRows ? pipelineRows[pipelineRows.length - 1].count : 0

  const barWidth = (count: number) =>
    total > 0 ? `${Math.max((100 * count) / total, count > 0 ? 2 : 0)}%` : 0

  return (
    <div className="card">
      <h2>Funnel</h2>
      <div className="funnel">
        {rows.map((s, i) => (
          <Fragment key={s.key}>
            {i > 0 &&
              (s.boundary ? (
                <div className="funnel-divider">
                  <span className="funnel-divider-label">Manual pipeline</span>
                  <span className="funnel-conv-inline">
                    <span className="funnel-conv-rate">
                      {s.base && s.base > 0 ? pct(s.count, s.base) : '—'}
                    </span>
                    <span className="funnel-conv-verb">{s.verb}</span>
                  </span>
                </div>
              ) : (
                <div className="funnel-conv">
                  <span className="funnel-conv-rate">
                    {s.base && s.base > 0 ? pct(s.count, s.base) : '—'}
                  </span>
                  <span className="funnel-conv-verb">{s.verb}</span>
                </div>
              ))}
            <div className={`funnel-row${s.pipeline ? ' funnel-row--pipeline' : ''}`}>
              <span className="funnel-label">{s.label}</span>
              <div className="funnel-track">
                <div
                  className="funnel-bar"
                  style={{ width: barWidth(s.count), background: s.color }}
                />
              </div>
              <span className="funnel-count">{num(s.count)}</span>
            </div>
          </Fragment>
        ))}
      </div>

      <div className="funnel-footer">
        <span className="muted small">
          {num(pending)} invites still pending (sent, not yet accepted)
        </span>
        {pipelineRows && (
          <span className="funnel-overall">
            <strong>{num(clients)}</strong> clients from {num(total)} leads ·{' '}
            <strong>{total > 0 ? pct(clients, total) : '—'}</strong> Lead→Client
          </span>
        )}
      </div>
    </div>
  )
}
