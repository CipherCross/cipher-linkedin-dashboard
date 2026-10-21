import { useId, useState } from 'react'
import { ChevronDown, ChevronRight, ShieldCheck, ShieldAlert } from 'lucide-react'
import { CRITERION_LABEL, type CriticLoopView } from '../../lib/coachTraining'
import { Badge, Button } from '../../ui'

/** How the critic loop ended, in one line. */
export function loopOutcome(loop: CriticLoopView): string {
  const rounds = loop.rounds?.length ?? 0
  const drafts = rounds === 1 ? 'the first draft' : `draft ${rounds}`
  if (loop.agreed) return `The critic approved ${drafts}.`
  if (loop.stopped === 'critic_error') return `The critic failed on round ${rounds} — showing ${drafts}.`
  if (loop.stopped === 'time') return `Stopped on the time budget after ${rounds} rounds — showing ${drafts}, not approved.`
  return `No agreement after ${rounds} rounds — showing the last draft, not approved.`
}

/**
 * The experimental coach/critic loop behind a run: how it ended, and each
 * round's critique with the coach's replies. Training only.
 */
export function CriticRounds({
  loop,
  onCompareDraft,
  comparing,
}: {
  loop: CriticLoopView
  /** Present when the first draft was revised and stored as its own run. */
  onCompareDraft?: () => void
  comparing: boolean
}) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const rounds = loop.rounds ?? []

  return (
    <section className="flex flex-col gap-stack p-card rounded-card bg-app-surface-2" aria-label="Critic">
      <span className="inline-flex items-center gap-app-sm text-app-table font-semibold">
        {loop.agreed
          ? <ShieldCheck size={16} className="text-app-success" aria-hidden="true" />
          : <ShieldAlert size={16} className="text-app-warning" aria-hidden="true" />}
        Critic loop
        <Badge tone={loop.agreed ? 'success' : 'warning'}>{loop.agreed ? 'Approved' : 'Not approved'}</Badge>
      </span>
      <p className="m-0 text-app-meta text-app-text-secondary">{loopOutcome(loop)}</p>
      <div className="flex items-center gap-inline flex-wrap">
        {onCompareDraft && (
          <Button variant="secondary" size="sm" aria-pressed={comparing} onClick={onCompareDraft}>
            {comparing ? 'Hide first draft' : 'Compare with first draft'}
          </Button>
        )}
        {rounds.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={bodyId}
            icon={open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide rounds' : `Show ${rounds.length} ${rounds.length === 1 ? 'round' : 'rounds'}`}
          </Button>
        )}
      </div>
      {open && (
        <ol id={bodyId} className="list-none m-0 p-0 flex flex-col gap-group" aria-label="Critic rounds">
          {rounds.map((round, i) => (
            <li key={i} className="flex flex-col gap-app-xs">
              <strong className="text-app-table">Round {i + 1}{round.critique?.approve ? ' · approved' : ''}</strong>
              {round.notes_to_reviewer.length > 0 && (
                <div className="text-app-meta text-app-text-secondary">
                  Coach’s replies to the last critique:
                  <ul className="m-0 pl-app-lg">{round.notes_to_reviewer.map((n, j) => <li key={j}>{n}</li>)}</ul>
                </div>
              )}
              {round.error && <p className="m-0 text-app-meta text-app-danger">Critic failed: {round.error}</p>}
              {round.critique && (
                <>
                  <p className="m-0 text-app-table">{round.critique.summary}</p>
                  {round.critique.points.length > 0 && (
                    <ul className="m-0 pl-0 list-none flex flex-col gap-app-xs">
                      {round.critique.points.map((p, j) => (
                        <li key={j} className="flex flex-col gap-app-xs pl-app-sm border-l-2 border-app-border">
                          <span className="inline-flex items-center gap-app-xs flex-wrap">
                            <Badge tone={p.severity === 'blocking' ? 'danger' : 'neutral'}>{p.severity === 'blocking' ? 'Blocking' : 'Minor'}</Badge>
                            <Badge>{CRITERION_LABEL[p.criterion] ?? p.criterion}</Badge>
                            <span className="text-app-meta text-app-text-muted">
                              {p.target === 'take' ? 'The take' : `${p.target === 'idea' ? 'Idea' : 'Feedback'} ${(p.index ?? 0) + 1}`}
                            </span>
                          </span>
                          <span className="text-app-table">{p.problem}</span>
                          <span className="text-app-meta text-app-text-secondary">→ {p.suggestion}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
