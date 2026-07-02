import { Link } from 'react-router-dom'
import { Users } from 'lucide-react'
import type { Instance, SyncRun } from '../lib/types'
import { instanceName } from '../lib/leads'
import { ago } from '../lib/format'
import { Avatar } from './Avatar'
import { EmptyState } from './EmptyState'
import { InstanceConfigEditor } from './InstanceConfigEditor'

const STALE_HOURS = 24
const STRIP_RUNS = 14

export function InstancePanel({ instances, runs = [] }: { instances: Instance[]; runs?: SyncRun[] }) {
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
              <UptimeStrip runs={runs} instanceId={inst.id} />
              <InstanceConfigEditor inst={inst} />
            </div>
          )
        })}
        {instances.length === 0 && (
          <EmptyState
            icon={Users}
            title="No accounts registered"
            hint="Run the sync agent on a notebook to register an account."
          />
        )}
      </div>
    </div>
  )
}

/** The instance's most recent sync runs as colored ticks (oldest → newest), so
 *  a flapping account reads at a glance. Data is already in `syncRuns`. */
function UptimeStrip({ runs, instanceId }: { runs: SyncRun[]; instanceId: string }) {
  // `runs` arrives newest-first (DataContext order); take this instance's most
  // recent STRIP_RUNS and flip to chronological for the strip.
  const recent = runs
    .filter((r) => r.instance_id === instanceId)
    .slice(0, STRIP_RUNS)
    .reverse()
  if (recent.length === 0) return null
  return (
    <div className="uptime-strip" title="Recent sync runs — newest on the right">
      {recent.map((r) => (
        <span
          key={r.id}
          className={`uptime-tick ${r.status}`}
          title={`${r.status} · ${ago(r.started_at)}${r.error ? ` · ${r.error}` : ''}`}
        />
      ))}
    </div>
  )
}
