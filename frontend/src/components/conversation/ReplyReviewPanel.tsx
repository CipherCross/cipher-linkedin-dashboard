import { useEffect, useId, useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronUp, Save } from 'lucide-react'
import { replyTime, REPLY_TIME_ZONE_LABEL } from '../../lib/replyTime'
import {
  INTENT_LEVEL_LABELS, INTENT_STATE_LABELS, REASON_HELP, REASON_LABELS, REPLY_INTENT_LEVELS,
  REPLY_REASON_IDS, SENTIMENT_LABELS, REPLY_SENTIMENTS,
  draftFromReview, needsAutoResetConfirmation, validateReview,
  type ReplyReview, type ReplyReviewDraft, type ReplyReviewSentiment, type ReplyThreadMessage,
  type ReplyReviewHistoryEntry,
} from '../../lib/replyReview'
import { Button, Checkbox, RadioGroup, SelectField, TextareaField } from '../../ui'
import { COPY } from '../../ui/labels'

export interface ReplyReviewPanelProps {
  message: ReplyThreadMessage | null
  review?: ReplyReview | null
  saving?: boolean
  error?: string | null
  onSave: (draft: ReplyReviewDraft, confirmAutoReset?: boolean) => void | Promise<unknown>
  onSaveAndNext?: (draft: ReplyReviewDraft, confirmAutoReset?: boolean) => void | Promise<unknown>
  history?: ReplyReviewHistoryEntry[]
  historyLoading?: boolean
  historyCursor?: string | null
  /** True once the audit has been asked for, so an empty list means empty. */
  historyRequested?: boolean
  /** Called the first time the panel is opened; the audit loads then, not before. */
  onOpenHistory?: () => void
  onLoadHistoryMore?: () => void
  onDirtyChange?: (dirty: boolean) => void
  onDraftChange?: (draft: ReplyReviewDraft) => void
  externalActions?: boolean
}

