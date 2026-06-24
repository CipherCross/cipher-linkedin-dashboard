import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { CampaignMetrics, Instance, Lead } from '../lib/types'
import type { DateRange, ReplyInfo } from '../lib/leads'
import { leadKey, tsInRange } from '../lib/leads'
import { ReplyRow } from './ReplyRow'

const MAX = 50

/** Collapsible "all replies in range" panel for the Overview, collapsed by
 *  default. Mirrors the Replies page list but scoped to the dashboard's date
 *  range; the full operational view (sentiment filters, classify, coaching)
 *  still lives at /replies. */
export function RepliesPanel({
  leads,
  latest,
  range,
  campaigns,
  instances,
}: {
  leads: Lead[]
  latest: Map<string, ReplyInfo>
  range: DateRange
  campaigns: CampaignMetrics[]
  instances: Instance[]
}) {
  const [open, setOpen] = useState(false)
  const replies = useMemo(
    () =>
      leads
        .filter((l) => tsInRange(l.replied_at, range))
        .sort((a, b) => (b.replied_at ?? '').localeCompare(a.replied_at ?? '')),
    [leads, range],
  )

  return (
    <div className="card reply-panel">
      <button className="coach-digest-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="coach-digest-caret">{open ? '▾' : '▸'}</span>
        Lead replies
        <span className="muted small">
          — {replies.length} in {range.label.toLowerCase()}, newest first
        </span>
      </button>
      {open && (
        <div className="reply-panel-body">
          {replies.length === 0 ? (
            <div className="muted small">No replies in this period.</div>
          ) : (
            <>
              <div className="reply-list">
                {replies.slice(0, MAX).map((l) => (
                  <ReplyRow
                    key={l.id}
                    lead={l}
                    reply={latest.get(leadKey(l.instance_id, l.profile_url))}
                    campaigns={campaigns}
                    instances={instances}
                  />
                ))}
              </div>
              {replies.length > MAX && (
                <Link className="row-link muted small reply-panel-more" to="/replies">
                  +{replies.length - MAX} more — view all on the Replies page →
                </Link>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
