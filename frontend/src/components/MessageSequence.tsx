import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { CampaignStep } from '../lib/types'
import { num } from '../lib/format'
import { Button, Panel, SectionHeader } from '../ui'
import { SERIES } from './chartTheme'

const SMALL_SAMPLE = 30

const TYPE_LABEL: Record<string, string> = {
  InvitePerson: 'Invite',
  MessageToPerson: 'Message',
}

// The steps that carry the reply-rate story. Everything else (waiters, webhooks,
// profile visits, skill endorsements…) is automation plumbing and gets collapsed.
const PRIMARY_TYPES = new Set(['InvitePerson', 'MessageToPerson'])

type Indexed = { step: CampaignStep; i: number }
type Group = { kind: 'primary'; step: CampaignStep; i: number } | { kind: 'auto'; steps: Indexed[] }

/** The campaign's outbound message sequence: each invite/message step's
 *  send/reply funnel, per-step reply rate, where leads currently sit, and the
 *  template copy. Runs of automation steps between them are folded into a single
 *  collapsible connector so the message narrative reads top-to-bottom.
 *  `steps` is one campaign's rows, ordered by step_index. */
export function MessageSequence({ steps }: { steps: CampaignStep[] }) {
  if (steps.length === 0) {
    return (
      <Panel>
        <SectionHeader title="Message sequence" />
        <div className="text-app-text-muted text-app-meta">
          No message steps synced for this campaign yet — they appear after a
          sync from an agent on v1.4.0+ (the per-step data is read straight from
          Linked Helper). A campaign with only invites and no follow-up messages
          will also show nothing here.
        </div>
      </Panel>
    )
  }

  const ordered = [...steps].sort((a, b) => a.step_index - b.step_index)
  const topSent = Math.max(...ordered.map((s) => s.sent_count), 1)

  // Fold consecutive automation steps together, keeping each step's original
  // index so drop-off and depth bars still compare against the true previous step.
  const groups: Group[] = []
  ordered.forEach((step, i) => {
    if (PRIMARY_TYPES.has(step.step_type ?? '')) {
      groups.push({ kind: 'primary', step, i })
    } else {
      const last = groups[groups.length - 1]
      if (last && last.kind === 'auto') last.steps.push({ step, i })
      else groups.push({ kind: 'auto', steps: [{ step, i }] })
    }
  })

  return (
    <Panel>
      <SectionHeader title="Campaign sequence — invite & message funnel" />
      <div className="flex flex-col gap-group">
        {groups.map((g, gi) =>
          g.kind === 'primary' ? (
            <PrimaryStep key={`p${g.i}`} step={g.step} i={g.i} ordered={ordered} topSent={topSent} />
          ) : (
            <AutoGroup key={`a${gi}`} steps={g.steps} />
          ),
        )}
      </div>
      <div className="text-app-text-muted text-app-meta mt-app-md">
        Reply % = of people who received that step, how many replied next
        (replies only attach to invite/message steps; the rest are warm-up).
        “Here now” = leads whose furthest step is this one. Sequence reflects the
        campaign’s latest version; steps removed in a later edit aren’t counted.
      </div>
    </Panel>
  )
}

