import { useEffect, useState } from 'react'
import { MessageSquarePlus, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { FeedbackTarget, TrainingFeedback, TrainingRun, Verdict } from '../../lib/coachTraining'
import { Button, IconButton, InlineError, Textarea, TextareaField, relativeTime } from '../../ui'
import { CoachOutput } from '../conversation/CoachOutput'

export interface FeedbackChange {
  target: FeedbackTarget
  targetIndex: number | null
  verdict: Verdict | null
  comment: string | null
}

/** Mark one idea or one piece of feedback good or bad, and comment on it. */
function Marks({
  label,
  current,
  locked,
  onChange,
}: {
  label: string
  current: TrainingFeedback | undefined
  locked: boolean
  onChange: (verdict: Verdict | null, comment: string | null) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(current?.comment ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(() => { setDraft(current?.comment ?? '') }, [current?.comment])
  const verdict = current?.verdict ?? null
  const comment = current?.comment ?? null

  const save = async (nextVerdict: Verdict | null, nextComment: string | null) => {
    setSaving(true)
    try { await onChange(nextVerdict, nextComment) } finally { setSaving(false) }
  }

  return (
    <div className="flex flex-col gap-app-xs w-full">
      <div className="flex items-center gap-app-xs">
        <IconButton
          label={`${label}: good`}
          aria-pressed={verdict === 'good'}
          className={verdict === 'good' ? 'text-app-success' : ''}
          icon={<ThumbsUp aria-hidden="true" />}
          disabled={locked || saving}
          onClick={() => void save(verdict === 'good' ? null : 'good', comment)}
        />
        <IconButton
          label={`${label}: bad`}
          aria-pressed={verdict === 'bad'}
          className={verdict === 'bad' ? 'text-app-danger' : ''}
          icon={<ThumbsDown aria-hidden="true" />}
          disabled={locked || saving}
          onClick={() => void save(verdict === 'bad' ? null : 'bad', comment)}
        />
        {!editing && !comment && !locked && (
          <Button variant="ghost" size="sm" icon={<MessageSquarePlus aria-hidden="true" />} onClick={() => setEditing(true)}>
            Comment
          </Button>
        )}
        {locked && current && <span className="text-app-meta text-app-text-muted">Used to improve the prompt</span>}
      </div>
      {comment && !editing && (
        <p className="m-0 text-app-meta text-app-text-secondary pl-app-sm border-l-2 border-app-accent whitespace-pre-wrap">
          {comment}
          {!locked && (
            <>
              {' '}
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button>
            </>
          )}
        </p>
      )}
      {editing && (
        <div className="flex flex-col gap-app-xs">
          <Textarea
            aria-label={`Comment on ${label.toLowerCase()}`}
            rows={2}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); setDraft(comment ?? '') }
            }}
          />
          <span className="flex gap-app-xs">
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              onClick={async () => { await save(verdict, draft.trim() || null); setEditing(false) }}
            >
              Save comment
            </Button>
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => { setEditing(false); setDraft(comment ?? '') }}>Cancel</Button>
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * One run's output with the team's marks: ideas and feedback items each take
 * a good/bad mark and a comment, the take as a whole takes a comment. Marks on
 * a run an improve round already used are history and read-only.
 */
export function RunReview({
  run,
  feedback,
  onFeedback,
}: {
  run: TrainingRun
  feedback: TrainingFeedback[]
  onFeedback: (change: FeedbackChange) => Promise<void>
}) {
  const mine = feedback.filter((f) => f.run_id === run.id)
  const find = (target: FeedbackTarget, index: number | null) =>
    mine.find((f) => f.target === target && f.target_index === index)
  const lockedFor = (f: TrainingFeedback | undefined) => !!f?.consumed_by_version_id
  const take = find('take', null)
  const [takeDraft, setTakeDraft] = useState(take?.comment ?? '')
  const [savingTake, setSavingTake] = useState(false)
  useEffect(() => { setTakeDraft(take?.comment ?? '') }, [take?.comment, run.id])
  const when = relativeTime(run.created_at)

  if (!run.output) {
    return <InlineError title={`The run on v${run.version_n} failed.`} message={run.error ?? 'No output.'} />
  }

  return (
    <div className="flex flex-col gap-group">
      <p className="m-0 text-app-meta text-app-text-muted" title={when.title}>
        Prompt v{run.version_n} · {when.label}
        {run.cut_after_message_id ? ' · as of the cut' : ''}
        {run.stale ? ' · the thread changed since — run again to refresh' : ''}
      </p>
      <CoachOutput
        output={run.output}
        resetKey={run.id}
        ideaSlot={(index) => (
          <Marks
            label={`Idea ${index + 1}`}
            current={find('idea', index)}
            locked={lockedFor(find('idea', index))}
            onChange={(verdict, comment) => onFeedback({ target: 'idea', targetIndex: index, verdict, comment })}
          />
        )}
        issueSlot={(index) => (
          <Marks
            label={`Feedback ${index + 1}`}
            current={find('issue', index)}
            locked={lockedFor(find('issue', index))}
            onChange={(verdict, comment) => onFeedback({ target: 'issue', targetIndex: index, verdict, comment })}
          />
        )}
      />
      <form
        className="flex flex-col gap-stack"
        onSubmit={async (e) => {
          e.preventDefault()
          setSavingTake(true)
          try {
            await onFeedback({ target: 'take', targetIndex: null, verdict: take?.verdict ?? null, comment: takeDraft.trim() || null })
          } finally {
            setSavingTake(false)
          }
        }}
      >
        <TextareaField
          label="Comment on this take as a whole"
          rows={3}
          value={takeDraft}
          disabled={lockedFor(take)}
          placeholder="e.g. It should have answered the price question before proposing a call."
          help={lockedFor(take) ? 'Used to improve the prompt.' : undefined}
          onChange={(e) => setTakeDraft(e.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          className="self-start"
          loading={savingTake}
          disabled={lockedFor(take) || takeDraft.trim() === (take?.comment ?? '')}
        >
          Save comment
        </Button>
      </form>
    </div>
  )
}
