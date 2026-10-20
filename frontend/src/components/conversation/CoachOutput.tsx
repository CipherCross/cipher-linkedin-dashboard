import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ISSUE_KIND_LABEL, NEXT_ACTION_META, SEVERITY_TONE } from '../../lib/leads'
import type { CoachingIdea, CoachingIssue, NextAction } from '../../lib/types'
import { Badge, SegmentedControl } from '../../ui'
import { CopyButton } from '../CopyButton'

type CoachView = 'ideas' | 'feedback'

export interface CoachOutputData {
  next_action: NextAction
  summary: string | null
  issues: CoachingIssue[]
  ideas: CoachingIdea[]
  scope?: { hand_written: number; sequence: number } | null
}

/**
 * One coach take: the next move and summary, then ideas and feedback one tab
 * apart. Shared by the conversation workspace's coach panel and the Coach
 * training page, which fills the slots with its marking controls — the slots
 * sit beside the content, never inside it.
 */
export function CoachOutput({
  output,
  ideaSlot,
  issueSlot,
  resetKey,
}: {
  output: CoachOutputData
  /** Controls for one idea (training marks), rendered under it. */
  ideaSlot?: (index: number) => ReactNode
  issueSlot?: (index: number) => ReactNode
  /** Changing it returns the view to Ideas (a new take). */
  resetKey?: string | number
}) {
  const [view, setView] = useState<CoachView>('ideas')
  useEffect(() => { setView('ideas') }, [resetKey])
  const action = NEXT_ACTION_META[output.next_action]

  return (
    <div className="flex flex-col gap-group">
      <section className="flex flex-col gap-stack p-card rounded-card bg-app-surface-2" aria-label="Summary">
        {action && (
          <span className="inline-flex items-center gap-app-sm">
            <span className="text-app-meta text-app-text-muted">Next move</span>
            <Badge tone={action.tone}>{action.label}</Badge>
          </span>
        )}
        {output.summary && <p className="m-0 text-app-table">{output.summary}</p>}
        {output.scope && <p className="m-0 text-app-meta text-app-text-muted">{scopeLine(output.scope)}</p>}
      </section>

      <SegmentedControl
        label="Coach view"
        value={view}
        onChange={setView}
        items={[
          { id: 'ideas', label: 'Ideas', count: output.ideas.length },
          { id: 'feedback', label: 'Feedback', count: output.issues.length },
        ]}
      />

      {view === 'ideas' && (
        output.ideas.length === 0
          ? <p className="m-0 text-app-meta text-app-text-muted">No ideas this time — Regenerate to try again.</p>
          : (
            <ol className="list-none m-0 p-0 flex flex-col gap-stack" aria-label="Message ideas">
              {output.ideas.map((idea, index) => (
                <li key={index} className="conversation-idea">
                  <div className="flex items-center gap-app-sm">
                    <span className="conversation-idea__index" aria-hidden="true">{index + 1}</span>
                    <span className="text-app-meta font-semibold text-app-text-secondary truncate">{idea.angle || 'Option'}</span>
                    <CopyButton className="ml-auto" text={idea.message} title={`Copy idea ${index + 1}`} />
                  </div>
                  <p className="m-0 text-app-table whitespace-pre-wrap [overflow-wrap:anywhere]">{idea.message}</p>
                  {idea.why && <p className="m-0 text-app-meta text-app-text-muted">{idea.why}</p>}
                  {ideaSlot?.(index)}
                </li>
              ))}
            </ol>
          )
      )}

      {view === 'feedback' && (
        output.issues.length === 0
          ? (
            <p className="m-0 text-app-meta text-app-text-muted">
              {output.scope?.hand_written === 0
                ? 'Nothing to review yet — every message sent here came from the sequence.'
                : 'Nothing to fix in the hand-written messages.'}
            </p>
          )
          : (
            <ul className="list-none m-0 p-0 flex flex-col gap-group" aria-label="Feedback on your messages">
              {output.issues.map((issue, index) => (
                <li key={index} className="flex flex-col items-start gap-app-xs pl-app-sm border-l-2 border-app-border">
                  <Badge tone={SEVERITY_TONE[issue.severity]}>{ISSUE_KIND_LABEL[issue.kind]}</Badge>
                  {issue.quote && <q className="text-app-table italic text-app-text-muted [overflow-wrap:anywhere]">{issue.quote}</q>}
                  <p className="m-0 text-app-table">{issue.fix}</p>
                  {issueSlot?.(index)}
                </li>
              ))}
            </ul>
          )
      )}
    </div>
  )
}

export function scopeLine(scope: { hand_written: number; sequence: number }): string {
  const own = `${scope.hand_written} hand-written ${scope.hand_written === 1 ? 'message' : 'messages'} reviewed`
  if (!scope.sequence) return own
  return `${own} · ${scope.sequence} sequence ${scope.sequence === 1 ? 'message' : 'messages'} skipped`
}
