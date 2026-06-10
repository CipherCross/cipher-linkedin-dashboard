import type { Lead } from '../lib/types'

export function Funnel({ leads }: { leads: Lead[] }) {
  const total = leads.length
  const invited = leads.filter((l) => l.invited_at).length
  const accepted = leads.filter((l) => l.connected_at).length
  const replied = leads.filter((l) => l.replied_at).length
  const pending = leads.filter((l) => l.invited_at && !l.connected_at).length

  const stages = [
    { label: 'Leads', count: total, of: null as number | null, color: '#7c89a8' },
    { label: 'Invited', count: invited, of: total, color: '#4f8ef7' },
    { label: 'Accepted', count: accepted, of: invited, color: '#34c98e' },
    { label: 'Replied', count: replied, of: accepted, color: '#f7b94f' },
  ]

  return (
    <div className="card">
      <h2>Funnel</h2>
      <div className="funnel">
        {stages.map((s) => (
          <div className="funnel-row" key={s.label}>
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
            <span className="funnel-count">{s.count.toLocaleString('en-US')}</span>
            <span className="funnel-rate muted">
              {s.of != null && s.of > 0 ? `${((100 * s.count) / s.of).toFixed(1)}%` : ''}
            </span>
          </div>
        ))}
      </div>
      <div className="muted small" style={{ marginTop: 10 }}>
        {pending.toLocaleString('en-US')} invites still pending (sent, not yet accepted)
      </div>
    </div>
  )
}
