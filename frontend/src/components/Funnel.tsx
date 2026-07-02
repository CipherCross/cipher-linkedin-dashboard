import { Fragment } from 'react'
import type { Lead } from '../lib/types'
import { num, pct } from '../lib/format'

/** Vertical funnel coloured by the shared status ramp (lead → invite → accept →
 *  reply). The conversion rate between two stages rides the connector between
 *  their bars, so the drop-off reads top-to-bottom instead of as a column of
 *  grey percentages off to the side. */
export function Funnel({ leads }: { leads: Lead[] }) {
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
    </div>
  )
}
