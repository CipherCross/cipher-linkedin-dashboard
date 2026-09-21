import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronUp, Save } from 'lucide-react'
import { replyTime, REPLY_TIME_ZONE_LABEL } from '../../lib/replyTime'
import {
  INTENT_LEVEL_LABELS, INTENT_STATE_LABELS, REASON_HELP, REASON_LABELS, REPLY_INTENT_LEVELS,
  REPLY_REASON_IDS, SENTIMENT_LABELS, REPLY_SENTIMENTS,
  draftFromReview, needsAutoResetConfirmation, validateReview,
  type ReplyReview, type ReplyReviewDraft, type ReplyReviewSentiment, type ReplyThreadMessage,
  type ReplyReviewHistoryEntry,
} from '../../lib/replyReview'
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
      <div className="replies-panel-heading"><div><h2>Review reply</h2><time className="muted small" dateTime={message.sent_at} title={REPLY_TIME_ZONE_LABEL}>{replyTime(message.sent_at, true)}</time></div>{review?.provenance === 'legacy_manual' && <span className="replies-legacy-badge">Reviewed by hand earlier</span>}</div>
      <div className="[display:-webkit-box] mb-app-lg p-app-md border-l-[3px] border-app-accent rounded-control bg-app-surface-2 text-app-table overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">{message.body || '—'}</div>
      <fieldset className="replies-fieldset"><legend>Sentiment</legend><div className="grid gap-app-sm grid-cols-2" role="radiogroup" aria-label="Sentiment">
        {REPLY_SENTIMENTS.map((value) => <button key={value} type="button" role="radio" aria-checked={draft.sentiment === value} className={`replies-choice ${draft.sentiment === value ? 'selected' : ''}`} onClick={() => { set({ sentiment: value as ReplyReviewSentiment }); if (value === 'negative' || value === 'objection') setShowReasons(true) }}>{SENTIMENT_LABELS[value]}</button>)}
      </div>{errors.sentiment && <p className="replies-form-error">{errors.sentiment}</p>}</fieldset>
      <fieldset className="replies-fieldset"><legend>Reasons {draft.reason_ids.length ? `· ${draft.reason_ids.length}` : ''}</legend><button type="button" className="flex items-center gap-app-xs self-start min-h-control-sm p-0 border-0 bg-transparent font-[inherit] text-app-table font-semibold cursor-pointer text-app-accent" onClick={() => setShowReasons((value) => !value)}>{showReasons ? 'Hide reasons' : 'Add a reason'} {showReasons ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
        {showReasons && <div className="flex flex-col">{REPLY_REASON_IDS.map((id) => { const checked = draft.reason_ids.includes(id); return <label key={id} className="replies-reason" title={REASON_HELP[id]}><input type="checkbox" checked={checked} onChange={() => set({ reason_ids: checked ? draft.reason_ids.filter((item) => item !== id) : [...draft.reason_ids, id] })} /><span><strong>{REASON_LABELS[id]}</strong></span></label> })}</div>}
        {draft.reason_ids.includes('do_not_contact') && <p className="p-app-md border border-app-accent-border rounded-control bg-app-accent-subtle text-app-text text-app-meta" role="status">Dashboard reminders will be cancelled. Stop the Linked Helper campaign separately.</p>}
        {errors.reason_ids && <p className="replies-form-error">{errors.reason_ids}</p>}
      </fieldset>
      <details className="replies-optional" open={draft.intent_state !== 'unreviewed' ? true : undefined}><summary>Buying interest · {draft.intent_state === 'level' ? INTENT_LEVEL_LABELS[draft.intent_level ?? 'p1'] : INTENT_STATE_LABELS[draft.intent_state]}</summary><label className="replies-fieldset"><span className="sr-only">Buying interest</span><select value={draft.intent_state === 'level' ? `level:${draft.intent_level ?? ''}` : draft.intent_state} onChange={(event) => { const value = event.target.value; if (value.startsWith('level:')) set({ intent_state: 'level', intent_level: value.slice(6) as ReplyReviewDraft['intent_level'] }); else set({ intent_state: value as ReplyReviewDraft['intent_state'], intent_level: null }) }}><option value="unreviewed">Not reviewed</option><option value="none">None</option>{REPLY_INTENT_LEVELS.map((level) => <option key={level} value={`level:${level}`}>{INTENT_LEVEL_LABELS[level]}</option>)}{draft.sentiment === 'auto' && <option value="not_applicable">Not applicable</option>}</select></label>{errors.intent_state && <p className="replies-form-error">{errors.intent_state}</p>}{errors.intent_level && <p className="replies-form-error">{errors.intent_level}</p>}</details>
      <div className="replies-optional"><button type="button" className="flex items-center gap-app-xs self-start min-h-control-sm p-0 border-0 bg-transparent font-[inherit] text-app-table font-semibold cursor-pointer text-app-accent" onClick={() => setShowComment((value) => !value)}>{showComment || draft.comment || draft.reason_ids.includes('other') ? 'Comment' : 'Add a comment'} {draft.reason_ids.includes('other') ? '· required for “Other”' : ''}</button>{(showComment || Boolean(draft.comment) || draft.reason_ids.includes('other')) && <label className="replies-fieldset"><span className="sr-only">Comment</span><textarea maxLength={1000} value={draft.comment} onChange={(event) => set({ comment: event.target.value })} placeholder="Context for this decision…" rows={3} />{errors.comment && <span className="replies-form-error">{errors.comment}</span>}</label>}</div>
      {draft.sentiment === 'auto' && autoNeedsConfirmation && <label className="replies-confirm"><input type="checkbox" checked={confirmAuto} onChange={(event) => setConfirmAuto(event.target.checked)} /><span><AlertTriangle size={15} /> Confirm clearing the reasons and buying interest that an automated reply cannot carry.</span></label>}
      {error && <div className="replies-inline-error" role="alert">{error}</div>}
      {!externalActions && <><button className="btn accent" type="submit" disabled={saving}>{saving ? COPY.saving : <><Save size={16} /> {COPY.save}</>}</button>{onSaveAndNext && <button className="btn" type="submit" data-next="true" disabled={saving}><Save size={16} /> {COPY.saveAndNext}</button>}</>}
      {review?.reviewed_at && <div className="replies-review-meta"><Check size={14} /> Review saved · {replyTime(review.reviewed_at, true)}</div>}
      {/* The panel is always offered and the audit is fetched when it is opened.
          It used to load with every conversation, for a list that stays
          collapsed in the ordinary review pass. The count appears once the
          answer is in — before that the summary carries no number rather than a
          zero it has not checked. */}
      <details className="replies-history" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) onOpenHistory?.() }}><summary>Change history{historyLoading ? ' …' : historyRequested ? ` (${history.length})` : ''}</summary>{history.map((entry) => <div className="grid gap-0.5 py-app-sm px-0 border-b border-app-border" key={String(entry.event_id)}><strong>{entry.actor ?? 'Unknown author'}</strong><time title={REPLY_TIME_ZONE_LABEL}>{replyTime(entry.occurred_at, true)}</time><span>{entry.provenance === 'legacy_manual' ? 'Earlier manual review' : 'Manual edit'}</span></div>)}{historyRequested && !historyLoading && history.length === 0 && <div className="grid gap-0.5 py-app-sm px-0 border-b border-app-border">No manual edits yet.</div>}{historyCursor && <button type="button" className="flex items-center gap-app-xs self-start min-h-control-sm p-0 border-0 bg-transparent font-[inherit] text-app-table font-semibold cursor-pointer text-app-accent" onClick={onLoadHistoryMore}>Load more</button>}</details>
    </form>
  )
}
