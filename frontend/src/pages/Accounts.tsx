import { Link } from 'react-router-dom'
import { useData } from '../lib/DataContext'
import { instanceName } from '../lib/leads'
import { ago } from '../components/CampaignTable'
import { Avatar } from '../components/Avatar'

const STALE_HOURS = 24

export function Accounts() {
  const { data } = useData()
  if (!data) return null

  const rows = data.instances.map((inst) => {
    const campaigns = data.campaigns.filter((c) => c.instance_id === inst.id)
    const leads = data.leads.filter((l) => l.instance_id === inst.id)
    const weekAgo = Date.now() - 7 * 86_400_000
    const invited = leads.filter((l) => l.invited_at)
    const accepted = leads.filter((l) => l.connected_at)
    const replied = leads.filter((l) => l.replied_at)
    const last = inst.last_sync_at ? new Date(inst.last_sync_at).getTime() : 0
    return {
      inst,
      fresh: Date.now() - last < STALE_HOURS * 3_600_000,
      campaigns: campaigns.length,
      leads: leads.length,
      invites: invited.length,
      invites7d: invited.filter((l) => new Date(l.invited_at!).getTime() > weekAgo).length,
      pending: leads.filter((l) => l.invited_at && !l.connected_at).length,
      acceptPct: pct(accepted.length, invited.length),
      replyPct: pct(replied.length, accepted.length),
    }
  })

  return (
    <>
      <header>
        <div>
          <h1>Accounts</h1>
          <div className="muted small">
            Side-by-side comparison of all Linked Helper instances — click one
            for warm-up and response-time analysis.
          </div>
        </div>
      </header>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th className="num">Campaigns</th>
              <th className="num">Leads</th>
              <th className="num">Invites</th>
              <th className="num">Invites 7d</th>
              <th className="num">Pending</th>
              <th className="num">Accept %</th>
              <th className="num">Reply %</th>
              <th>Last sync</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.inst.id}>
                <td>
                  <div className="account-cell">
                    <Avatar inst={r.inst} size={28} />
                    <span className={`dot inline ${r.fresh ? 'ok' : 'stale'}`} />
                    <Link className="row-link" to={`/account/${encodeURIComponent(r.inst.id)}`}>
                      {instanceName(r.inst)}
                    </Link>
                    {r.inst.account_url && (
                      <a className="li-link" href={r.inst.account_url} target="_blank"
                        rel="noreferrer" title="Open LinkedIn profile">in</a>
                    )}
                  </div>
                </td>
                <td className="num">{r.campaigns}</td>
                <td className="num">{r.leads.toLocaleString('en-US')}</td>
                <td className="num">{r.invites.toLocaleString('en-US')}</td>
                <td className="num">{r.invites7d}</td>
                <td className="num">{r.pending.toLocaleString('en-US')}</td>
                <td className="num">{r.acceptPct}</td>
                <td className="num">{r.replyPct}</td>
                <td className="muted">{r.inst.last_sync_at ? ago(r.inst.last_sync_at) : 'never'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={9} className="muted">No instances registered.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

const pct = (a: number, b: number) => (b > 0 ? ((100 * a) / b).toFixed(1) + '%' : '—')