function PrimaryStep({
  step: s,
  i,
  ordered,
  topSent,
}: {
  step: CampaignStep
  i: number
  ordered: CampaignStep[]
  topSent: number
}) {
  const replyRate = s.sent_count > 0 ? (100 * s.replied_count) / s.sent_count : null
  const dropFromPrev =
    i > 0 && ordered[i - 1].sent_count > 0
      ? 100 - (100 * s.sent_count) / ordered[i - 1].sent_count
      : null
  const small = s.sent_count > 0 && s.sent_count < SMALL_SAMPLE

  return (
    <div className="flex flex-col gap-stack">
      <div className="flex items-center gap-app-sm">
        <span className="inline-flex items-center justify-center rounded-full w-5 h-5 bg-app-accent text-app-on-accent text-app-meta font-bold">{s.step_index + 1}</span>
        <span className="font-semibold">{s.step_label || `Step ${s.step_index + 1}`}</span>
        <span className="text-app-meta text-app-text-muted border border-app-border rounded-pill px-app-sm py-px">{TYPE_LABEL[s.step_type ?? ''] ?? s.step_type}</span>
        {small && (
          <span className="text-app-warning cursor-help" title={`Only ${s.sent_count} sent — reply rate is noisy`}>⚠</span>
        )}
      </div>

      {/* depth bar: how many reached this step vs the first step */}
      <div className="bg-app-surface-2 rounded-sm h-4 overflow-hidden">
        <div
          className="h-full rounded-sm bg-app-accent transition-[width] duration-300"
          style={{ width: `${Math.max((100 * s.sent_count) / topSent, s.sent_count > 0 ? 2 : 0)}%` }}
        />
      </div>

      <div className="flex items-center flex-wrap gap-inline text-app-meta tabular-nums">
        <span><strong>{num(s.sent_count)}</strong> sent</span>
        <span className="text-app-text-muted">→</span>
        <span><strong>{num(s.replied_count)}</strong> replied</span>
        {replyRate != null && (
          <span className="inline-flex items-center gap-app-sm text-app-warning">
            <span className="inline-block w-14 h-[5px] bg-app-surface-2 rounded-[var(--radius-xs)] overflow-hidden">
              <span
                className="block h-full rounded-[var(--radius-xs)]"
                style={{ width: `${Math.min(100, replyRate)}%`, background: SERIES.reply }}
              />
            </span>
            {replyRate.toFixed(1)}%
          </span>
        )}
        <span className="text-app-meta text-app-text-muted">{num(s.current_count)} here now</span>
        {dropFromPrev != null && dropFromPrev > 0 && (
          <span className="text-app-meta text-app-text-muted">−{dropFromPrev.toFixed(0)}% from prev</span>
        )}
      </div>

      {s.template_body && (
        <details className="text-app-meta [&_summary]:text-app-text-muted [&_summary]:cursor-pointer [&_summary]:select-none [&_summary]:w-fit [&_summary:hover]:text-app-text [&_pre]:mt-app-sm [&_pre]:mx-0 [&_pre]:mb-0 [&_pre]:px-app-md [&_pre]:py-app-sm [&_pre]:bg-[var(--code-bg)] [&_pre]:border [&_pre]:border-app-border [&_pre]:rounded-md [&_pre]:whitespace-pre-wrap [&_pre]:[word-break:break-word] [&_pre]:text-app-text [&_pre]:font-[inherit] [&_pre]:text-app-meta">
          <summary>Message template</summary>
          <pre>{s.template_body}</pre>
        </details>
      )}
    </div>
  )
}

/** A folded run of automation steps (waiters/webhooks/visits) — a thin connector
 *  between message steps, expandable to see the individual steps and where leads
 *  currently sit. */
function AutoGroup({ steps }: { steps: Indexed[] }) {
  const [open, setOpen] = useState(false)
  const here = steps.reduce((n, { step }) => n + step.current_count, 0)

  return (
    <div className="ml-app-sm translate-x-px border-l-2 border-dashed border-app-border-strong pt-0.5 pb-0.5 pl-app-lg">
      <Button
        variant="ghost"
        size="sm"
        icon={open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="!min-h-0 !px-app-xs !py-0.5 text-app-meta font-semibold"
      >
        <span className="text-app-text-secondary">
          {steps.length} automation step{steps.length === 1 ? '' : 's'}
        </span>
        {here > 0 && <span className="text-app-text-muted text-app-meta">· {num(here)} here now</span>}
      </Button>
      {open && (
        <div className="flex flex-col gap-stack mt-app-sm">
          {steps.map(({ step }) => (
            <div className="flex items-center gap-app-sm flex-wrap text-app-meta text-app-text-secondary" key={step.step_index}>
              <span className="inline-flex items-center justify-center rounded-full w-[18px] h-[18px] shrink-0 bg-app-surface-2 border border-app-border text-app-text-muted text-app-meta font-semibold">{step.step_index + 1}</span>
              <span className="text-app-text">
                {step.step_label || `Step ${step.step_index + 1}`}
              </span>
              <span className="text-app-meta text-app-text-muted border border-app-border rounded-pill px-app-sm py-px">
                {TYPE_LABEL[step.step_type ?? ''] ?? step.step_type ?? '—'}
              </span>
              {step.current_count > 0 && (
                <span className="text-app-text-muted text-app-meta">{num(step.current_count)} here now</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
