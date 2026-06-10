import type { CampaignStep } from '../lib/types'

const SMALL_SAMPLE = 30

const TYPE_LABEL: Record<string, string> = {
  InvitePerson: 'Invite',
  MessageToPerson: 'Message',
}

/** The campaign's outbound message sequence: each step's send/reply funnel,
 *  per-step reply rate, where leads currently sit, and the template copy.
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

  return (
    <div className="card">
      <h2>Message sequence — reply rate per step</h2>
      <div className="msgseq">
        {ordered.map((s, i) => {
          const replyRate = s.sent_count > 0 ? (100 * s.replied_count) / s.sent_count : null
          const dropFromPrev =
            i > 0 && ordered[i - 1].sent_count > 0
              ? 100 - (100 * s.sent_count) / ordered[i - 1].sent_count
              : null
          const small = s.sent_count > 0 && s.sent_count < SMALL_SAMPLE
          return (
            <div className="msgstep" key={s.step_index}>
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
                <span><strong>{s.sent_count.toLocaleString('en-US')}</strong> sent</span>
                <span className="msgstep-arrow">→</span>
                <span><strong>{s.replied_count.toLocaleString('en-US')}</strong> replied</span>
                {replyRate != null && (
                  <span className="msgstep-rate">
                    <span className="cmp-bar" style={{ width: 56 }}>
                      <span style={{ width: `${Math.min(100, replyRate)}%`, background: '#f7b94f' }} />
                    </span>
                    {replyRate.toFixed(1)}%
                  </span>
                )}
                <span className="msgstep-now muted">{s.current_count.toLocaleString('en-US')} here now</span>
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
        })}
      </div>
      <div className="muted small" style={{ marginTop: 12 }}>
        Reply % = of people who received that step, how many replied next.
        “Here now” = leads whose furthest step is this one. Sequence reflects the
        campaign’s latest version; steps removed in a later edit aren’t counted.
      </div>
    </div>
  )
}
