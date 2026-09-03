import { Link } from 'react-router-dom'
import { ArrowRight, Plus, Workflow } from 'lucide-react'
import type { SequenceHubItem } from '../../lib/types'
import { activeSequences, draftSequences, sequenceAccounts, sequenceHref } from '../../lib/sequenceHub'
import {
  campaignStatusSummary,
  newestStatusObservation,
  statusHealthCounts,
} from '../../lib/campaignRuntime'
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
        <div className="overview-panel-actions">
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
          {shown.map(({ item, attention }) => {
            const currentDeployments = item.deployments.filter((deployment) => deployment.is_archived === false)
            const excludedArchived = item.deployments.filter((deployment) => deployment.is_archived === true).length
            const excludedUnknownArchive = item.deployments.length - currentDeployments.length - excludedArchived
            const accounts = sequenceAccounts({ ...item, deployments: currentDeployments })
            const statusSummary = campaignStatusSummary(currentDeployments)
            const statusObservedAt = newestStatusObservation(currentDeployments)
            const health = statusHealthCounts(currentDeployments)
            const currentLeads = currentDeployments.reduce((sum, deployment) => sum + deployment.leads, 0)
            const currentReplies = currentDeployments.reduce((sum, deployment) => sum + deployment.replies, 0)
            const currentP3 = currentDeployments.reduce((sum, deployment) => sum + deployment.p3, 0)
            const currentCampaignIds = new Set(currentDeployments.flatMap((deployment) => deployment.campaign_id ? [deployment.campaign_id] : []))
            const currentLatestReply = currentDeployments
              .flatMap((deployment) => deployment.latest_reply ? [deployment.latest_reply] : [])
              .sort((left, right) => right.sent_at.localeCompare(left.sent_at))[0]
              ?? (item.latest_reply && currentCampaignIds.has(item.latest_reply.campaign_id) ? item.latest_reply : null)
            return (
              <li key={item.id} className="active-sequence">
                <div className="active-sequence-main">
                  <Link className="active-sequence-name" to={sequenceHref(item)}>{item.name}</Link>
                  <span className={`badge source-${item.kind}`}>
                    {item.kind === 'managed' ? 'Builder' : 'Linked Helper'}
                  </span>
                  {item.branch_count > 1 && (
                    <span className="badge" title="Copy variants in this sequence">
                      {item.branch_count} branches
                    </span>
                  )}
                  <div className="muted small active-sequence-accounts">
                    {accounts.join(' · ')}
                    {currentDeployments.length > accounts.length
                      ? ` · ${currentDeployments.length} campaigns`
                      : ''}
                  </div>
                </div>

                <dl className="active-sequence-metrics">
                  <div><dt>Leads</dt><dd>{num(currentLeads)}</dd></div>
                  <div><dt>Replies</dt><dd>{num(currentReplies)}</dd></div>
                  <div><dt>P3</dt><dd>{num(currentP3)}</dd></div>
                </dl>

                <div className="active-sequence-state">
                  <span className="active-sequence-runtime">{statusSummary}</span>
                  {attention.level !== 'ok' && (
                    <span className={`badge attention-${attention.level}`}>{attention.label}</span>
                  )}
                  <span className="muted small">
                    {statusObservedAt ? `Newest observation ${ago(statusObservedAt)}` : 'No compatible observation'}
                    {health.stale > 0 ? ` · ${health.stale} stale` : ''}
                    {health.unsupported + health.awaiting_first_sync > 0
                      ? ` · ${health.unsupported + health.awaiting_first_sync} unknown`
                      : ''}
                  </span>
                  {(excludedArchived > 0 || excludedUnknownArchive > 0) && (
                    <span className="muted small">
                      {excludedArchived > 0 ? `${excludedArchived} archived excluded` : ''}
                      {excludedArchived > 0 && excludedUnknownArchive > 0 ? ' · ' : ''}
                      {excludedUnknownArchive > 0 ? `${excludedUnknownArchive} archive unknown excluded` : ''}
                    </span>
                  )}
                  <span className="muted small">
                    {currentLatestReply ? `Last reply ${ago(currentLatestReply.sent_at)}` : 'No replies yet'}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {(ranked.length > shown.length || drafts.length > 0) && (
        <div className="overview-panel-foot muted small">
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
