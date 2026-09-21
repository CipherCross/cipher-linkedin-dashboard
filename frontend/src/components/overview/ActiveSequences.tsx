import { Link } from 'react-router-dom'
import { ArrowRight, Plus, Workflow } from 'lucide-react'
import type { SequenceHubItem } from '../../lib/types'
import { activeSequences, draftSequences, sequenceAccounts, sequenceHref } from '../../lib/sequenceHub'
import { ago, num } from '../../lib/format'
import { EmptyState } from '../EmptyState'

/** Enough to see what is running without turning the first viewport into a list. */
const VISIBLE = 6

/**
 * What is running, where, and what is wrong with it.
 *
 * Every number here comes off the `sequences.hub` aggregate — no lead or message
 * rows are read to draw this, which is what keeps the Overview's first paint
 * cheap now that it leads with sequences rather than with account cards.
 */
export function ActiveSequences({
  items,
  loading,
  error,
  onCreate,
  creating = false,
}: {
  items: SequenceHubItem[]
  loading: boolean
  error: string | null
  onCreate?: () => void
  creating?: boolean
}) {
  const ranked = activeSequences(items)
  const drafts = draftSequences(items)
  const shown = ranked.slice(0, VISIBLE)

  return (
    <section className="card overview-panel active-sequences" aria-labelledby="active-sequences-title">
      <div className="overview-panel-head">
        <h2 id="active-sequences-title">Active sequences</h2>
        <div className="flex items-center gap-app-sm flex-wrap">
          {onCreate && (
            <button type="button" className="btn primary" onClick={onCreate} disabled={creating}>
              <Plus size={15} /> {creating ? 'Creating…' : 'New sequence'}
            </button>
          )}
          <Link className="link-btn" to="/sequences">
            Sequence Hub <ArrowRight size={14} />
          </Link>
        </div>
      </div>

      {error ? (
        <div className="muted small">Sequences could not load. {error}</div>
      ) : loading && items.length === 0 ? (
        <div className="muted small">Loading sequences…</div>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="Nothing is deployed yet"
          hint="Publish a sequence to a notebook, or sync an account that already runs campaigns in Linked Helper."
          action={<Link className="link-btn" to="/sequences">Open Sequence Hub</Link>}
        />
      ) : (
        <ul className="active-sequence-list">
          {shown.map(({ item }) => {
            const currentDeployments = item.deployments.filter((deployment) => deployment.is_archived === false)
            const accounts = sequenceAccounts({ ...item, deployments: currentDeployments })
            const currentLeads = currentDeployments.reduce((sum, deployment) => sum + deployment.leads, 0)
            const currentReplies = currentDeployments.reduce((sum, deployment) => sum + deployment.replies, 0)
            const currentP3 = currentDeployments.reduce((sum, deployment) => sum + deployment.p3, 0)
            const currentCampaignIds = new Set(currentDeployments.flatMap((deployment) => deployment.campaign_id ? [deployment.campaign_id] : []))
            const currentLatestReply = currentDeployments
              .flatMap((deployment) => deployment.latest_reply ? [deployment.latest_reply] : [])
              .sort((left, right) => right.sent_at.localeCompare(left.sent_at))[0]
              ?? (item.latest_reply && currentCampaignIds.has(item.latest_reply.campaign_id) ? item.latest_reply : null)
            return (
              <li key={item.id} className="flex flex-col gap-1.5 py-2.5 border-b border-app-border last:border-b-0">
                <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
                  <Link className="font-semibold text-app-text no-underline hover:text-app-accent" to={sequenceHref(item)}>{item.name}</Link>
                  <span className={`badge source-${item.kind}`}>
                    {item.kind === 'managed' ? 'Builder' : 'Linked Helper'}
                  </span>
                  {item.branch_count > 1 && (
                    <span className="badge" title="Copy variants in this sequence">
                      {item.branch_count} branches
                    </span>
                  )}
                  <span className="muted small overflow-hidden text-ellipsis whitespace-nowrap">
                    {accounts.join(' · ')}
                    {currentDeployments.length > accounts.length
                      ? ` · ${currentDeployments.length} campaigns`
                      : ''}
                  </span>
                </div>

                <div className="flex items-start justify-between gap-app-md flex-wrap max-[700px]:flex-col">
                  <dl className="flex gap-[14px] m-0 shrink-0 [&_dt]:text-[length:var(--text-2xs)] [&_dt]:uppercase [&_dt]:tracking-[.04em] [&_dt]:text-app-text-muted [&_dd]:m-0 [&_dd]:tabular-nums [&_dd]:font-semibold">
                    <div><dt>Leads</dt><dd>{num(currentLeads)}</dd></div>
                    <div><dt>Replies</dt><dd>{num(currentReplies)}</dd></div>
                    <div><dt>P3</dt><dd>{num(currentP3)}</dd></div>
                  </dl>

                  <div className="flex flex-col items-end gap-[3px] text-right min-w-0 max-[700px]:items-start max-[700px]:text-left">
                    <span className="muted small">
                      {currentLatestReply ? `Last reply ${ago(currentLatestReply.sent_at)}` : 'No replies yet'}
                    </span>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {(ranked.length > shown.length || drafts.length > 0) && (
        <div className="border-t border-app-border pt-[9px] muted small">
          {ranked.length > shown.length && (
            <Link className="row-link" to="/sequences">
              {ranked.length - shown.length} more deployed
            </Link>
          )}
          {ranked.length > shown.length && drafts.length > 0 && (
            <span className="overview-panel-foot-sep"> &middot; </span>
          )}
          {drafts.length > 0 && (
            <Link className="row-link" to={sequenceHref(drafts[0])}>
              Continue "{drafts[0].name}"
            </Link>
          )}
          {drafts.length > 1 && (
            <span> &middot; {drafts.length - 1} other draft{drafts.length > 2 ? 's' : ''}</span>
          )}
        </div>
      )}
    </section>
  )
}
