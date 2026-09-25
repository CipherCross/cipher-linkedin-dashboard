import { Link } from 'react-router-dom'
import { Users } from 'lucide-react'
import type { Instance, SyncRun } from '../lib/types'
import { instanceName } from '../lib/leads'
import { ago } from '../lib/format'
import { freshnessLevel } from '../lib/freshness'
import type { FreshnessLevel } from '../lib/freshness'
import { Avatar } from './Avatar'
import { EmptyState, Panel, SectionHeader, StatusText, type Tone } from '../ui'
import { InstanceConfigEditor } from './InstanceConfigEditor'

const STRIP_RUNS = 14

// Stale accounts are the reason to open this page, so surface them first.
const TIER_ORDER: Record<FreshnessLevel, number> = { stale: 0, warn: 1, ok: 2 }

const FRESHNESS_TONE: Record<FreshnessLevel, Tone> = { ok: 'success', warn: 'warning', stale: 'danger' }

export function InstancePanel({ instances, runs = [] }: { instances: Instance[]; runs?: SyncRun[] }) {
  const sorted = [...instances].sort((a, b) => {
    const d = TIER_ORDER[freshnessLevel(a.last_sync_at)] - TIER_ORDER[freshnessLevel(b.last_sync_at)]
    if (d !== 0) return d
    // Within a tier, the least-recently-synced (or never-synced) account first.
    const ta = a.last_sync_at ? new Date(a.last_sync_at).getTime() : 0
    const tb = b.last_sync_at ? new Date(b.last_sync_at).getTime() : 0
    return ta - tb
  })
  return (
    <Panel>
      <SectionHeader title="Accounts" />
      <div className="flex flex-col gap-group">
        {sorted.map((inst) => {
          const level = freshnessLevel(inst.last_sync_at)
          return (
            // Two columns: the avatar, then everything else — so the uptime
            // strip and the config controls line up under the account name
            // without an indent sized to the avatar by hand.
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-app-sm gap-y-app-sm [&+&]:border-t [&+&]:border-app-border [&+&]:pt-group" key={inst.id}>
              <Avatar inst={inst} size={32} />
              <div className="min-w-0">
                <Link
                  className="text-app-text no-underline transition-colors hover:text-app-accent hover:underline"
                  to={`/account/${encodeURIComponent(inst.id)}`}
                >
                  {instanceName(inst)}
                </Link>
                {inst.account_url && (
                  <a
                    className="inline-block ml-app-sm px-app-xs rounded-sm bg-[var(--linkedin)] text-(--linkedin-fg) text-app-meta font-bold no-underline align-text-bottom hover:bg-[var(--linkedin-hover)]"
                    href={inst.account_url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open LinkedIn profile"
                  >
                    in
                  </a>
                )}
                <div>
                  {/* ok/warn/stale mirror the header SyncChip. */}
                  <StatusText
                    tone={FRESHNESS_TONE[level]}
                    icon={<span className="size-[7px] rounded-full bg-current" aria-hidden="true" />}
                  >
                    {inst.last_sync_at ? `synced ${ago(inst.last_sync_at)}` : 'never synced'}
                    {inst.agent_version && ` · agent v${inst.agent_version}`}
                  </StatusText>
                </div>
              </div>
              <UptimeStrip runs={runs} instanceId={inst.id} />
              <div className="col-start-2 min-w-0">
                <InstanceConfigEditor inst={inst} />
              </div>
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
    </Panel>
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
  const okCount = recent.filter((r) => r.status === 'ok').length
  return (
    <div
      className="col-start-2 flex gap-0.5 items-end"
      role="img"
      aria-label={`Recent sync runs: ${okCount} of ${recent.length} ok`}
      title="Recent sync runs — newest on the right"
    >
      {recent.map((r) => (
        <span
          key={r.id}
          className={`uptime-tick ${r.status}`}
          // Error ticks are also shorter, so they read without relying on colour.
          style={r.status === 'error' ? { height: 9 } : undefined}
          title={`${r.status} · ${ago(r.started_at)}${r.error ? ` · ${r.error}` : ''}`}
        />
      ))}
    </div>
  )
}