export function ReplyReviewPanel({ message, review, saving, error, onSave, onSaveAndNext, history = [], historyLoading, historyCursor, historyRequested, onOpenHistory, onLoadHistoryMore, onDirtyChange, onDraftChange, externalActions = false }: ReplyReviewPanelProps) {
  const [draft, setDraft] = useState<ReplyReviewDraft>(() => draftFromReview(review))
  const [confirmAuto, setConfirmAuto] = useState(false)
  const [showReasons, setShowReasons] = useState(false)
  const [showComment, setShowComment] = useState(false)
  const [touched, setTouched] = useState(false)
  const sentimentGroupName = useId()
  useEffect(() => { setDraft(draftFromReview(review)); setConfirmAuto(false); setTouched(false); setShowReasons(Boolean(review?.reason_ids?.length || review?.sentiment === 'negative' || review?.sentiment === 'objection')); setShowComment(Boolean(review?.comment)) }, [message?.id])
  const errors = useMemo(() => touched ? validateReview(draft) : {}, [draft, touched])
  if (!message) return <div className="replies-panel-empty">Select an inbound reply to review.</div>
  if (message.direction !== 'in') return <div className="replies-panel-empty">Only inbound messages can be reviewed.</div>
  const set = (patch: Partial<ReplyReviewDraft>) => {
    setTouched(true)
    onDirtyChange?.(true)
    setDraft((current) => {
      const next = { ...current, ...patch }
      onDraftChange?.(next)
      return next
    })
  }
  const autoNeedsConfirmation = needsAutoResetConfirmation(draft)
  const submit = (moveNext = false) => {
    setTouched(true)
    if (Object.keys(validateReview(draft)).length) return
    if (autoNeedsConfirmation && !confirmAuto) return
    const payload = draft.sentiment === 'auto' && confirmAuto
      ? { ...draft, reason_ids: [], intent_state: 'not_applicable' as const, intent_level: null }
      : draft
    if (moveNext && onSaveAndNext) void onSaveAndNext(payload, confirmAuto)
    else void onSave(payload, confirmAuto)
  }
  return (
    <form id="reply-review-form" className="replies-review-panel" aria-label="Review reply" onSubmit={(event) => { event.preventDefault(); const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLElement | null; submit(submitter?.dataset.next === 'true') }}>
      <div className="replies-panel-heading"><div><h2>Review reply</h2><time className="text-app-text-muted text-app-meta" dateTime={message.sent_at} title={REPLY_TIME_ZONE_LABEL}>{replyTime(message.sent_at, true)}</time></div>{review?.provenance === 'legacy_manual' && <span className="replies-legacy-badge">Reviewed by hand earlier</span>}</div>
      <div className="[display:-webkit-box] mb-app-md py-app-sm px-app-md border-l-[3px] border-app-accent rounded-control bg-app-surface-2 text-app-table overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">{message.body || '—'}</div>
      <RadioGroup
        legend="Sentiment"
        name={sentimentGroupName}
        row
        value={draft.sentiment}
        onChange={(value) => { set({ sentiment: value as ReplyReviewSentiment }); if (value === 'negative' || value === 'objection') setShowReasons(true) }}
        options={REPLY_SENTIMENTS.map((value) => ({ value, label: SENTIMENT_LABELS[value] }))}
        error={errors.sentiment}
      />
      <fieldset className="m-0 p-0 border-0 flex flex-col gap-app-xs mb-app-sm min-w-0">
        <legend className="mb-app-xs text-app-table font-semibold">Reasons {draft.reason_ids.length ? `· ${draft.reason_ids.length}` : ''}</legend>
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowReasons((value) => !value)}>{showReasons ? 'Hide reasons' : 'Add a reason'} {showReasons ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}</Button>
        {showReasons && <div className="flex flex-col">{REPLY_REASON_IDS.map((id) => { const checked = draft.reason_ids.includes(id); return <Checkbox key={id} label={REASON_LABELS[id]} hint={REASON_HELP[id]} checked={checked} onChange={() => set({ reason_ids: checked ? draft.reason_ids.filter((item) => item !== id) : [...draft.reason_ids, id] })} /> })}</div>}
        {draft.reason_ids.includes('do_not_contact') && <p className="py-app-sm px-app-md border border-app-accent-border rounded-control bg-app-accent-subtle text-app-text text-app-meta" role="status">Dashboard reminders will be cancelled. Stop the Linked Helper campaign separately.</p>}
        {errors.reason_ids && <p className="replies-form-error">{errors.reason_ids}</p>}
      </fieldset>
      <details className="replies-optional" open={draft.intent_state !== 'unreviewed' ? true : undefined}>
        <summary>Buying interest · {draft.intent_state === 'level' ? INTENT_LEVEL_LABELS[draft.intent_level ?? 'p1'] : INTENT_STATE_LABELS[draft.intent_state]}</summary>
        <SelectField
          label="Buying interest"
          labelHidden
          value={draft.intent_state === 'level' ? `level:${draft.intent_level ?? ''}` : draft.intent_state}
          onChange={(event) => { const value = event.target.value; if (value.startsWith('level:')) set({ intent_state: 'level', intent_level: value.slice(6) as ReplyReviewDraft['intent_level'] }); else set({ intent_state: value as ReplyReviewDraft['intent_state'], intent_level: null }) }}
        >
          <option value="unreviewed">Not reviewed</option>
          <option value="none">None</option>
          {REPLY_INTENT_LEVELS.map((level) => <option key={level} value={`level:${level}`}>{INTENT_LEVEL_LABELS[level]}</option>)}
          {draft.sentiment === 'auto' && <option value="not_applicable">Not applicable</option>}
        </SelectField>
        {errors.intent_state && <p className="replies-form-error">{errors.intent_state}</p>}
        {errors.intent_level && <p className="replies-form-error">{errors.intent_level}</p>}
      </details>
      <div className="replies-optional">
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowComment((value) => !value)}>{showComment || draft.comment || draft.reason_ids.includes('other') ? 'Comment' : 'Add a comment'} {draft.reason_ids.includes('other') ? '· required for “Other”' : ''}</Button>
        {(showComment || Boolean(draft.comment) || draft.reason_ids.includes('other')) && <TextareaField
          label="Comment"
          labelHidden
          maxLength={1000}
          value={draft.comment}
          onChange={(event) => set({ comment: event.target.value })}
          placeholder="Context for this decision…"
          rows={3}
          error={errors.comment}
        />}
      </div>
      {draft.sentiment === 'auto' && autoNeedsConfirmation && <Checkbox
        label={<><AlertTriangle size={15} aria-hidden="true" /> Confirm clearing the reasons and buying interest that an automated reply cannot carry.</>}
        checked={confirmAuto}
        onChange={(event) => setConfirmAuto(event.target.checked)}
      />}
      {error && <div className="replies-inline-error" role="alert">{error}</div>}
      {!externalActions && <div className="flex gap-app-sm">
        <Button variant="primary" type="submit" icon={<Save aria-hidden="true" />} disabled={saving} loading={saving} loadingLabel={COPY.saving}>{COPY.save}</Button>
        {onSaveAndNext && <Button variant="secondary" type="submit" data-next="true" icon={<Save aria-hidden="true" />} disabled={saving}>{COPY.saveAndNext}</Button>}
      </div>}
      {review?.reviewed_at && <div className="replies-review-meta"><Check size={14} aria-hidden="true" /> Review saved · {replyTime(review.reviewed_at, true)}</div>}
      {/* The panel is always offered and the audit is fetched when it is opened.
          It used to load with every conversation, for a list that stays
          collapsed in the ordinary review pass. The count appears once the
          answer is in — before that the summary carries no number rather than a
          zero it has not checked. */}
      <details className="replies-history" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) onOpenHistory?.() }}>
        <summary>Change history{historyLoading ? ' …' : historyRequested ? ` (${history.length})` : ''}</summary>
        {history.map((entry) => <div className="grid gap-0.5 py-app-sm px-0 border-b border-app-border" key={String(entry.event_id)}><strong>{entry.actor ?? 'Unknown author'}</strong><time title={REPLY_TIME_ZONE_LABEL}>{replyTime(entry.occurred_at, true)}</time><span>{entry.provenance === 'legacy_manual' ? 'Earlier manual review' : 'Manual edit'}</span></div>)}
        {historyRequested && !historyLoading && history.length === 0 && <div className="grid gap-0.5 py-app-sm px-0 border-b border-app-border">No manual edits yet.</div>}
        {historyCursor && <Button variant="ghost" size="sm" className="self-start" onClick={onLoadHistoryMore}>Load more</Button>}
      </details>
    </form>
  )
}
