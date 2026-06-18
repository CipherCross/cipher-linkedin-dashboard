import { Link } from 'react-router-dom'
import type { Instance } from '../lib/types'
import { instanceName } from '../lib/leads'
import { ago } from './CampaignTable'
import { Avatar } from './Avatar'
import { InstanceConfigEditor } from './InstanceConfigEditor'

const STALE_HOURS = 24

export function InstancePanel({ instances }: { instances: Instance[] }) {
  return (
    <div className="card">
      <h2>Accounts</h2>
      <div className="instance-list">
        {instances.map((inst) => {
          const last = inst.last_sync_at ? new Date(inst.last_sync_at).getTime() : 0
          const fresh = Date.now() - last < STALE_HOURS * 3_600_000
          return (
            <div className="instance-item" key={inst.id}>
              <div className="instance-row">
                <Avatar inst={inst} size={34} />
                <div style={{ minWidth: 0 }}>
                  <Link className="row-link" to={`/account/${encodeURIComponent(inst.id)}`}>
                    {instanceName(inst)}
                  </Link>
                  {inst.account_url && (
                    <a
                      className="li-link"
                      href={inst.account_url}
                      target="_blank"
                      rel="noreferrer"
                      title="Open LinkedIn profile"
                    >
                      in
                    </a>
                  )}
                  <div className="muted small">
                    <span className={`dot inline ${fresh ? 'ok' : 'stale'}`} />
                    {inst.last_sync_at ? `synced ${ago(inst.last_sync_at)}` : 'never synced'}
                    {inst.agent_version && ` · agent v${inst.agent_version}`}
                  </div>
                </div>
              </div>
              <InstanceConfigEditor inst={inst} />
            </div>
          )
        })}
        {instances.length === 0 && <div className="muted">No instances registered.</div>}
      </div>
    </div>
  )
}
