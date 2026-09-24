import { MessagesSquare } from 'lucide-react'
import {
  Button, Dialog, EmptyState, InlineError, LinkButton, SectionHeader, UpdatingNote,
  businessTimeLabelled,
} from '../../ui'
import { Skeleton } from '../Skeleton'
import { RowOpenButton } from '../RowOpenButton'
import { LeadReplyIdentity } from '../leads-and-replies/LeadReplyIdentity'
import { sequenceMessages, type CampaignPreviewState } from '../../lib/campaignPreview'
import type { CampaignPreview, CampaignPreviewLead, Lead } from '../../lib/types'

/**
 * Read-only campaign preview for the Overview comparison table: the latest five
 * replied leads with their full latest reply, and the copy the campaign sends as
 * synced from Linked Helper. Nothing here edits anything; the full page is one
 * explicit action away, and a lead opens the ordinary Conversation Drawer on top
 * of this dialog (the first Escape closes only the drawer).
 */
export function CampaignPreviewDialog({
  state,
  accountName,
  onClose,
  onRetry,
  onOpenLead,
}: {
  state: Exclude<CampaignPreviewState, { status: 'closed' }>
  accountName: string
  onClose: () => void
  onRetry: () => void
  onOpenLead: (lead: Lead) => void
}) {
  const detailsHref = `/campaign/${encodeURIComponent(state.campaignId)}`
  return (
    <Dialog
      size="xl"
      title={state.campaignName}
      description={accountName}
      onRequestClose={onClose}
      className="campaign-preview"
      footerNote="Read-only preview"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <LinkButton variant="primary" to={detailsHref}>View campaign details</LinkButton>
        </>
      }
    >
      {state.status === 'loading' && <PreviewLoading />}
      {state.status === 'error' && (
        <InlineError
          title="Could not load this campaign preview."
          message="The comparison table is unaffected. Try again, or open the full campaign page."
          detail={state.error}
          onRetry={onRetry}
        />
      )}
      {state.status === 'ready' && <PreviewContent preview={state.preview} onOpenLead={onOpenLead} />}
    </Dialog>
  )
}

function PreviewContent({ preview, onOpenLead }: { preview: CampaignPreview; onOpenLead: (lead: Lead) => void }) {
  const messages = sequenceMessages(preview.steps)
  if (preview.leads.length === 0 && messages.length === 0) {
    return (
      <EmptyState
        icon={MessagesSquare}
        title="No replies or synced messages yet."
        hint="Replies appear once leads answer; sequence copy appears after the next sync from Linked Helper."
      />
    )
  }
  return (
    <div className="campaign-preview__grid">
      <section aria-labelledby="campaign-preview-replies">
        <SectionHeader
          level="subsection"
          id="campaign-preview-replies"
          title="Recent replies"
          actions={preview.leads.length > 0 && (
            <span className="campaign-preview__count">
              {preview.leads.length === 5 ? 'Latest 5' : `${preview.leads.length} ${preview.leads.length === 1 ? 'reply' : 'replies'}`}
            </span>
          )}
        />
        {preview.leads.length === 0
          ? <p className="campaign-preview__empty">No replied leads yet.</p>
          : (
            <ul className="campaign-preview__replies">
              {preview.leads.map((item) => (
                <ReplyRow key={`${item.lead.instance_id}|${item.lead.profile_url}`} item={item} onOpen={() => onOpenLead(item.lead)} />
              ))}
            </ul>
          )}
      </section>

      <section aria-labelledby="campaign-preview-sequence">
        <SectionHeader
          level="subsection"
          id="campaign-preview-sequence"
          title="Sequence messages"
          actions={messages.length > 0 && <span className="campaign-preview__count">Synced from Linked Helper</span>}
        />
        {messages.length === 0
          ? <p className="campaign-preview__empty">No synced sequence messages available.</p>
          : (
            <ol className="campaign-preview__sequence">
              {messages.map((message) => (
                <li key={message.key}>
                  <span className="campaign-preview__step">{message.label}</span>
                  <p className="campaign-preview__copy">{message.body}</p>
                </li>
              ))}
            </ol>
          )}
      </section>
    </div>
  )
}

/** The whole row opens the conversation; the profile link inside it stays a link. */
function ReplyRow({ item, onOpen }: { item: CampaignPreviewLead; onOpen: () => void }) {
  const name = item.lead.full_name || item.lead.profile_url
  return (
    <li
      className="campaign-preview__reply"
      onClick={(event) => {
        // Focus the row's own button first, so closing the drawer returns here.
        event.currentTarget.querySelector<HTMLButtonElement>('[data-row-open]')?.focus({ preventScroll: true })
        onOpen()
      }}
    >
      <RowOpenButton label={`Open conversation with ${name}`} onOpen={onOpen} />
      <div className="campaign-preview__reply-head">
        <LeadReplyIdentity lead={item.lead} reply={item.reply} highestIntent={item.highestIntent} showSnippet={false} />
        <time className="campaign-preview__time" dateTime={item.reply.sent_at}>
          {businessTimeLabelled(item.reply.sent_at)}
        </time>
      </div>
      <p className="campaign-preview__body">{item.reply.body}</p>
    </li>
  )
}

function PreviewLoading() {
  return (
    <div className="campaign-preview__grid" aria-busy="true">
      <div>
        <UpdatingNote>Loading preview…</UpdatingNote>
        <div className="campaign-preview__skeleton">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex flex-col gap-app-sm">
              <Skeleton width="45%" height={16} />
              <Skeleton width="100%" height={40} />
            </div>
          ))}
        </div>
      </div>
      <div className="campaign-preview__skeleton">
        {[0, 1].map((row) => <Skeleton key={row} width="100%" height={72} />)}
      </div>
    </div>
  )
}
