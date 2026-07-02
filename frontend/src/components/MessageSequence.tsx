import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { CampaignStep } from '../lib/types'
import { num } from '../lib/format'

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
      <div className="card">
        <h2>Message sequence</h2>
        <div className="muted small">
          No message steps synced for this campaign yet — they appear after a
          sync from an agent on v1.4.0+ (the per-step data is read straight from
          Linked Helper). A campaign with only invites and no follow-up messages
          will also show nothing here.
        </div>
      </div>
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
    <div className="card">
      <h2>Campaign sequence — invite &amp; message funnel</h2>
      <div className="msgseq">
        {groups.map((g, gi) =>
          g.kind === 'primary' ? (
            <PrimaryStep key={`p${g.i}`} step={g.step} i={g.i} ordered={ordered} topSent={topSent} />
          ) : (
            <AutoGroup key={`a${gi}`} steps={g.steps} />
          ),
        )}
      </div>
      <div className="muted small" style={{ marginTop: 12 }}>
        Reply % = of people who received that step, how many replied next
        (replies only attach to invite/message steps; the rest are warm-up).
        “Here now” = leads whose furthest step is this one. Sequence reflects the
        campaign’s latest version; steps removed in a later edit aren’t counted.
      </div>
    </div>
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
    <div className="msgstep">
      <div className="msgstep-head">
        <span className="msgstep-n">{s.step_index + 1}</span>
        <span className="msgstep-name">{s.step_label || `Step ${s.step_index + 1}`}</span>
        <span className="msgstep-type">{TYPE_LABEL[s.step_type ?? ''] ?? s.step_type}</span>
        {small && (
          <span className="cmp-warn" title={`Only ${s.sent_count} sent — reply rate is noisy`}>⚠</span>
        )}
      </div>

      {/* depth bar: how many reached this step vs the first step */}
      <div className="msgstep-track">
        <div
          className="msgstep-bar"
          style={{ width: `${Math.max((100 * s.sent_count) / topSent, s.sent_count > 0 ? 2 : 0)}%` }}
        />
      </div>

      <div className="msgstep-stats">
        <span><strong>{num(s.sent_count)}</strong> sent</span>
        <span className="msgstep-arrow">→</span>
        <span><strong>{num(s.replied_count)}</strong> replied</span>
        {replyRate != null && (
          <span className="msgstep-rate">
            <span className="cmp-bar" style={{ width: 56 }}>
              <span style={{ width: `${Math.min(100, replyRate)}%`, background: 'var(--warning)' }} />
            </span>
            {replyRate.toFixed(1)}%
          </span>
        )}
        <span className="msgstep-now muted">{num(s.current_count)} here now</span>
        {dropFromPrev != null && dropFromPrev > 0 && (
          <span className="msgstep-drop muted">−{dropFromPrev.toFixed(0)}% from prev</span>
        )}
      </div>

      {s.template_body && (
        <details className="msgstep-tmpl">
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
    <div className="msgseq-auto">
      <button className="msgseq-auto-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="msgseq-auto-count">
          {steps.length} automation step{steps.length === 1 ? '' : 's'}
        </span>
        {here > 0 && <span className="muted small">· {num(here)} here now</span>}
      </button>
      {open && (
        <div className="msgseq-auto-body">
          {steps.map(({ step }) => (
            <div className="msgseq-auto-step" key={step.step_index}>
              <span className="msgseq-auto-n">{step.step_index + 1}</span>
              <span className="msgseq-auto-name">
                {step.step_label || `Step ${step.step_index + 1}`}
              </span>
              <span className="msgstep-type">
                {TYPE_LABEL[step.step_type ?? ''] ?? step.step_type ?? '—'}
              </span>
              {step.current_count > 0 && (
                <span className="muted small">{num(step.current_count)} here now</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
