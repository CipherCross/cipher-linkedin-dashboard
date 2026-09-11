import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronUp, Save } from 'lucide-react'
import {
  INTENT_LEVEL_LABELS, INTENT_STATE_LABELS, REASON_HELP, REASON_LABELS, REPLY_INTENT_LEVELS,
  REPLY_REASON_IDS, SENTIMENT_LABELS, REPLY_SENTIMENTS,
  draftFromReview, needsAutoResetConfirmation, validateReview,
  type ReplyReview, type ReplyReviewDraft, type ReplyReviewSentiment, type ReplyThreadMessage,
  type ReplyReviewHistoryEntry,
} from '../../lib/replyReview'

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
  onLoadHistoryMore?: () => void
  onDirtyChange?: (dirty: boolean) => void
  onDraftChange?: (draft: ReplyReviewDraft) => void
}

export function ReplyReviewPanel({ message, review, saving, error, onSave, onSaveAndNext, history = [], historyLoading, historyCursor, onLoadHistoryMore, onDirtyChange, onDraftChange }: ReplyReviewPanelProps) {
  const [draft, setDraft] = useState<ReplyReviewDraft>(() => draftFromReview(review))
  const [confirmAuto, setConfirmAuto] = useState(false)
  const [showReasons, setShowReasons] = useState(true)
  const [touched, setTouched] = useState(false)
  useEffect(() => { setDraft(draftFromReview(review)); setConfirmAuto(false); setTouched(false) }, [message?.id, review?.revision])
  const errors = useMemo(() => touched ? validateReview(draft) : {}, [draft, touched])
  if (!message) return <div className="replies-panel-empty">Выберите входящий ответ для разметки.</div>
  if (message.direction !== 'in') return <div className="replies-panel-empty">Размечать можно только входящие сообщения.</div>
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
  const submit = () => {
    setTouched(true)
    if (Object.keys(validateReview(draft)).length) return
    if (autoNeedsConfirmation && !confirmAuto) return
    const payload = draft.sentiment === 'auto' && confirmAuto
      ? { ...draft, reason_ids: [], intent_state: 'not_applicable' as const, intent_level: null }
      : draft
    void onSave(payload, confirmAuto)
  }
  const submitAndNext = () => {
    setTouched(true)
    if (Object.keys(validateReview(draft)).length || (autoNeedsConfirmation && !confirmAuto) || !onSaveAndNext) return
    const payload = draft.sentiment === 'auto' && confirmAuto ? { ...draft, reason_ids: [], intent_state: 'not_applicable' as const, intent_level: null } : draft
    void onSaveAndNext(payload, confirmAuto)
  }
  return (
    <section className="replies-review-panel" aria-label="Ручная разметка ответа">
      <div className="replies-panel-heading"><div><span className="eyebrow">Ответ #{message.id}</span><h2>Разметка</h2></div>{review?.provenance === 'legacy_manual' && <span className="replies-legacy-badge">Legacy manual</span>}</div>
      <div className="replies-selected-message">{message.body || '—'}</div>
      <fieldset className="replies-fieldset"><legend>Sentiment</legend><div className="replies-choice-grid" role="radiogroup" aria-label="Sentiment">
        {REPLY_SENTIMENTS.map((value) => <button key={value} type="button" role="radio" aria-checked={draft.sentiment === value} className={`replies-choice ${draft.sentiment === value ? 'selected' : ''}`} onClick={() => set({ sentiment: value as ReplyReviewSentiment })}>{SENTIMENT_LABELS[value]}</button>)}
      </div>{errors.sentiment && <p className="replies-form-error">{errors.sentiment}</p>}</fieldset>
      <fieldset className="replies-fieldset"><legend>Причины <span className="muted small">Можно несколько · тон и причина независимы</span></legend><button type="button" className="replies-collapse" onClick={() => setShowReasons((value) => !value)}>{showReasons ? 'Скрыть' : 'Показать'} причины {showReasons ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
        {showReasons && <div className="replies-reasons">{REPLY_REASON_IDS.map((id) => { const checked = draft.reason_ids.includes(id); return <label key={id} className="replies-reason"><input type="checkbox" checked={checked} onChange={() => set({ reason_ids: checked ? draft.reason_ids.filter((item) => item !== id) : [...draft.reason_ids, id] })} /><span><strong>{REASON_LABELS[id]}</strong><small>{REASON_HELP[id]}</small></span></label> })}</div>}
        {draft.reason_ids.includes('do_not_contact') && <p className="replies-inline-note" role="status">«Не связываться» сохранится атомарно вместе с этой разметкой и переведёт workflow в завершённый. Снятие причины не снимает уже установленный DNC.</p>}
        {errors.reason_ids && <p className="replies-form-error">{errors.reason_ids}</p>}
      </fieldset>
      <fieldset className="replies-fieldset"><legend>Коммерческий intent <span className="muted small">Отдельная ось, необязательно</span></legend><select value={draft.intent_state} onChange={(event) => { const state = event.target.value as ReplyReviewDraft['intent_state']; set({ intent_state: state, intent_level: state === 'level' ? draft.intent_level : null }) }}><option value="unreviewed">{INTENT_STATE_LABELS.unreviewed}</option><option value="none">{INTENT_STATE_LABELS.none}</option><option value="level">{INTENT_STATE_LABELS.level}</option><option value="not_applicable">{INTENT_STATE_LABELS.not_applicable}</option></select>{draft.intent_state === 'level' && <select value={draft.intent_level ?? ''} onChange={(event) => set({ intent_level: event.target.value as ReplyReviewDraft['intent_level'] })}><option value="">Выберите уровень</option>{REPLY_INTENT_LEVELS.map((level) => <option key={level} value={level}>{INTENT_LEVEL_LABELS[level]}</option>)}</select>}{errors.intent_state && <p className="replies-form-error">{errors.intent_state}</p>}{errors.intent_level && <p className="replies-form-error">{errors.intent_level}</p>}</fieldset>
      <label className="replies-fieldset"><span className="replies-label">Комментарий <span className="muted small">{draft.comment.length}/1000</span></span><textarea maxLength={1000} value={draft.comment} onChange={(event) => set({ comment: event.target.value })} placeholder="Контекст решения, особенно для «Другое»…" rows={3} />{errors.comment && <span className="replies-form-error">{errors.comment}</span>}</label>
      {draft.sentiment === 'auto' && autoNeedsConfirmation && <label className="replies-confirm"><input type="checkbox" checked={confirmAuto} onChange={(event) => setConfirmAuto(event.target.checked)} /><span><AlertTriangle size={15} /> Подтверждаю очистку несовместимых причин и intent для auto.</span></label>}
      {error && <div className="replies-inline-error" role="alert">{error}</div>}
      <button className="primary replies-save" type="button" onClick={submit} disabled={saving}>{saving ? 'Сохраняем…' : <><Save size={16} /> Сохранить разметку</>}</button>
      {onSaveAndNext && <button className="secondary replies-save" type="button" onClick={submitAndNext} disabled={saving}><Save size={16} /> Сохранить и следующий</button>}
      {review?.reviewed_at && <div className="replies-review-meta"><Check size={14} /> Последняя ручная версия · ревизия {review.revision}</div>}
      {review?.reviewed_at && <div className="replies-review-meta">Автор: {review.reviewed_by ?? 'неизвестен'} · {new Date(review.reviewed_at).toLocaleString()}</div>}
      {(history.length > 0 || historyLoading) && <details className="replies-history"><summary>История изменений {historyLoading ? '…' : `(${history.length})`}</summary>{history.map((entry) => <div className="replies-history-entry" key={String(entry.event_id)}><strong>{entry.actor ?? 'Неизвестный автор'}</strong><time>{new Date(entry.occurred_at).toLocaleString()}</time><span>{entry.provenance === 'legacy_manual' ? 'Legacy manual' : 'Ручная правка'} · ревизия события</span></div>)}{historyCursor && <button type="button" className="replies-collapse" onClick={onLoadHistoryMore}>Загрузить ещё</button>}</details>}
    </section>
  )
}
