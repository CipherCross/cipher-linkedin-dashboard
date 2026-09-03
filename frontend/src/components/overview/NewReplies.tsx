import { Link } from 'react-router-dom'
import { ArrowRight, Inbox } from 'lucide-react'
import type { Lead, SequenceHubReplyPreview } from '../../lib/types'
import { INTENT_META, SENTIMENT_META } from '../../lib/leads'
import { ago } from '../../lib/format'
import { EmptyState } from '../EmptyState'

/** One screenful. The snapshot already caps the query at twelve. */
const VISIBLE = 6

function leadLabel(reply: SequenceHubReplyPreview): string {
  return reply.lead_name
    || reply.profile_url.replace('https://www.linkedin.com/in/', '').replace(/\/$/, '')
}

/**
 * The newest inbound replies that still need somebody.
 *
 * "New" is the durable state the database already has — the thread's last
 * message came in, or it carries an open follow-up — because there is no
 * per-user read receipt to build on and inventing one would be a lie about
 * what the dashboard knows.
 *
 * The row opens the shared conversation drawer when the lead is in the loaded
 * snapshot, and otherwise falls back to its campaign: the preview carries only
 * a snippet, and a full thread is still fetched on demand.
 */
export function NewReplies({
  replies,
  loading,
  error,
  resolveLead,
  onOpen,
}: {
  replies: SequenceHubReplyPreview[]
  loading: boolean
  error: string | null
  resolveLead: (reply: SequenceHubReplyPreview) => Lead | null
  onOpen: (lead: Lead) => void
}) {
  const shown = replies.slice(0, VISIBLE)

  return (
    <section className="card overview-panel new-replies" aria-labelledby="new-replies-title">
      <div className="overview-panel-head">
        <h2 id="new-replies-title">New replies</h2>
        <Link className="link-btn" to="/leads?stage=replied">
          All replies <ArrowRight size={14} />
        </Link>
      </div>

      {error ? (
        <div className="muted small">Replies could not load. {error}</div>
      ) : loading && replies.length === 0 ? (
        <div className="muted small">Loading replies…</div>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No replies waiting"
          hint="Inbound replies and threads with an open follow-up show up here after the next sync."
        />
      ) : (
        <ul className="new-reply-list">
          {shown.map((reply) => {
            const lead = resolveLead(reply)
            const name = leadLabel(reply)
            const sentiment = reply.sentiment ? SENTIMENT_META[reply.sentiment] : null
            const intent = reply.intent_level ? INTENT_META[reply.intent_level] : null
            // Spans, not divs: half of these rows are <button>, whose content
            // model is phrasing content. `.new-reply-open > span` blocks them out.
            const body = (
              <>
                <span className="new-reply-top">
                  <span className="new-reply-name">{name}</span>
                  {sentiment && <span className={`badge senti ${sentiment.cls}`}>{sentiment.label}</span>}
                  {intent && (
                    <span className={`badge senti ${intent.cls}`}>{intent.short} · {intent.label}</span>
                  )}
                  <span className="muted small new-reply-when">{ago(reply.sent_at)}</span>
                </span>
                {reply.company && <span className="muted small">{reply.company}</span>}
                {reply.body && <span className="reply-body">“{reply.body}”</span>}
                <span className="muted small new-reply-attribution">
                  {reply.account_name ?? reply.instance_id} · {reply.sequence_name}
                </span>
              </>
            )

            return (
              <li key={`${reply.instance_id}|${reply.profile_url}`} className="new-reply">
                {lead ? (
                  <button
                    type="button"
                    className="new-reply-open"
                    aria-label={`Open conversation with ${name}`}
                    onClick={() => onOpen(lead)}
                  >
                    {body}
                  </button>
                ) : (
                  <Link
                    className="new-reply-open new-reply-open--nav"
                    aria-label={`Open ${name} in ${reply.sequence_name}`}
                    to={`/campaign/${encodeURIComponent(reply.campaign_id)}?people=replied`}
                  >
                    {body}
                    <span className="new-reply-nav-hint">
                      <ArrowRight size={12} />
                    </span>
                  </Link>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
