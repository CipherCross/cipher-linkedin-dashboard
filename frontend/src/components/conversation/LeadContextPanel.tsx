import { useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { authPost } from '../../lib/api'
import { useAuth } from '../../lib/AuthContext'
import { useData } from '../../lib/DataContext'
import { useToast } from '../../lib/ToastContext'
import { usePipelineActions } from '../../lib/usePipelineActions'
import { ageRange } from '../../lib/leads'
import { PIPELINE_STAGES, stageById, substatusLabel } from '../../lib/pipeline'
import type { Gender, Instance, Lead } from '../../lib/types'
import { Badge, SelectField } from '../../ui'
import { Avatar } from '../Avatar'
import { LeadNotesPanel } from '../LeadNotesPanel'
import { LeadInsights } from './LeadInsights'

export function ContextHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="m-0 text-app-meta font-semibold uppercase tracking-[var(--tracking-caps)] text-app-text-muted">
      {children}
    </h3>
  )
}

/**
 * The workspace's first column: who this is and where the outreach stands —
 * campaign and account, who the lead and their company are, the pipeline
 * fields, and the team's notes. Everything is visible at once; the column scrolls on its own.
 */
export function LeadContextPanel({
  lead,
  live,
  campaignName,
  account,
  accountLabel,
  status,
  onLinkClick,
  onRequestLost,
  onNoteDirtyChange,
}: {
  /** The snapshot the conversation opened with (identity, notes). */
  lead: Lead
  /** The live row, for fields edited while the conversation is open. */
  live: Lead
  campaignName: string
  account: Instance | undefined
  accountLabel: string
  /** Reply status badges. */
  status: ReactNode
  onLinkClick: (to: string) => (event: MouseEvent) => void
  onRequestLost: () => void
  onNoteDirtyChange: (dirty: boolean) => void
}) {
  const { isAdmin } = useAuth()
  const { refetch, patchLead } = useData()
  const toast = useToast()
  const { setStage, assign, members } = usePipelineActions()
  const [savingGender, setSavingGender] = useState(false)
  const liveStage = stageById(live.pipeline_stage)
  const campaignHref = `/campaign/${encodeURIComponent(lead.campaign_id)}`

  // Gender override → /api/pipeline set_gender. A non-null value marks the row
  // SDR-reviewed (demo_model='manual', confidence 1); null clears only the gender
  // lifecycle so the next classify run re-infers it. Age remains independent.
  // Optimistic via patchLead, reverting the snapshot on failure; on success the
  // response already carries the authoritative fields, so patch those directly.
  async function setGender(gender: Gender | null) {
    setSavingGender(true)
    const snapshot: Partial<Lead> = {
      gender: live.gender ?? null,
      gender_confidence: live.gender_confidence ?? null,
      gender_inferred_at: live.gender_inferred_at ?? null,
      gender_model_version: live.gender_model_version ?? null,
      demo_model: live.demo_model ?? null,
      demo_inferred_at: live.demo_inferred_at ?? null,
    }
    patchLead(
      lead.id,
      gender === null
        ? {
            gender: null,
            gender_confidence: null,
            gender_inferred_at: null,
            gender_model_version: null,
            demo_model: null,
            demo_inferred_at: null,
          }
        : {
            gender,
            gender_confidence: 1,
            gender_inferred_at: new Date().toISOString(),
            gender_model_version: null,
            demo_model: 'manual',
          },
    )
    try {
      const res = await authPost('/api/pipeline', { action: 'set_gender', lead_id: lead.id, gender })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      patchLead(lead.id, {
        gender: (j.gender ?? null) as Gender | null,
        gender_confidence: j.gender_confidence ?? null,
        gender_inferred_at: j.gender_inferred_at ?? null,
        gender_model_version: j.gender_model_version ?? null,
        demo_model: j.demo_model ?? null,
        demo_inferred_at: j.demo_inferred_at ?? null,
      })
      // The API applies a confirmation to every campaign row for this
      // account/profile; refresh so duplicates elsewhere get the same value.
      refetch()
    } catch (e) {
      patchLead(lead.id, snapshot)
      toast.error(`Couldn't update gender: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSavingGender(false)
    }
  }

  return (
    <div className="conversation-pane-body flex flex-col gap-section">
      <section className="flex flex-col gap-stack" aria-label="Outreach">
        <ContextHeading>Outreach</ContextHeading>
        <dl className="conversation-facts">
          <dt>Campaign</dt>
          <dd>
            <Link
              className="text-app-accent no-underline hover:underline [overflow-wrap:anywhere]"
              to={campaignHref}
              onClick={onLinkClick(campaignHref)}
            >
              {campaignName}
            </Link>
          </dd>
          <dt>Account</dt>
          <dd>
            {account?.account_url ? (
              <a
                className="inline-flex items-center gap-app-sm text-app-text no-underline hover:underline"
                href={account.account_url}
                target="_blank"
                rel="noreferrer"
                title={`Outreach account: ${accountLabel}`}
              >
                <Avatar key={account.id} inst={account} size={20} />
                <span className="truncate">{accountLabel}</span>
              </a>
            ) : (
              <span className="inline-flex items-center gap-app-sm">
                {account && <Avatar key={account.id} inst={account} size={20} />}
                <span className="truncate">{accountLabel}</span>
              </span>
            )}
          </dd>
          <dt>Reply</dt>
          <dd className="flex flex-wrap gap-app-xs">{status}</dd>
        </dl>
      </section>

      <LeadInsights lead={{ instance_id: lead.instance_id, profile_url: lead.profile_url, company: lead.company }} />

      <section className="flex flex-col gap-group" aria-label="Lead details">
        <ContextHeading>Lead details</ContextHeading>
        <SelectField
          label="Stage"
          value={live.pipeline_stage ?? ''}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'lost') onRequestLost()
            else void setStage(live, v || null)
          }}
        >
          <option value="">Not in pipeline</option>
          {PIPELINE_STAGES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </SelectField>
        {liveStage && liveStage.substatuses.length > 0 && (
          <SelectField
            label="Substatus"
            value={live.pipeline_substatus ?? ''}
            onChange={(e) => void setStage(live, live.pipeline_stage, { substatus: e.target.value || null })}
          >
            <option value="">—</option>
            {liveStage.substatuses.map((s) => (
              <option key={s} value={s}>{substatusLabel(s)}</option>
            ))}
          </SelectField>
        )}
        <SelectField
          label="Owner"
          value={String(live.assigned_to ?? '')}
          onChange={(e) => void assign(live, e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={String(m.id)}>{m.name}</option>
          ))}
        </SelectField>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-group items-start">
          <SelectField
            label="Gender"
            value={live.gender ?? ''}
            disabled={savingGender || !isAdmin}
            onChange={(e) => {
              const v = e.target.value
              if (v === '') return
              void setGender(v === 'clear' ? null : (v as Gender))
            }}
            help={live.gender
              ? live.demo_model === 'manual'
                ? <Badge title="Reviewed by an SDR — manual override">Reviewed</Badge>
                : (
                  <Badge title="Inferred by AI from name + headline — pick a value to confirm">
                    AI{live.gender_confidence != null ? ` ·${Math.round(live.gender_confidence * 100)}%` : ''}
                  </Badge>
                )
              : undefined}
          >
            {!live.gender && <option value="" disabled>Set gender…</option>}
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="unknown">Unknown</option>
            {live.gender && <option value="clear">Clear override → re-infer</option>}
          </SelectField>
          <div className="flex flex-col gap-app-xs">
            <span className="text-app-meta font-semibold text-app-text-secondary">Age</span>
            <span className="tabular-nums font-semibold min-h-control inline-flex items-center">{ageRange(live) ?? '—'}</span>
          </div>
        </div>
      </section>

      <LeadNotesPanel lead={lead} onDirtyChange={onNoteDirtyChange} />
    </div>
  )
}
